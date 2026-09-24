import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Minus, Play, Plus, Square, X } from "../icons";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { useSpeechControl } from "../../hooks/useSpeechControl";
import {
  SPEECH_SPEED_DEFAULT,
  SPEECH_SPEED_MAX,
  SPEECH_SPEED_MIN,
  formatSpeechSpeed,
  readSpeechSpeed,
  stepSpeechSpeed,
  writeSpeechSpeed,
} from "../../utils/speechSpeed";

/**
 * The read-aloud panel: paste or select text, hear it in the local voice, and
 * control the playback from one place.
 *
 * The controls are buttons *and* the hotkey, which is why the hook owns the
 * toggle: pressing the hotkey while this is open has to mean the same thing as
 * pressing Play/Pause here, and two independent notions of "is it playing"
 * would drift apart the moment either one changed.
 *
 * Strings are plain English rather than i18n keys, following the fork's rule for
 * its own surfaces — see the note in `KokoroSettings.tsx` and
 * `useSpeechControl.ts`. Add keys here if the fork ever wants translations.
 */

/** The vendored icon set has no pause glyph, and one is two rectangles wide. */
function PauseGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true" focusable="false">
      <rect x="3.4" y="2.6" width="3.2" height="10.8" rx="1.1" fill="currentColor" />
      <rect x="9.4" y="2.6" width="3.2" height="10.8" rx="1.1" fill="currentColor" />
    </svg>
  );
}

interface ReadAloudPanelProps {
  text: string;
  onTextChange: (text: string) => void;
  open: boolean;
  /** Silence the reading, then put the panel away. */
  onClose: () => void;
  /** Put the panel away and keep reading. */
  onMinimize: () => void;
  /** Hide the text box, leaving the controls; or bring it back. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function ReadAloudPanel({
  text,
  onTextChange,
  open,
  onClose,
  onMinimize,
  collapsed,
  onToggleCollapsed,
}: ReadAloudPanelProps) {
  // Verbatim: this is text the user chose to read, not a markdown reply, so the
  // reply cleanup — which drops fenced code blocks outright — would silently
  // change it.
  const speech = useSpeechControl(text, { verbatim: true });
  const [speed, setSpeed] = useState(() => readSpeechSpeed());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const applySpeed = useCallback((next: number) => {
    setSpeed(writeSpeechSpeed(next));
  }, []);

  // The box has to be ready to type into the moment the panel appears, and
  // `autoFocus` cannot do that on its own: React commits the element and calls
  // focus() in the same breath, but the overlay window only becomes focusable
  // once the main process answers `setReadAloudPanelOpen` — and a focus() into
  // a window that is not yet key is silently dropped. So focus again after the
  // open has landed, and again if the window is ever brought forward with
  // nothing else focused.
  useEffect(() => {
    if (!open) return undefined;

    const focusBox = () => {
      const active = document.activeElement;
      // Never steal focus from a control the user deliberately tabbed to.
      if (active && active !== document.body) return;
      textareaRef.current?.focus();
    };

    focusBox();
    const frame = requestAnimationFrame(focusBox);
    window.addEventListener("focus", focusBox);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("focus", focusBox);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Esc is "I am done with this": it silences the reading as well as
      // dismissing the panel. Use the minimise control to put the window away
      // while keeping the audio going.
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const playing = speech.speaking && !speech.paused;
  const canPause = speech.pausable;
  const hasText = text.trim().length > 0;

  const onPrimary = () => {
    if (playing) {
      // The engine in use cannot pause (spd-say on Linux), and the store says so
      // through `pausable`. Offering a Stop here is honest; a Pause would be a
      // button that does nothing.
      if (!canPause) {
        speech.stop();
        return;
      }
      speech.pause();
      return;
    }
    if (speech.paused) {
      speech.resume();
      return;
    }
    if (hasText) speech.toggle();
  };

  let primaryLabel = "Play";
  if (playing) primaryLabel = canPause ? "Pause" : "Stop";
  else if (speech.paused) primaryLabel = "Resume";

  const primaryGlyph = playing ? (
    canPause ? (
      <PauseGlyph />
    ) : (
      <Square className="fill-current" />
    )
  ) : (
    <Play />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
        <span className="text-[13px] font-medium text-foreground">Read aloud</span>
        <div className="flex items-center gap-0.5">
          {/* Collapse keeps the controls on screen — Stop included — so the
              passage is still steerable with the box out of the way. Minimising
              is the harder dismissal for when the panel itself is in the way. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Show the text" : "Hide the text"}
            title={collapsed ? "Show the text" : "Hide the text"}
          >
            {collapsed ? <ChevronUp /> : <ChevronDown />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onMinimize}
            disabled={!speech.speaking && !speech.paused}
            aria-label="Minimize and keep reading"
            title="Minimize and keep reading"
          >
            <Minus />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onClose}
            aria-label="Close and stop reading"
            title="Close and stop reading"
          >
            <X />
          </Button>
        </div>
      </header>

      <main className={collapsed ? "hidden" : "min-h-0 flex-1 px-3"}>
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder="Paste or type the text to read aloud…"
          aria-label="Text to read aloud"
          spellCheck={false}
          // The Textarea primitive is styled for the light control panel:
          // `bg-white` with hardcoded `text-neutral-900`. In this overlay
          // `surface-0` is themed, so on dark it paints a dark background —
          // leaving neutral-900 text unreadable on top of it. The colour and
          // border utilities are restated here to follow the app's tokens;
          // `cn` merges by tailwind-merge, so these win over the primitive's.
          className="h-full min-h-0 resize-none rounded-2xl border-border/50 bg-surface-0 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:ring-primary/20 dark:text-foreground"
        />
      </main>

      <footer className="flex items-center gap-2 px-3 pb-3 pt-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="px-3"
          onClick={onPrimary}
          disabled={!speech.available || (!hasText && !playing && !speech.paused)}
          aria-label={primaryLabel}
          title={primaryLabel}
        >
          {primaryGlyph}
          <span>{primaryLabel}</span>
        </Button>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="px-3"
          onClick={speech.stop}
          disabled={!speech.speaking && !speech.paused}
          aria-label="Stop"
          title="Stop"
        >
          <Square className="fill-current" />
          <span>Stop</span>
        </Button>

        {/* No `ml-auto`: the row is left-aligned, so the speed sits beside the
            playback buttons and the right-hand side stays empty. */}
        <div className="flex items-center gap-1" role="group" aria-label="Playback speed">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => applySpeed(stepSpeechSpeed(speed, -1))}
            disabled={speed <= SPEECH_SPEED_MIN}
            aria-label="Slower"
            title="Slower"
          >
            <Minus />
          </Button>
          <button
            type="button"
            onClick={() => applySpeed(SPEECH_SPEED_DEFAULT)}
            className="min-w-[3.5rem] rounded px-1 py-1 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Playback speed ${formatSpeechSpeed(speed)}. Reset to normal.`}
            title="Reset to normal speed"
          >
            {formatSpeechSpeed(speed)}
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => applySpeed(stepSpeechSpeed(speed, 1))}
            disabled={speed >= SPEECH_SPEED_MAX}
            aria-label="Faster"
            title="Faster"
          >
            <Plus />
          </Button>
        </div>
      </footer>
    </div>
  );
}
