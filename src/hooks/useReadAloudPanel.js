import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSpeechStore } from "../stores/speechStore";

const READ_ALOUD_TRANSITION_MS = 320;

/**
 * Owns the read-aloud panel: the open/close choreography, the box contents, and
 * the hotkey's play/pause/resume toggle.
 *
 * Deliberately much smaller than `useAssistantPanel`. There is no conversation,
 * no thinking flourish and no footer timeline here — the panel exists to hold
 * text and to play it — so it borrows only the parts of that lifecycle that are
 * structural: grow the window before mounting, mount, then animate open, and on
 * close run the teardown after the fade.
 *
 * The hotkey toggle reads the speech store imperatively rather than through a
 * selector: it is a command, not a render, and subscribing here would make the
 * whole panel re-render on every speech state change for no visual benefit.
 */
export function useReadAloudPanel({ requestMainWindowSize, resizeToContent }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [text, setText] = useState("");
  // Collapsed hides the text box and leaves the control strip — playback
  // controls, including Stop, stay reachable, which is the whole point of that
  // state existing separately from minimising the panel away entirely.
  const [collapsed, setCollapsed] = useState(false);

  const openRef = useRef(false);
  const textRef = useRef("");
  const collapsedRef = useRef(false);
  const closeTimerRef = useRef(null);
  const openFrameRef = useRef(null);
  const generationRef = useRef(0);

  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);

  useLayoutEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => () => clearTimeout(closeTimerRef.current), []);

  const openPanel = useCallback(async () => {
    if (openRef.current) return true;
    const generation = ++generationRef.current;
    clearTimeout(closeTimerRef.current);
    setClosing(false);
    // Grow the window before the panel mounts so its entrance never paints
    // clipped inside the compact pill bounds.
    try {
      await requestMainWindowSize("ASSISTANT");
    } catch {
      return false;
    }
    if (generation !== generationRef.current || openRef.current) return false;
    openRef.current = true;
    setMounted(true);
    cancelAnimationFrame(openFrameRef.current);
    openFrameRef.current = requestAnimationFrame(() => {
      openFrameRef.current = requestAnimationFrame(() => {
        if (generation !== generationRef.current) return;
        setOpen(true);
      });
    });
    return true;
  }, [requestMainWindowSize]);

  const completeClose = useCallback(() => {
    clearTimeout(closeTimerRef.current);
    openRef.current = false;
    setOpen(false);
    setClosing(false);
    closeTimerRef.current = setTimeout(() => setMounted(false), READ_ALOUD_TRANSITION_MS);
  }, []);

  const collapse = useCallback(() => {
    if (!openRef.current) return;
    generationRef.current += 1;
    cancelAnimationFrame(openFrameRef.current);
    setClosing(true);
    completeClose();
  }, [completeClose]);

  /**
   * Puts the panel away without touching the audio — the reading carries on
   * with the window collapsed back to the pill.
   *
   * This works because playback is not owned by this panel at all: it is Web
   * Audio in the speech store, in a renderer that stays alive while the window
   * is collapsed (the overlay is created with `backgroundThrottling: false`).
   * Nothing here needs to keep the audio going; it only has to avoid stopping
   * it.
   */
  const minimize = useCallback(() => {
    collapse();
  }, [collapse]);

  /** Done with this passage: silence it, then put the panel away. */
  const close = useCallback(() => {
    useSpeechStore.getState().stop();
    collapse();
  }, [collapse]);

  /**
   * Hides the text box and shrinks the window to the control strip — or puts
   * the box back.
   *
   * Collapsing needs nothing from here: the panel asks the shell to measure its
   * content while collapsed, and the measurement itself drives the resize.
   * Expanding is the half that has to be explicit, because leaving the measured
   * path means nothing will ask for the standing box back.
   */
  const toggleCollapsed = useCallback(() => {
    const next = !collapsedRef.current;
    collapsedRef.current = next;
    setCollapsed(next);
    if (!next) void requestMainWindowSize("ASSISTANT");
  }, [requestMainWindowSize]);

  /** Reported by the panel while collapsed; the shell measures, we resize. */
  const requestHeight = useCallback(
    (height, revision) => resizeToContent?.(height, revision),
    [resizeToContent]
  );

  /**
   * Reads `content`, replacing whatever was in the box.
   *
   * The text itself is stored exactly as it came — that is what the box shows
   * and what a second press re-reads — while the engine gets the markdown
   * stripped out of it, the same way a reply does. A selected note is as full
   * of `#` and `*` as a reply is.
   */
  const read = useCallback((content) => {
    const value = String(content ?? "");
    setText(value);
    textRef.current = value;
    if (value.trim()) useSpeechStore.getState().speak(value);
  }, []);

  /**
   * The hotkey. While something is being read it pauses, while paused it
   * resumes, and otherwise it opens the panel and starts on the current
   * selection — falling back to whatever is already in the box when nothing was
   * selected, so pressing it twice after a stop re-reads rather than doing
   * nothing.
   */
  const toggle = useCallback(async () => {
    const speech = useSpeechStore.getState();
    if (speech.paused) {
      speech.resume();
      return;
    }
    if (speech.speakingText) {
      speech.pause();
      return;
    }

    // The selection is read *here*, before the panel opens, and that ordering
    // is the whole reason it is not done in the main process on the hotkey:
    // the capture is a synthetic copy aimed at whatever window is foreground,
    // and this panel becomes focusable the moment it mounts. Read afterwards,
    // the copy would land on our own window and always come back empty — the
    // exact way a selection capture fails silently. The main process still
    // fires a target probe on the keypress, which this awaits for free.
    let selection = "";
    try {
      const capture = await window.electronAPI?.captureSelectedText?.({ probeEditable: false });
      if (capture?.status === "selected" && typeof capture.text === "string") {
        selection = capture.text;
      }
    } catch {
      // Nothing selected, or the platform cannot read it — on Linux that is
      // anything without xdotool or AT-SPI. The panel opens empty for pasting,
      // which is the documented fallback rather than an error.
    }

    const opened = await openPanel();
    if (!opened) return;
    const content = selection || textRef.current;
    if (content) read(content);
  }, [openPanel, read]);

  // The panel takes typed input, so the main process has to make the overlay
  // focusable for as long as it is up — and drop that again when it goes.
  useEffect(() => {
    window.electronAPI?.setReadAloudPanelOpen?.(mounted);
    return () => {
      void window.electronAPI?.setReadAloudPanelOpen?.(false);
    };
  }, [mounted]);

  return {
    open,
    mounted,
    closing,
    text,
    setText,
    openRef,
    openPanel,
    close,
    minimize,
    toggle,
    read,
    collapsed,
    toggleCollapsed,
    requestHeight,
  };
}
