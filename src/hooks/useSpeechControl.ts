import { useSpeechStore } from "../stores/speechStore";

export interface SpeechControl {
  /** This particular text is the one being read. */
  speaking: boolean;
  /** False when the OS exposes no voices; the button should be disabled. */
  available: boolean;
  label: string;
  toggle: () => void;
  stop: () => void;
}

/**
 * Wires one read-aloud button to the shared speech store: the labels, the code
 * placeholder the engine should say instead of reading a code block, and the
 * play/stop toggle. Both the chat messages and the assistant panel's footer use
 * this, so the wording lives in one place.
 *
 * The strings are plain English rather than i18n keys on purpose: this project
 * checks that every `t()` key resolves in `en`, and every `en` key exists in 11
 * other locales, so translating two new buttons would touch thirteen upstream
 * files. Add the keys here when the fork wants translations.
 */
export function useSpeechControl(text: string): SpeechControl {
  const speakingText = useSpeechStore((state) => state.speakingText);
  const available = useSpeechStore((state) => state.available);
  const speak = useSpeechStore((state) => state.speak);
  const stop = useSpeechStore((state) => state.stop);

  // Comparing the text rather than an id keeps the caller from having to mint
  // one; two identical messages would both light up, which is not worth an id.
  const speaking = text.length > 0 && speakingText === text;

  return {
    speaking,
    available,
    label: speaking ? "Stop reading" : "Read aloud",
    toggle: () => {
      if (speaking) {
        stop();
        return;
      }
      speak(text, { codePlaceholder: "code block" });
    },
    stop,
  };
}
