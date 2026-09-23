import { create } from "zustand";
import { splitForSpeech, toSpeechText } from "../utils/speechText";

/**
 * The one thing that speaks.
 *
 * Read-aloud buttons live in three places (the Control Panel chat's messages
 * and the assistant panel's footer) and a reply can be played from any of them.
 * Giving each button its own engine instance means starting a second one
 * cancels the first at the engine level while the first button still shows a
 * stop icon for audio that already ended — so the shared state lives here.
 *
 * Only the built-in engine is wired up: Chromium's `speechSynthesis`, which
 * routes to the OS voices (speech-dispatcher/espeak-ng on Linux, the native
 * ones on macOS and Windows). Nothing is downloaded and nothing leaves the
 * machine.
 */
interface SpeechState {
  /**
   * The exact text being read, so a button can tell whether it is the one
   * speaking. Null when nothing is playing.
   */
  speakingText: string | null;
  /** False when the OS exposes no voices, e.g. Linux without speech-dispatcher. */
  available: boolean;
  speak: (text: string, options?: { codePlaceholder?: string }) => void;
  stop: () => void;
}

function engine(): SpeechSynthesis | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  return window.speechSynthesis;
}

export const useSpeechStore = create<SpeechState>()((set, get) => ({
  speakingText: null,
  available: false,

  speak: (text, options) => {
    const synth = engine();
    if (!synth) return;

    const spoken = toSpeechText(text, { codePlaceholder: options?.codePlaceholder });
    const chunks = splitForSpeech(spoken);
    if (chunks.length === 0) return;

    // Only one reply is ever read; starting another cancels the one playing.
    synth.cancel();
    set({ speakingText: text });

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
      synth.speak(utterance);
    });
  },

  stop: () => {
    engine()?.cancel();
    set({ speakingText: null });
  },
}));

// getVoices() is empty until the engine has loaded its voice list, and it
// announces that with voiceschanged. Probing once at import is not enough.
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  const probe = () => {
    useSpeechStore.setState({
      available: window.speechSynthesis.getVoices().length > 0,
    });
  };
  probe();
  window.speechSynthesis.addEventListener("voiceschanged", probe);
  // A cancelled utterance would otherwise keep the cart after the panel closes.
  window.addEventListener("beforeunload", () => window.speechSynthesis.cancel());
}
