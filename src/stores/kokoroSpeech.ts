/**
 * The local Kokoro backend for read-aloud.
 *
 * `speechStore.ts` owns "what is being spoken" and the button state; this owns
 * everything about speaking through Kokoro. Splitting it that way keeps the
 * change to `speechStore.ts` to a few lines — this fork deliberately keeps its
 * edits to upstream files small — and keeps the chunk pipeline in one file.
 *
 * Why chunks rather than one request for the whole reply: the engine reloads
 * its model on every run (~0.7-1.4 s) and then synthesizes at roughly 6x
 * realtime. Feeding it one chunk at a time — a chunk being a few sentences,
 * ~4-12 s of speech — means the first audio arrives in about a second and each
 * following chunk renders while the previous one plays, so playback never
 * catches up to synthesis. One request for a whole reply would be simpler but
 * would leave the user in silence until the entire reply was rendered.
 *
 * Audio decoding uses Web Audio rather than an <audio> element because it gives
 * a precise stop: a source node can be stopped mid-buffer, which is what makes
 * the button's stop immediate instead of waiting for the sentence to finish.
 */

import { splitForSpeech } from "../utils/speechText";

/**
 * Storage keys are shared with the settings UI through this module so the two
 * cannot drift onto different keys and silently ignore each other's writes.
 */
export const KOKORO_MODEL_KEY = "kokoroModel";
export const KOKORO_VOICE_KEY = "kokoroVoice";

export interface KokoroVoice {
  id: number;
  name: string;
  label: string;
}

export interface KokoroModelSummary {
  id: string;
  name: string;
  description: string;
  sizeMb: number;
  license: string;
  recommended: boolean;
  downloaded: boolean;
  diskBytes: number;
  isDownloading: boolean;
}

/**
 * The preload methods this feature adds. Typed here rather than in
 * `src/types/electron.ts` so that upstream file stays untouched; the cast is
 * confined to this one accessor, which the settings UI shares.
 */
export interface KokoroBridge {
  kokoroStatus?: () => Promise<{
    success: boolean;
    /** False on Windows, where the engine cannot be installed yet. */
    supported: boolean;
    engineInstalled: boolean;
    engineVersion: string;
    models: KokoroModelSummary[];
    downloading: boolean;
  }>;
  kokoroInstall?: (modelId: string) => Promise<{ success: boolean; error?: string; code?: string }>;
  kokoroCancelDownload?: (modelId?: string) => Promise<{ success: boolean; code?: string }>;
  kokoroDeleteModel?: (modelId: string) => Promise<{ success: boolean }>;
  kokoroVoices?: (modelId: string) => Promise<{ success: boolean; voices: KokoroVoice[] }>;
  kokoroSynthesize?: (payload: {
    modelId: string;
    text: string;
    voiceId: number;
  }) => Promise<{ success: boolean; audio?: Uint8Array; code?: string; error?: string }>;
  kokoroStop?: () => Promise<{ success: boolean }>;
  onKokoroDownloadProgress?: (callback: (progress: KokoroDownloadProgress) => void) => () => void;
}

export interface KokoroDownloadProgress {
  model: string;
  /** "engine" covers the ~35 MB engine fetch that precedes the model itself. */
  type: "engine" | "progress" | "installing" | "complete" | "error";
  phase?: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
}

function bridge(): KokoroBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.electronAPI as unknown as KokoroBridge | undefined;
}

/** The typed bridge, for the settings UI that drives installs and the picker. */
export function kokoroBridge(): KokoroBridge | undefined {
  return bridge();
}

let installedModels: KokoroModelSummary[] = [];
let engineInstalled = false;
let ready = false;
let initialized = false;

/**
 * Reads whether a usable model is on disk. Called once when `speechStore`
 * mounts, mirroring how the Linux `spd-say` backend announces its availability
 * — the read-aloud button must know whether to disable itself.
 */
export async function initKokoro(): Promise<boolean> {
  if (initialized) return ready;
  initialized = true;

  const api = bridge();
  if (!api?.kokoroStatus) return false;

  try {
    const status = await api.kokoroStatus();
    engineInstalled = Boolean(status?.engineInstalled);
    installedModels = status?.models ?? [];
    ready = engineInstalled && installedModels.some((model) => model.downloaded);
  } catch {
    ready = false;
  }

  return ready;
}

export function isKokoroReady(): boolean {
  return ready;
}

export function getInstalledModels(): KokoroModelSummary[] {
  return installedModels;
}

/** Lets the settings UI tell this module a model was installed or removed. */
export function refreshKokoroState(): Promise<boolean> {
  initialized = false;
  ready = false;
  return initKokoro();
}

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The model to speak with: the user's choice when it is still installed,
 * otherwise the first installed model. Falling back keeps read-aloud working
 * after someone deletes the bundle they had picked.
 */
function resolveModelId(): string | null {
  const preferred = readPreference(KOKORO_MODEL_KEY);
  const usable = installedModels.filter((model) => model.downloaded);
  if (preferred && usable.some((model) => model.id === preferred)) return preferred;
  return usable[0]?.id ?? null;
}

function resolveVoiceId(): number {
  const raw = readPreference(KOKORO_VOICE_KEY);
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

// --- playback ---------------------------------------------------------------

let context: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
// Bumped on every start and every stop. A pipeline step whose token is stale
// abandons what it was doing, which is how a stop cancels work already in
// flight without every step needing its own cancellation plumbing.
let token = 0;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context || context.state === "closed") context = new Ctor();
  return context;
}

function stopPlayback() {
  const node = source;
  source = null;
  if (node) {
    try {
      node.stop();
    } catch {
      // Already ended.
    }
  }
}

/**
 * Plays one decoded buffer and resolves when it finishes. Resolves rather than
 * rejects on stop, because a stop is a normal outcome here — the token check
 * after it is what ends the pipeline.
 */
async function playBuffer(bytes: Uint8Array, current: number): Promise<void> {
  const ctx = audioContext();
  if (!ctx) return;

  // A click on the read-aloud button is a user gesture, so this succeeds; the
  // guard covers a context left suspended by an earlier interrupted run.
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      // Fall through: decodeAudioData still works on a suspended context.
    }
  }

  // Copy into a standalone ArrayBuffer: the IPC payload may be a view onto a
  // larger buffer, and decodeAudioData takes ownership of what it is given.
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;

  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    return;
  }
  if (current !== token) return;

  await new Promise<void>((resolve) => {
    const node = ctx.createBufferSource();
    node.buffer = decoded;
    node.connect(ctx.destination);
    node.onended = () => {
      if (source === node) source = null;
      resolve();
    };
    source = node;
    node.start();
  });
}

// --- the pipeline -----------------------------------------------------------

interface StartOptions {
  /**
   * Called when the pipeline finished normally or was stopped. The caller uses
   * it to clear the button's state.
   */
  onDone: () => void;
  /**
   * Called when the very first chunk failed for a reason other than a stop, so
   * the caller can fall back to the OS voices instead of leaving silence.
   */
  onFallback: () => void;
}

/**
 * Starts speaking, returning false if Kokoro cannot take the job — not
 * installed, no bridge — in which case the caller runs its existing backends.
 */
export function startKokoro(spokenText: string, options: StartOptions): boolean {
  if (!ready || !spokenText) return false;

  const api = bridge();
  if (!api?.kokoroSynthesize) return false;

  const modelId = resolveModelId();
  if (!modelId) return false;

  const voiceId = resolveVoiceId();
  const chunks = splitForSpeech(spokenText);
  if (!chunks.length) return false;

  const current = ++token;
  let playedAnything = false;

  void (async () => {
    for (let index = 0; index < chunks.length; index += 1) {
      if (current !== token) return;

      let result;
      try {
        result = await api.kokoroSynthesize({ modelId, text: chunks[index], voiceId });
      } catch {
        result = { success: false, code: "KOKORO_IPC_FAILED" };
      }

      if (current !== token) return;

      if (!result?.success || !result.audio) {
        // A stop that arrived mid-flight is not a failure.
        if (result?.code === "KOKORO_CANCELLED") return;

        // Nothing has been heard yet, so the honest recovery is the platform
        // voices rather than silence. Kokoro is marked unusable first: the
        // caller retries through the normal path, and that retry must not pick
        // Kokoro again or it would loop.
        if (!playedAnything) {
          ready = false;
          options.onFallback();
          return;
        }
        break;
      }

      playedAnything = true;
      await playBuffer(result.audio, current);
    }

    if (current !== token) return;
    options.onDone();
  })();

  return true;
}

export function stopKokoro() {
  // Invalidates the pipeline before anything else, so a synthesis result that
  // arrives after this point is discarded rather than played.
  token += 1;
  stopPlayback();
  void bridge()?.kokoroStop?.();
}

export function isEngineInstalled(): boolean {
  return engineInstalled;
}
