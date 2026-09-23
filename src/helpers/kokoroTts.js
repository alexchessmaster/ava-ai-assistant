/**
 * Drives the sherpa-onnx TTS binary.
 *
 * The binary is one-shot: text in, WAV out, exit. There is no server mode in
 * the release (checked against the archive's binary list), so this is not a
 * long-lived sidecar and deliberately does not register with
 * `sidecarRegistry` / `sidecarPidFile` / `sidecarReaper` — those exist for
 * daemons that hold ports and need orphan cleanup. The model here is the same
 * one `systemSpeech.js` uses for `spd-say`: spawn a child per utterance, keep a
 * handle to the current one, kill it when a new utterance or a stop arrives.
 *
 * Measured on Linux x64 (24 cores, 2026-09), because both numbers shape the
 * design:
 *
 *   - Loading the model costs ~1.4 s, and synthesis then runs at ~0.17 RTF
 *     (about 6x faster than realtime) — 12.7 s of audio in 2.9 s wall.
 *   - Threads matter more than expected and the naive answer is wrong: 4
 *     threads took 3.60 s, 8 took 2.88 s, and 24 took 4.06 s for the same
 *     passage. A model this small thrashes when oversubscribed, hence the cap
 *     in `kokoroModels.KOKORO_MAX_THREADS`.
 *
 * The ~1.4 s load is why the renderer feeds this one chunk at a time rather
 * than a sentence at a time: a chunk is a few sentences (~12 s of audio), so
 * one spawn costs ~3.4 s to produce ~12 s of speech and playback stays ahead of
 * synthesis. Per-sentence spawns would pay the load cost every sentence and
 * fall behind.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const debugLogger = require("./debugLogger");
const { getSafeTempDir } = require("./safeTempDir");
const { getCacheRoot } = require("./modelDirUtils");
const { getAvailableParallelism } = require("../utils/serverUtils");
const engine = require("./kokoroEngine");
const {
  KOKORO_MAX_THREADS,
  getKokoroModelConfig,
  getKokoroModelIds,
  getRequiredModelFiles,
  parseSpeakerNames,
} = require("./kokoroModels");

const SYNTHESIS_TIMEOUT_MS = 120000;
const VOICE_PROBE_TEXT = "Hi.";

function getModelsDir() {
  return path.join(getCacheRoot(), "kokoro-models");
}

function getModelDir(modelId) {
  return path.join(getModelsDir(), modelId);
}

/**
 * Installed means every required file is present. A directory that exists but
 * is half-extracted would otherwise pass and fail at speak time, which is the
 * worst moment to discover it.
 */
function isModelInstalled(modelId) {
  if (!getKokoroModelConfig(modelId)) return false;

  const modelDir = getModelDir(modelId);
  const { files, dirs } = getRequiredModelFiles();

  for (const file of files) {
    if (!fs.existsSync(path.join(modelDir, file))) return false;
  }
  for (const dir of dirs) {
    try {
      if (!fs.statSync(path.join(modelDir, dir)).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function listInstalledModels() {
  return getKokoroModelIds().filter((modelId) => isModelInstalled(modelId));
}

function resolveNumThreads() {
  return Math.max(1, Math.min(KOKORO_MAX_THREADS, getAvailableParallelism()));
}

/**
 * The flag set differs by bundle generation: v0.19 predates `--kokoro-lang` and
 * is driven purely by espeak-ng data, while v1.0 and later refuse to start
 * without either a language or a lexicon. Both are declared in the model
 * registry rather than branched on here.
 */
function buildModelArgs(modelId, modelDir) {
  const config = getKokoroModelConfig(modelId);
  if (!config) throw new Error(`Unknown Kokoro model: ${modelId}`);

  const args = [
    `--kokoro-model=${path.join(modelDir, "model.onnx")}`,
    `--kokoro-voices=${path.join(modelDir, "voices.bin")}`,
    `--kokoro-tokens=${path.join(modelDir, "tokens.txt")}`,
    `--kokoro-data-dir=${path.join(modelDir, "espeak-ng-data")}`,
    `--num-threads=${resolveNumThreads()}`,
    "--provider=cpu",
  ];

  if (config.ttsArgs?.lang) args.push(`--kokoro-lang=${config.ttsArgs.lang}`);

  const lexicon = config.ttsArgs?.lexicon;
  if (lexicon) {
    args.push(`--kokoro-lexicon=${lexicon.map((name) => path.join(modelDir, name)).join(",")}`);
  }

  return args;
}

let outputCounter = 0;

function newOutputPath() {
  outputCounter += 1;
  return path.join(
    getSafeTempDir(),
    `openwhispr-kokoro-${process.pid}-${Date.now()}-${outputCounter}.wav`
  );
}

/**
 * Removes WAVs left behind by a crash or a hard stop. Bounded by age so it can
 * never delete a file another process is still writing.
 */
function cleanupStaleOutputs({ maxAgeMs = 60 * 60 * 1000 } = {}) {
  const dir = getSafeTempDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith("openwhispr-kokoro-") || !entry.endsWith(".wav")) continue;
    const full = path.join(dir, entry);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { force: true });
    } catch {
      // Already gone, or not ours to remove.
    }
  }
}

/**
 * Runs the engine and resolves with the WAV path.
 *
 * Rejects on a missing engine or model rather than returning a falsy value, so
 * a caller cannot mistake "not installed" for "nothing to say" — the renderer
 * uses the error code to decide whether to fall back to the OS voices.
 */
async function synthesize({ modelId, text, voiceId = 0 }) {
  if (!text) throw Object.assign(new Error("Nothing to speak"), { code: "KOKORO_EMPTY_TEXT" });
  if (!engine.isEngineInstalled()) {
    throw Object.assign(new Error("Kokoro engine is not installed"), {
      code: "KOKORO_ENGINE_MISSING",
    });
  }
  if (!isModelInstalled(modelId)) {
    throw Object.assign(new Error(`Kokoro model ${modelId} is not installed`), {
      code: "KOKORO_MODEL_MISSING",
    });
  }

  const outputPath = newOutputPath();
  const args = [
    ...buildModelArgs(modelId, getModelDir(modelId)),
    `--sid=${Number.isInteger(voiceId) ? voiceId : 0}`,
    `--output-filename=${outputPath}`,
    text,
  ];

  // A stop that landed between utterances must not cancel this one.
  stopRequested = false;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(engine.getBinaryPath(), args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(Object.assign(new Error(error.message), { code: "KOKORO_SPAWN_FAILED" }));
      return;
    }

    // Tracked so a stop can cancel synthesis already in flight — otherwise a
    // cancelled long chunk would keep a core busy until it finished, and the
    // renderer would have moved on to OS voices or nothing at all.
    current = child;

    const releaseCurrent = () => {
      if (current === child) current = null;
    };

    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      fs.rmSync(outputPath, { force: true });
      reject(Object.assign(new Error("Kokoro synthesis timed out"), { code: "KOKORO_TIMEOUT" }));
    }, SYNTHESIS_TIMEOUT_MS);

    child.stderr?.on("data", (chunk) => {
      // Bounded: the engine is chatty and a long reply could otherwise buffer
      // megabytes of progress lines for an error we may never report.
      if (stderr.length < 8192) stderr += chunk.toString();
    });

    child.on("error", (error) => {
      releaseCurrent();
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fs.rmSync(outputPath, { force: true });
      reject(Object.assign(new Error(error.message), { code: "KOKORO_SPAWN_FAILED" }));
    });

    child.on("close", (code) => {
      // Before the settled guard: a stop() kills the child, and this is what
      // clears the handle even when the promise was already rejected.
      releaseCurrent();
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        fs.rmSync(outputPath, { force: true });
        // A kill is how stop() cancels, and that is not a failure — the
        // renderer treats it as "the user moved on" and stays quiet.
        if (stopRequested) {
          reject(
            Object.assign(new Error("Kokoro synthesis cancelled"), { code: "KOKORO_CANCELLED" })
          );
          return;
        }
        debugLogger.warn("Kokoro synthesis failed", { code, stderr: stderr.slice(-500) });
        reject(
          Object.assign(new Error(`Kokoro exited with code ${code}`), {
            code: "KOKORO_SYNTHESIS_FAILED",
            detail: stderr.slice(-500),
          })
        );
        return;
      }

      let size = 0;
      try {
        size = fs.statSync(outputPath).size;
      } catch {}
      if (!size) {
        reject(
          Object.assign(new Error("Kokoro produced no audio"), { code: "KOKORO_EMPTY_OUTPUT" })
        );
        return;
      }

      resolve({ wavPath: outputPath, bytes: size });
    });
  });
}

// Voice enumeration is a model load plus a trivial synthesis (~1.5 s), so the
// answer is cached for the life of the process. The list cannot change while a
// model is installed.
const voiceCache = new Map();

/**
 * Asks the engine to describe its own speaker table.
 *
 * The bundles ship no voice list — `voices.bin` is a matrix of embeddings and
 * the names live inside the binary — so `--debug=true` is the only way to
 * enumerate voices without hardcoding a table that would be wrong for the next
 * bundle. The engine prints `speaker_names=af,af_bella,...` while loading.
 * Cached, so this costs one extra spawn per model per run.
 */
async function listVoices(modelId) {
  if (voiceCache.has(modelId)) return voiceCache.get(modelId);
  if (!engine.isEngineInstalled() || !isModelInstalled(modelId)) return [];

  const outputPath = newOutputPath();
  const args = [
    "--debug=true",
    ...buildModelArgs(modelId, getModelDir(modelId)),
    `--output-filename=${outputPath}`,
    VOICE_PROBE_TEXT,
  ];

  const voices = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(engine.getBinaryPath(), args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve([]);
      return;
    }

    let output = "";
    const collect = (chunk) => {
      if (output.length < 65536) output += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, SYNTHESIS_TIMEOUT_MS);

    child.on("error", () => {
      clearTimeout(timeout);
      resolve([]);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      fs.rmSync(outputPath, { force: true });
      resolve(parseSpeakerNames(output));
    });
  });

  if (voices.length) voiceCache.set(modelId, voices);
  return voices;
}

/** Drops cached voices for a model whose files just changed or went away. */
function forgetVoices(modelId) {
  if (modelId) voiceCache.delete(modelId);
  else voiceCache.clear();
}

// The child currently synthesizing, so a stop can cancel work in flight.
let current = null;
// Distinguishes "the user stopped reading" from "synthesis broke", which the
// renderer reports very differently.
let stopRequested = false;

function finishCurrent() {
  const child = current;
  current = null;
  if (child && !child.killed) {
    stopRequested = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function stop() {
  finishCurrent();
}

module.exports = {
  getModelsDir,
  getModelDir,
  isModelInstalled,
  listInstalledModels,
  synthesize,
  listVoices,
  forgetVoices,
  stop,
  resolveNumThreads,
  cleanupStaleOutputs,
};
