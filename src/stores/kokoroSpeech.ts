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
import { readSpeechSpeed } from "../utils/speechSpeed";

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
    /** Applied by the engine at synthesis, so the pitch is not shifted. */
    speed?: number;
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
  // Nothing is playing once this returns. A pause reads `playing` before
  // calling in here, so clearing it here cannot lose the position.
  playing = null;
  if (node) {
    try {
      node.stop();
    } catch {
      // Already ended.
    }
  }
}

/**
 * What a pause has to remember in order to resume: the chunk list, which chunk
 * it stopped in, how far into that chunk the audio reached, and the voice it was
 * being read in.
 */
interface ResumePoint {
  chunks: string[];
  index: number;
  /** Seconds into chunks[index]. */
  offset: number;
  modelId: string;
  voiceId: number;
  options: StartOptions;
}

let resumePoint: ResumePoint | null = null;

/**
 * The chunk being played right now. Web Audio offers no way to pause a buffer
 * source — only to stop one — so the position is reconstructed from the audio
 * clock, and this is what a pause reads to work out where it got to.
 */
let playing: {
  chunks: string[];
  index: number;
  modelId: string;
  voiceId: number;
  options: StartOptions;
  startedAt: number;
  startOffset: number;
} | null = null;

/**
 * Plays one decoded buffer from `startOffset` and resolves when it finishes.
 * Resolves rather than rejects on stop, because a stop is a normal outcome here
 * — the token check after it is what ends the pipeline.
 */
async function playBuffer(
  bytes: Uint8Array,
  current: number,
  descriptor: Omit<ResumePoint, "offset">,
  startOffset: number
): Promise<void> {
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
      // A stop nulls `source` first, so a node still in `source` here ended on
      // its own — and nothing is playing any more, which is what keeps a pause
      // landing between chunks from resuming at the end of the one just gone.
      if (source === node) {
        source = null;
        playing = null;
      }
      resolve();
    };
    source = node;
    // A resume re-enters part-way through the chunk it was paused in. The
    // ceiling keeps `start` from being handed an offset at or past the end of
    // the buffer, which throws.
    const offset = Math.min(Math.max(0, startOffset), Math.max(0, decoded.duration - 0.02));
    playing = { ...descriptor, startedAt: ctx.currentTime, startOffset: offset };
    node.start(0, offset);
  });
}

// --- the pipeline -----------------------------------------------------------

interface StartOptions {
  /**
   * Called as each chunk reaches the speakers, so the caller can tell a reading
   * that is getting on with it from one that has quietly stopped. Without it a
   * pipeline that dies mid-passage looks exactly like one that is still going.
   */
  onProgress?: () => void;
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
 * The chunk loop, shared by a fresh start and a resume.
 *
 * `startIndex`/`startOffset` are where to begin, which is how a resume re-enters
 * the chunk it was paused in rather than the one after it; `alreadyPlayed` says
 * whether anything has been heard yet, because only a *fresh* failure gets to
 * fall back to the OS voices — a resume that fails half way through should not
 * restart the passage from the beginning in a different voice.
 */
function runPipeline(
  chunks: string[],
  startIndex: number,
  startOffset: number,
  modelId: string,
  voiceId: number,
  options: StartOptions,
  alreadyPlayed: boolean
): boolean {
  const api = bridge();
  if (!api?.kokoroSynthesize) return false;

  const current = ++token;
  let heard = alreadyPlayed;
  const descriptor = { chunks, index: startIndex, modelId, voiceId, options };

  void (async () => {
    for (let index = startIndex; index < chunks.length; index += 1) {
      if (current !== token) return;
      descriptor.index = index;

      let result;
      try {
        // Read per chunk rather than once at the start, so changing the speed
        // while something is being read takes effect on the next chunk instead
        // of needing a stop and a restart.
        result = await api.kokoroSynthesize({
          modelId,
          text: chunks[index],
          voiceId,
          speed: readSpeechSpeed(),
        });
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
        if (!heard) {
          ready = false;
          options.onFallback();
          return;
        }
        break;
      }

      heard = true;
      // Before the chunk plays, not after: a chunk that never finishes playing
      // is exactly the stall the caller is watching for, and reporting progress
      // once the audio was already over would hide it for one build time.
      options.onProgress?.();
      await playBuffer(result.audio, current, descriptor, index === startIndex ? startOffset : 0);
    }

    if (current !== token) return;
    resumePoint = null;
    options.onDone();
  })();

  return true;
}

/**
 * Starts speaking, returning false if Kokoro cannot take the job — not
 * installed, no bridge — in which case the caller runs its existing backends.
 */
export function startKokoro(spokenText: string, options: StartOptions): boolean {
  if (!ready || !spokenText) return false;

  const modelId = resolveModelId();
  if (!modelId) return false;

  const chunks = splitForSpeech(spokenText);
  if (!chunks.length) return false;

  resumePoint = null;
  return runPipeline(chunks, 0, 0, modelId, resolveVoiceId(), options, false);
}

/**
 * Stops the audio where it is and remembers the position, so `resumeKokoro` can
 * pick the passage up mid-chunk. Returns false when there was nothing playing,
 * which is how the caller knows to offer no pause at all.
 */
export function pauseKokoro(): boolean {
  const current = playing;
  if (!current) return false;

  const ctx = context;
  const elapsed =
    current.startOffset + (ctx ? Math.max(0, ctx.currentTime - current.startedAt) : 0);

  resumePoint = {
    chunks: current.chunks,
    index: current.index,
    offset: elapsed,
    modelId: current.modelId,
    voiceId: current.voiceId,
    options: current.options,
  };

  // The same invalidation a stop performs: synthesis already queued for the
  // chunks after this one would otherwise keep a core busy through the pause,
  // and its result would arrive with nothing to play it into.
  token += 1;
  stopPlayback();
  void bridge()?.kokoroStop?.();
  return true;
}

export function resumeKokoro(): boolean {
  const point = resumePoint;
  if (!point || !ready) return false;
  resumePoint = null;
  return runPipeline(
    point.chunks,
    point.index,
    point.offset,
    point.modelId,
    point.voiceId,
    point.options,
    true
  );
}

/** Whether there is a paused passage waiting to be picked back up. */
export function isKokoroPaused(): boolean {
  return resumePoint !== null;
}

export function stopKokoro() {
  // Invalidates the pipeline before anything else, so a synthesis result that
  // arrives after this point is discarded rather than played.
  token += 1;
  // A stop is final: unlike a pause it leaves nothing to resume into.
  resumePoint = null;
  stopPlayback();
  void bridge()?.kokoroStop?.();
}

export function isEngineInstalled(): boolean {
  return engineInstalled;
}
