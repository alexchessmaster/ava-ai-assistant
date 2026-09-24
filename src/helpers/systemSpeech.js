const { execFile, execFileSync, spawn } = require("child_process");
const debugLogger = require("./debugLogger");

// Text-to-speech through the desktop's own speech engine, for the platforms
// where Chromium's `speechSynthesis` can't do it.
//
// On Linux it can't, at all: Electron's binary links no speech-dispatcher
// (verified with `ldd` on the shipped Electron — there is no libspeechd), so
// `getVoices()` returns an empty list, no utterance ever plays, and
// `--enable-speech-dispatcher` has nothing to talk to. macOS and Windows are
// unaffected — their speech synthesis is native to the platform — so they keep
// using the Web Speech API and never reach this module.
//
// speech-dispatcher's own CLI is the engine the desktop already uses for
// accessibility, and every desktop distro that has a speech stack ships it.
const BINARY = "spd-say";

// Resolved once: probing spawns a process, and the answer cannot change while
// the app is running.
let available = null;

function isAvailable() {
  if (process.platform !== "linux") return false;
  if (available !== null) return available;
  try {
    // Listing output modules is the cheapest proof the daemon is actually
    // answering, rather than the binary merely being installed.
    execFileSync(BINARY, ["--list-output-modules"], { timeout: 2000, stdio: "ignore" });
    available = true;
  } catch {
    available = false;
    debugLogger.debug("System speech unavailable", {}, "speech");
  }
  return available;
}

// The child currently speaking, so a new utterance or a stop can cancel it.
let current = null;

function finishCurrent() {
  const child = current;
  current = null;
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      // Already gone; nothing to cancel.
    }
  }
}

/**
 * `spd-say -r` is a signed percentage away from the daemon's own normal rate,
 * not a multiplier: 1.2x is `-r 20`, and 1x is no flag at all. Values outside
 * this range are rejected here rather than handed to the daemon, which accepts
 * anything in -100..100 silently, however useless it sounds.
 */
function buildRateArgs(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value === 1) return [];
  const percent = Math.round((value - 1) * 100);
  if (percent < -100 || percent > 100) return [];
  return ["-r", String(percent)];
}

/**
 * Speaks `text` through speech-dispatcher. `-w` makes the child exit when the
 * utterance finishes, which is the only completion signal the CLI offers — the
 * caller uses it to clear the button's "speaking" state.
 *
 * Returns whether the utterance was accepted, so the UI can stay honest if the
 * daemon refuses.
 */
function speak(text, { onEnded, rate } = {}) {
  if (!isAvailable() || !text) return false;

  // Only one utterance at a time, matching the renderer's own model.
  finishCurrent();

  try {
    const child = spawn(BINARY, ["-w", ...buildRateArgs(rate), text], {
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    current = child;

    const done = () => {
      if (current === child) current = null;
      onEnded?.();
    };
    child.on("close", done);
    child.on("error", (error) => {
      debugLogger.warn("System speech failed", { error: error.message }, "speech");
      done();
    });
    child.unref();
    return true;
  } catch (error) {
    debugLogger.warn("System speech could not start", { error: error.message }, "speech");
    return false;
  }
}

/**
 * Stops playback. Killing the child is what reports completion back to the
 * renderer; `spd-say -S` additionally clears the daemon's queue, which is the
 * only handle the CLI exposes — it is daemon-wide, so speech from another app
 * at that exact moment is cut off too. In practice nothing else is speaking.
 */
function stop() {
  if (!isAvailable()) return;
  finishCurrent();
  try {
    execFile(BINARY, ["-S"], () => {});
  } catch {
    // The daemon went away; the child kill above already silenced us.
  }
}

module.exports = { isAvailable, speak, stop };
