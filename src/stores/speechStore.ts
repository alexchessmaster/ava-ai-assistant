import { create } from "zustand";
import { splitForSpeech, toSpeechText } from "../utils/speechText";
import { readSpeechSpeed } from "../utils/speechSpeed";
import { initKokoro, pauseKokoro, resumeKokoro, startKokoro, stopKokoro } from "./kokoroSpeech";

/**
 * The one thing that speaks.
 *
 * Read-aloud buttons live in three places (the chat's messages and the assistant
 * panel's footer) and a reply can be played from any of them. Giving each button
 * its own engine instance means starting a second one cancels the first while
 * the first button still shows a stop icon for audio that already ended, so the
 * shared state lives here.
 *
 * Speech is produced locally either way, and which engine is used is not a
 * preference — it is what the platform can actually do:
 *
 * - macOS and Windows use Chromium's `speechSynthesis`, which routes to the
 *   native voices.
 * - Linux cannot: Electron ships with no speech-dispatcher linked, so
 *   `getVoices()` comes back empty and no utterance ever plays. There the main
 *   process drives `spd-say` instead, which is the same engine the desktop uses
 *   for accessibility. See `src/helpers/systemSpeech.js`.
 */
interface SpeechState {
  /**
   * The exact text being read, so a button can tell whether it is the one
   * speaking. Null when nothing is playing.
   */
  speakingText: string | null;
  /** False when the platform offers no way to speak at all. */
  available: boolean;
  /** True while a paused passage is waiting to be resumed. */
  paused: boolean;
  /**
   * False when the engine currently speaking cannot pause. Only `spd-say` on
   * Linux is in that position, and the control should say "Stop" there rather
   * than offer a pause that silently does nothing.
   */
  pausable: boolean;
  speak: (text: string, options?: { codePlaceholder?: string }) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

/**
 * Which engine took the job, so pause and resume can be routed back to the one
 * that is actually speaking. Null when nothing is.
 */
type SpeechBackend = "kokoro" | "web" | "system" | null;
let activeBackend: SpeechBackend = null;

/**
 * How long a reading may go without advancing before it is treated as stuck.
 *
 * Measured from the last *progress*, never from the start: reading a long
 * document aloud for twenty minutes is this feature working, and a wall-clock
 * cap would cut it off mid-sentence — a guard rail that fires on legitimate use
 * is just another bug. What it is for is the other shape, a reading that stops
 * advancing: on the system backend that is a child process nobody is waiting on,
 * and on the others a "playing" state that never clears and an audio pipeline
 * held open for the rest of the session.
 *
 * The system backend is deliberately not covered here — it has no progress to
 * report, only its own completion, so the per-child deadline in `systemSpeech.js`
 * is what bounds it. That one is proportional to the utterance instead of flat,
 * which is the only honest way to bound something that legitimately runs for
 * minutes.
 */
const STALL_TIMEOUT_MS = 10 * 60 * 1000;

let stallTimer: ReturnType<typeof setTimeout> | null = null;

/** Rearms the watchdog; call whenever the reading advances. */
function noteProgress() {
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    stallTimer = null;
    // Nothing has advanced in ten minutes, so nothing is coming: kill whatever
    // the backend is holding and let the button fall back to "Read aloud".
    useSpeechStore.getState().stop();
    useSpeechStore.setState({ speakingText: null, paused: false });
    console.warn("[speech] reading stalled with no progress; stopped it");
  }, STALL_TIMEOUT_MS);
}

/** Stops the watchdog — the reading ended, was stopped, or was paused. */
function clearStallWatchdog() {
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = null;
}

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  return window.speechSynthesis;
}

function hasWebVoices(): boolean {
  return (synth()?.getVoices().length ?? 0) > 0;
}

const bridge = () => (typeof window === "undefined" ? undefined : window.electronAPI);

export const useSpeechStore = create<SpeechState>()((set, get) => ({
  speakingText: null,
  available: false,
  paused: false,
  pausable: false,

  speak: (text, options) => {
    // Every caller gets the same pass — a note the user selected is as full of
    // markdown as a reply is, and reads just as badly without the cleanup — and
    // what happens to a code block is decided by the text, not by who asked:
    // see `SOLO_FENCE`. Chunking below applies either way.
    const spoken = toSpeechText(text, { codePlaceholder: options?.codePlaceholder });
    if (!spoken) return;
    // Only one reply is ever read; starting another cancels the one playing.
    get().stop();

    // A downloaded Kokoro model is preferred over the platform voices: it
    // sounds the same on every machine, and on Linux it is the only good
    // option. Returns false when it cannot take the job — not installed, or no
    // bridge — and the platform code below then runs exactly as before. A
    // failure on the first chunk falls back here too, with Kokoro marked
    // unusable, so the retry lands on the platform voices instead of looping.
    if (
      startKokoro(spoken, {
        // Each chunk that plays is progress; the watchdog is what notices when
        // they stop coming.
        onProgress: noteProgress,
        onDone: () => {
          clearStallWatchdog();
          activeBackend = null;
          if (get().speakingText === text) set({ speakingText: null, paused: false });
        },
        onFallback: () => {
          clearStallWatchdog();
          activeBackend = null;
          if (get().speakingText === text) set({ speakingText: null, paused: false });
          get().speak(text, options);
        },
      })
    ) {
      activeBackend = "kokoro";
      set({ speakingText: text, paused: false, pausable: true });
      noteProgress();
      return;
    }

    if (hasWebVoices()) {
      const engine = synth();
      if (!engine) return;
      // Pausing mid-utterance is native here; `resume()` picks it back up.
      activeBackend = "web";
      set({ speakingText: text, paused: false, pausable: true });

      const chunks = splitForSpeech(spoken);
      chunks.forEach((chunk, index) => {
        const utterance = new SpeechSynthesisUtterance(chunk);
        utterance.rate = readSpeechSpeed();
        // Every chunk is progress, and only the last one is also the end:
        // without the first half of that, a queue that stalls half way through
        // reads as a reading that is still going.
        utterance.onend = () => {
          if (index === chunks.length - 1) {
            // Cancelling fires neither handler, so stop() clears the state itself.
            clearStallWatchdog();
            if (get().speakingText === text) set({ speakingText: null });
            return;
          }
          noteProgress();
        };
        utterance.onerror = () => {
          clearStallWatchdog();
          if (get().speakingText === text) set({ speakingText: null });
        };
        engine.speak(utterance);
      });
      noteProgress();
      return;
    }

    const speakSystem = bridge()?.systemSpeechSpeak;
    if (!speakSystem) return;

    // `pausable: false` is honest signalling rather than a limitation being
    // hidden: speech-dispatcher's CLI has no pause (only `-S` stop and `-C`
    // cancel), so the control offers Stop instead of a pause that would do
    // nothing.
    activeBackend = "system";
    set({ speakingText: text, paused: false, pausable: false });
    void speakSystem(spoken, { rate: readSpeechSpeed() })
      .then((accepted) => {
        if (!accepted && get().speakingText === text) set({ speakingText: null });
      })
      .catch(() => {
        if (get().speakingText === text) set({ speakingText: null });
      });
  },

  /**
   * Holds the audio where it is, keeping the position so `resume()` can carry
   * on mid-sentence rather than from the start of the chunk.
   */
  pause: () => {
    if (get().paused || !get().speakingText) return;

    if (activeBackend === "kokoro") {
      // False means nothing was actually playing — between chunks, say — so
      // there is no position to hold and the state must not claim otherwise.
      if (pauseKokoro()) {
        // A paused reading is not a stalled one, and pause tears the pipeline
        // down, so nothing is running to keep an eye on.
        clearStallWatchdog();
        set({ paused: true });
      }
      return;
    }
    if (activeBackend === "web") {
      synth()?.pause();
      clearStallWatchdog();
      set({ paused: true });
    }
    // The system backend has nothing to pause with, and `pausable` is false
    // there, so the UI never offers this.
  },

  resume: () => {
    if (!get().paused) return;

    if (activeBackend === "kokoro") {
      // A resume that cannot start leaves the passage paused rather than
      // silently clearing the state.
      if (resumeKokoro()) {
        set({ paused: false });
        noteProgress();
      }
      return;
    }
    if (activeBackend === "web") {
      synth()?.resume();
      set({ paused: false });
      noteProgress();
    }
  },

  stop: () => {
    clearStallWatchdog();
    synth()?.cancel();
    void bridge()?.systemSpeechStop?.();
    stopKokoro();
    activeBackend = null;
    set({ speakingText: null, paused: false });
  },
}));

function markAvailable(available: boolean) {
  useSpeechStore.setState({ available });
}

if (typeof window !== "undefined") {
  // Chromium's voices load asynchronously, so probing once at import is not
  // enough — it announces the list with voiceschanged.
  const engine = synth();
  if (engine) {
    // Only ever raises the flag. On Linux `voiceschanged` fires with an empty
    // list, so letting it write `false` would disable the button again after
    // the platform engine had already reported itself ready.
    const probeWebVoices = () => {
      if (engine.getVoices().length > 0) markAvailable(true);
    };
    probeWebVoices();
    engine.addEventListener("voiceschanged", probeWebVoices);
  }

  // Linux has no web voices to wait for, so the platform engine decides.
  const bridgeApi = bridge();
  void bridgeApi?.systemSpeechStatus?.().then((status) => {
    if (status?.available) markAvailable(true);
  });

  // A downloaded Kokoro model is a voice as well, and the best one on offer —
  // it can make the button available on a machine whose OS voices are missing
  // entirely.
  void initKokoro().then((kokoroReady) => {
    if (kokoroReady) markAvailable(true);
  });

  // The system engine's child exits when the utterance finishes; that is the
  // only completion signal the CLI offers.
  bridgeApi?.onSystemSpeechEnded?.(() =>
    useSpeechStore.setState({ speakingText: null, paused: false })
  );

  window.addEventListener("beforeunload", () => {
    synth()?.cancel();
    void bridge()?.systemSpeechStop?.();
    stopKokoro();
  });
}
