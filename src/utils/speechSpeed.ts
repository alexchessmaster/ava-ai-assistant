/**
 * How fast read-aloud speaks — one value, for every engine.
 *
 * The speed lives here rather than next to the Kokoro preferences because it is
 * not a Kokoro setting: the same number drives the local Kokoro model, the
 * Chromium voices and `spd-say` on Linux, and all three read-aloud surfaces
 * (the read-aloud panel and the speaker buttons in the chat and assistant
 * panel) consult this one value.
 *
 * It is stored in localStorage, which Electron keeps inside the app's userData
 * directory, so a chosen speed survives restarts and reboots without any
 * main-process round trip.
 *
 * Where the speed is *applied* is the whole point of this file's companion
 * changes: it is handed to each engine so the engine scales the duration of the
 * speech. Applying it at playback time instead — Web Audio's `playbackRate` —
 * resamples the audio and raises the pitch, which turns a 1.2x passage into a
 * chipmunk. Measured on the bundled engine, `--speed=1.2` shortens the same
 * phrase from 2.51 s to 2.14 s while leaving the waveform's zero-crossing rate
 * unchanged (4252/s to 4119/s; a resample would have scaled it to ~5100/s),
 * which is what "faster but the same voice" means.
 */

export const SPEECH_SPEED_KEY = "speechSpeed";

/**
 * The range is a compromise between the two engine families. Below 0.5 the
 * predictors stretch speech past intelligibility, and Chromium's own `rate`
 * is documented to sound wrong outside roughly this band.
 */
export const SPEECH_SPEED_MIN = 0.5;
export const SPEECH_SPEED_MAX = 2;
export const SPEECH_SPEED_STEP = 0.05;
export const SPEECH_SPEED_DEFAULT = 1;

/**
 * Steps are decimal, so repeated addition accumulates float error
 * (0.05 * 3 === 0.15000000000000002). Everything that leaves this module is
 * rounded back to the two decimals the UI shows.
 */
function roundSpeed(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Clamps to the supported range and snaps to a step, or falls back to 1x. */
export function normalizeSpeechSpeed(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return SPEECH_SPEED_DEFAULT;
  const snapped = Math.round(parsed / SPEECH_SPEED_STEP) * SPEECH_SPEED_STEP;
  return roundSpeed(Math.min(SPEECH_SPEED_MAX, Math.max(SPEECH_SPEED_MIN, snapped)));
}

/**
 * The speed to speak at. Read at speak time rather than captured at startup so
 * a change takes effect without restarting anything.
 */
export function readSpeechSpeed(): number {
  try {
    const raw = window.localStorage.getItem(SPEECH_SPEED_KEY);
    return raw === null ? SPEECH_SPEED_DEFAULT : normalizeSpeechSpeed(raw);
  } catch {
    // A blocked or absent localStorage is not a reason to fail to speak.
    return SPEECH_SPEED_DEFAULT;
  }
}

/** Persists a speed and returns what was actually stored, after clamping. */
export function writeSpeechSpeed(value: number): number {
  const speed = normalizeSpeechSpeed(value);
  try {
    window.localStorage.setItem(SPEECH_SPEED_KEY, String(speed));
  } catch {
    // Non-fatal: the read-aloud still works at the returned value.
  }
  return speed;
}

/** Moves one step and stays inside the range, so the stepper cannot overshoot. */
export function stepSpeechSpeed(current: number, delta: number): number {
  return normalizeSpeechSpeed(current + delta * SPEECH_SPEED_STEP);
}

/** "1.2x" rather than "1.20x" for whole steps, "1.05x" for the fine ones. */
export function formatSpeechSpeed(value: number): string {
  const speed = normalizeSpeechSpeed(value);
  const text = Number.isInteger(speed * 10) ? speed.toFixed(1) : speed.toFixed(2);
  return `${text}x`;
}
