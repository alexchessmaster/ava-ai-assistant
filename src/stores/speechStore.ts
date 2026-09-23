import { create } from "zustand";
import { splitForSpeech, toSpeechText } from "../utils/speechText";
import { initKokoro, startKokoro, stopKokoro } from "./kokoroSpeech";

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
  speak: (text: string, options?: { codePlaceholder?: string }) => void;
  stop: () => void;
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

  speak: (text, options) => {
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
        onDone: () => {
          if (get().speakingText === text) set({ speakingText: null });
        },
        onFallback: () => {
          if (get().speakingText === text) set({ speakingText: null });
          get().speak(text, options);
        },
      })
    ) {
      set({ speakingText: text });
      return;
    }

    if (hasWebVoices()) {
      const engine = synth();
      if (!engine) return;
      set({ speakingText: text });

      const chunks = splitForSpeech(spoken);
      chunks.forEach((chunk, index) => {
        const utterance = new SpeechSynthesisUtterance(chunk);
        if (index === chunks.length - 1) {
          // Cancelling fires neither handler, so stop() clears the state itself.
          const finish = () => {
            if (get().speakingText === text) set({ speakingText: null });
          };
          utterance.onend = finish;
          utterance.onerror = finish;
        }
        engine.speak(utterance);
      });
      return;
    }

    const speakSystem = bridge()?.systemSpeechSpeak;
    if (!speakSystem) return;

    set({ speakingText: text });
    void speakSystem(spoken)
      .then((accepted) => {
        if (!accepted && get().speakingText === text) set({ speakingText: null });
      })
      .catch(() => {
        if (get().speakingText === text) set({ speakingText: null });
      });
  },

  stop: () => {
    synth()?.cancel();
    void bridge()?.systemSpeechStop?.();
    stopKokoro();
    set({ speakingText: null });
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
  bridgeApi?.onSystemSpeechEnded?.(() => useSpeechStore.setState({ speakingText: null }));

  window.addEventListener("beforeunload", () => {
    synth()?.cancel();
    void bridge()?.systemSpeechStop?.();
    stopKokoro();
  });
}
