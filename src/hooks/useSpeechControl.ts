import { useSpeechStore } from "../stores/speechStore";

export interface SpeechControl {
  /** This particular text is the one being read. */
  speaking: boolean;
  /** False when the OS exposes no voices; the button should be disabled. */
  available: boolean;
  /** True while a paused passage is waiting to be carried on. */
  paused: boolean;
  /** False when the engine in use cannot pause — `spd-say` on Linux. */
  pausable: boolean;
  label: string;
  toggle: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

/**
 * Wires one read-aloud button to the shared speech store: the labels and the
 * play/stop toggle. Chat messages, the assistant panel's footer and the
 * read-aloud panel all use this, so the wording lives in one place — and they
 * all hand the store the same text unchanged, since what to do with a code
 * block is decided in `speechText.ts` rather than by the caller.
 *
 * The strings are plain English rather than i18n keys on purpose: this project
 * checks that every `t()` key resolves in `en`, and every `en` key exists in 11
 * other locales, so translating two new buttons would touch thirteen upstream
 * files. Add the keys here when the fork wants translations.
 */
export function useSpeechControl(text: string): SpeechControl {
  const speakingText = useSpeechStore((state) => state.speakingText);
  const available = useSpeechStore((state) => state.available);
  const paused = useSpeechStore((state) => state.paused);
  const pausable = useSpeechStore((state) => state.pausable);
  const speak = useSpeechStore((state) => state.speak);
  const pause = useSpeechStore((state) => state.pause);
  const resume = useSpeechStore((state) => state.resume);
  const stop = useSpeechStore((state) => state.stop);

  // Comparing the text rather than an id keeps the caller from having to mint
  // one; two identical messages would both light up, which is not worth an id.
  const speaking = text.length > 0 && speakingText === text;

  return {
    speaking,
    available,
    paused,
    pausable,
    label: speaking ? "Stop reading" : "Read aloud",
    toggle: () => {
      if (speaking) {
        stop();
        return;
      }
      speak(text);
    },
    pause,
    resume,
    stop,
  };
}
