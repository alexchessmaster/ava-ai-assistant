import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/useToast";
import type { ChatAttachment } from "./types";
import type { ChatAttachmentReadResult } from "../../types/electron";

/** Past a handful, the request (and the tray) stops being useful. */
export const MAX_CHAT_ATTACHMENTS = 5;

// Main-process error codes → the sentence the user actually reads. Two codes
// share a sentence when the user's next move is the same either way.
//
// Plain English rather than i18n keys on purpose: this project checks that
// every `t()` key resolves in `en`, and every `en` key exists in 11 other
// locales, so translating these would touch thirteen upstream files. Convert
// them here when the fork wants translations.
const ERROR_MESSAGES: Record<string, (name: string) => string> = {
  UNSUPPORTED_TYPE: (name) => `${name} isn't a supported file type`,
  BINARY: (name) => `${name} isn't a supported file type`,
  TOO_LARGE: (name) => `${name} is too large to attach`,
  IMAGE_TOO_LARGE: (name) => `${name} is too large to attach`,
  EMPTY: (name) => `${name} couldn't be read`,
  UNREADABLE: (name) => `${name} couldn't be read`,
  PDF_UNREADABLE: (name) => `${name} couldn't be read`,
  PDF_NO_TEXT: (name) => `${name} has no readable text — it may be a scanned document`,
};

const GENERIC_ERROR = (name: string) => `${name} couldn't be attached`;

export interface ChatAttachmentDropHandlers {
  onDragEnter: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}

export interface ChatAttachments {
  attachments: ChatAttachment[];
  pickAttachments: () => Promise<void>;
  /** Stages the image on the clipboard, if it holds one. */
  pasteImage: () => Promise<void>;
  addDroppedFiles: (files: FileList | File[] | null) => Promise<void>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  /** Spread onto the host's drop zone; drives `isDragging` for the feedback. */
  dropHandlers: ChatAttachmentDropHandlers;
  isDragging: boolean;
}

// Only real file drags should arm the drop zone; dragging selected text or a
// note row over the composer must keep its own behaviour.
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

// A hint for the chooser only: the main process classifies what was actually
// picked (see classifyFile in helpers/chatAttachments.js) and refuses the rest.
const CHOOSER_ACCEPT = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf",
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".log",
  ".html",
  ".css",
  ".py",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".sh",
  ".sql",
].join(",");

/**
 * Opens Chromium's file chooser through a throwaway input element.
 *
 * Deliberately not Electron's `dialog.showOpenDialog`: that dialog is opened as
 * a modal child of the always-on-top dictation overlay, and on Linux the
 * overlay is left unable to take the keyboard once it closes — the composer
 * stops accepting input and reopening the panel does not clear it. Chromium's
 * own chooser keeps that relationship inside the web contents.
 */
function chooseFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = CHOOSER_ACCEPT;
    input.style.display = "none";

    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };

    input.addEventListener("change", () => finish(input.files ? Array.from(input.files) : []));
    // Chromium reports a dismissed chooser as "cancel". Without this the
    // promise would never settle and the reading guard would stay latched.
    input.addEventListener("cancel", () => finish([]));

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Files staged for the next chat message. Reading happens in the main process
 * (images are encoded for vision, PDFs and text files are reduced to text), so
 * the renderer only ever handles the finished attachment.
 */
export function useChatAttachments(): ChatAttachments {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/dragleave fire for every descendant crossed, so a depth counter
  // is the only reliable way to tell a real exit from an internal crossing.
  const dragDepthRef = useRef(0);
  const readingRef = useRef(false);

  const applyResults = useCallback(
    (results: ChatAttachmentReadResult[]) => {
      const slots = MAX_CHAT_ATTACHMENTS - attachmentsRef.current.length;
      const accepted: ChatAttachment[] = [];
      const failures: Array<{ error: string; name?: string }> = [];
      let overflow = 0;

      for (const result of results) {
        // Explicit comparison, not `!result.ok`: this project compiles with
        // strict:false, where a boolean discriminant doesn't narrow the union.
        if (result.ok === false) {
          failures.push({ error: result.error, name: result.name });
          continue;
        }
        if (accepted.length >= slots) {
          overflow += 1;
          continue;
        }
        accepted.push({ ...result.attachment, id: crypto.randomUUID() });
      }

      if (accepted.length) setAttachments((current) => [...current, ...accepted]);

      for (const failure of failures) {
        const describe = ERROR_MESSAGES[failure.error] ?? GENERIC_ERROR;
        toast({
          title: "Couldn't attach file",
          description: describe(failure.name || "That file"),
          variant: "destructive",
        });
      }
      if (overflow > 0) {
        toast({
          title: "Couldn't attach file",
          description: `You can attach up to ${MAX_CHAT_ATTACHMENTS} files`,
          variant: "destructive",
        });
      }
    },
    [t, toast]
  );

  // Reads files the OS handed us — a picker selection or a real drop — in the
  // main process and stages what came back. Sequential on purpose: every read
  // can decode an image or parse a PDF, and a burst of those on one thread
  // stalls the app.
  const intakeFiles = useCallback(
    async (files: File[]) => {
      const read = window.electronAPI?.readChatAttachment;
      const pathFor = window.electronAPI?.getChatAttachmentPath;
      if (!read || !pathFor || files.length === 0 || readingRef.current) return;

      readingRef.current = true;
      try {
        const results: ChatAttachmentReadResult[] = [];
        for (const file of files) {
          const filePath = pathFor(file);
          results.push(
            filePath
              ? await read(filePath)
              : // A File the OS won't reveal a path for (constructed in the
                // page, or a drag from outside a file manager) can't be read.
                { ok: false, error: "UNREADABLE", name: file.name }
          );
        }
        applyResults(results);
      } finally {
        readingRef.current = false;
      }
    },
    [applyResults]
  );

  const pickAttachments = useCallback(async () => {
    if (readingRef.current) return;
    await intakeFiles(await chooseFiles());
  }, [intakeFiles]);

  const addDroppedFiles = useCallback(
    async (files: FileList | File[] | null) => {
      await intakeFiles(files ? Array.from(files) : []);
    },
    [intakeFiles]
  );

  // The clipboard image is read in main, which owns the OS clipboard — the
  // renderer only decides that a paste event looked like an image.
  const pasteImage = useCallback(async () => {
    const read = window.electronAPI?.readClipboardImage;
    if (!read || readingRef.current) return;
    readingRef.current = true;
    try {
      const result = await read();
      // No image in the clipboard is a false positive from the paste sniffing
      // (a copied file, say), not something to explain to the user.
      if (result.ok === false && result.error === "EMPTY") return;
      applyResults([result]);
    } finally {
      readingRef.current = false;
    }
  }, [applyResults]);

  // A file dropped outside a drop zone — the panel header, the chat sidebar —
  // navigates the window to that file, replacing the whole UI with it. Both
  // surfaces that can receive a drop mount this hook, so the default is
  // cancelled here rather than in main, which keeps the feature out of
  // windowManager.js.
  useEffect(() => {
    const swallow = (event: globalThis.DragEvent) => event.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  const clearAttachments = useCallback(() => setAttachments([]), []);

  const dropHandlers = useMemo<ChatAttachmentDropHandlers>(
    () => ({
      onDragEnter: (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setIsDragging(true);
      },
      onDragOver: (event) => {
        if (!carriesFiles(event)) return;
        // Without this the browser refuses the drop outright.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event) => {
        if (!carriesFiles(event)) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragging(false);
      },
      onDrop: (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepthRef.current = 0;
        setIsDragging(false);
        void addDroppedFiles(event.dataTransfer.files);
      },
    }),
    [addDroppedFiles]
  );

  return {
    attachments,
    pickAttachments,
    pasteImage,
    addDroppedFiles,
    removeAttachment,
    clearAttachments,
    dropHandlers,
    isDragging,
  };
}
