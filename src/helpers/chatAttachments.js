const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

// Files the user attaches to a chat message. Images ride to the model as vision
// parts; PDFs and text files are reduced to text that the renderer folds into
// the request (never into the displayed message — see useChatStreaming).
//
// Everything here is app-side policy, deliberately kept pure/injectable so it
// can be unit-tested without Electron (see test/helpers/chatAttachments.test.js).

const IMAGE_MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

// Plain-text-ish formats worth inlining. Deliberately a list rather than a
// "anything not binary" rule: the caller shows these file types in the picker.
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".rst",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".pl",
  ".lua",
  ".r",
  ".m",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
  ".dart",
  ".gradle",
  ".dockerfile",
]);

const PDF_EXTENSION = ".pdf";

// Anything larger is refused outright — reading it would stall the main process
// for no gain, since it would have to be truncated anyway.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
// A source image is decoded into memory before encoding; this bounds that.
const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
// Same budget as screen context: keeps the base64 payload (~1.37x) inside the
// API's 2.8M character limit with room for the transcript and prompt.
const MAX_ENCODED_IMAGE_BYTES = 1_500_000;
// Vision models downsample past ~1.5k px on the long edge (same as screen context).
const MAX_IMAGE_EDGE_PX = 1568;
const JPEG_QUALITY_LADDER = [85, 70, 55];
const JPEG_FALLBACK_EDGE_PX = 1024;
// Longest text handed to the model from one file (~15k tokens).
const MAX_TEXT_CHARS = 60_000;
const MAX_PDF_PAGES = 200;
const MAX_FILE_NAME_CHARS = 120;

// Strips anything that would break the `<file name="...">` wrapper the renderer
// builds around document text, plus control characters that would corrupt it.
function sanitizeFileName(filePath) {
  // Splits on both separators rather than path.basename, so a Windows-style
  // path never leaks into the chip or the prompt on a POSIX host.
  const base = String(filePath || "")
    .split(/[/\\]/)
    .pop();
  const cleaned = String(base || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["<>]/g, "")
    .trim();
  return (cleaned || "attachment").slice(0, MAX_FILE_NAME_CHARS);
}

function extensionOf(filePath) {
  return path.extname(String(filePath || "")).toLowerCase();
}

function classifyFile(filePath) {
  const ext = extensionOf(filePath);
  if (IMAGE_MEDIA_TYPES.has(ext)) return "image";
  if (ext === PDF_EXTENSION) return "pdf";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

// A NUL byte in the first block means the file is binary even though its
// extension claims text. Cheap, and it stops a mislabelled archive from being
// pasted into the prompt as mojibake.
function looksBinary(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
  return probe.includes(0);
}

function truncationNotice(reason) {
  return `\n\n[attachment truncated: ${reason}]`;
}

function decodeTextBuffer(buffer) {
  if (looksBinary(buffer)) return { ok: false, error: "BINARY" };

  let text = buffer.toString("utf8");
  // A leading BOM would otherwise ride into the prompt as a stray glyph.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const truncated = text.length > MAX_TEXT_CHARS;
  return {
    ok: true,
    text: truncated ? text.slice(0, MAX_TEXT_CHARS) + truncationNotice("file is too long") : text,
    truncated,
  };
}

// pdfjs is ESM-only and ~1MB, so it loads on first use rather than at startup —
// most sessions never attach a PDF.
let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      // Node has no worker thread pool here; pdfjs still resolves its worker
      // through this path. Electron unpacks pdfjs from the asar (see
      // electron-builder.json), so the resolved path is rewritten to the
      // unpacked copy — the ESM loader reads through real fs, not Electron's
      // asar-aware fs.
      const workerSrc = require
        .resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")
        .split(`${path.sep}app.asar${path.sep}`)
        .join(`${path.sep}app.asar.unpacked${path.sep}`);
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      return pdfjs;
    })().catch((error) => {
      pdfjsPromise = null;
      throw error;
    });
  }
  return pdfjsPromise;
}

async function extractPdfText(buffer, deps = {}) {
  const pdfjs = await (deps.loadPdfjs ?? loadPdfjs)();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  try {
    const pageCount = doc.numPages;
    const pages = [];
    let chars = 0;
    let truncated = pageCount > MAX_PDF_PAGES;

    for (let pageNumber = 1; pageNumber <= Math.min(pageCount, MAX_PDF_PAGES); pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => (typeof item.str === "string" ? item.str : ""))
        .join("")
        .trim();
      if (!pageText) continue;

      const block = `\n\n--- page ${pageNumber} ---\n${pageText}`;
      if (chars + block.length > MAX_TEXT_CHARS) {
        pages.push(block.slice(0, Math.max(0, MAX_TEXT_CHARS - chars)));
        chars = MAX_TEXT_CHARS;
        truncated = true;
        break;
      }
      pages.push(block);
      chars += block.length;
    }

    if (truncated) {
      pages.push(truncationNotice(`only the first ${MAX_PDF_PAGES} pages are included`));
    }

    const text = pages.join("").trim();
    if (!text) return { ok: false, error: "PDF_NO_TEXT" };
    return { ok: true, text, truncated, pageCount };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

// The quality ladder, over an already-decoded bitmap. Encodes from the same
// source at each rung so quality drops never compound, then resizes once more
// if even the lowest quality doesn't fit.
function encodeDecodedImage(image) {
  const size = image.getSize();
  const scaled =
    Math.max(size.width, size.height) > MAX_IMAGE_EDGE_PX
      ? image.resize(
          size.width >= size.height
            ? { width: MAX_IMAGE_EDGE_PX, quality: "good" }
            : { height: MAX_IMAGE_EDGE_PX, quality: "good" }
        )
      : image;

  for (const quality of JPEG_QUALITY_LADDER) {
    const encoded = scaled.toJPEG(quality);
    if (encoded.length <= MAX_ENCODED_IMAGE_BYTES) {
      return {
        mediaType: "image/jpeg",
        image: encoded.toString("base64"),
        width: scaled.getSize().width,
        height: scaled.getSize().height,
      };
    }
  }

  const resized = scaled.resize({ width: JPEG_FALLBACK_EDGE_PX, quality: "good" });
  const smallest = resized.toJPEG(JPEG_QUALITY_LADDER.at(-1));
  if (smallest.length > MAX_ENCODED_IMAGE_BYTES) return { error: "IMAGE_TOO_LARGE" };
  return {
    mediaType: "image/jpeg",
    image: smallest.toString("base64"),
    width: resized.getSize().width,
    height: resized.getSize().height,
  };
}

// Passes an already-small image through untouched (preserving PNG transparency
// and pixel-exact screenshots); anything else goes through the ladder.
function encodeImage(buffer, mediaType, nativeImage) {
  const image = nativeImage?.createFromBuffer(buffer);
  const usable = image && !image.isEmpty();
  const size = usable ? image.getSize() : null;

  if (
    buffer.length <= MAX_ENCODED_IMAGE_BYTES &&
    (!size || Math.max(size.width, size.height) <= MAX_IMAGE_EDGE_PX)
  ) {
    return {
      mediaType,
      image: buffer.toString("base64"),
      width: size?.width,
      height: size?.height,
    };
  }
  if (!usable) {
    // No decoder available (or an unreadable image): keep it only if the raw
    // bytes happen to already fit, otherwise report it rather than send a
    // payload the API will reject.
    return buffer.length <= MAX_ENCODED_IMAGE_BYTES
      ? { mediaType, image: buffer.toString("base64") }
      : { error: "IMAGE_TOO_LARGE" };
  }
  return encodeDecodedImage(image);
}

/**
 * Reads an image straight off the OS clipboard. A pasted screenshot exists only
 * as clipboard data — there is no path to hand to readChatAttachment — so this
 * is the one intake that never touches the filesystem.
 *
 * Never throws, like readChatAttachment: a failure is `{ ok: false, error }`.
 */
function readClipboardImage(deps = {}) {
  let image = deps.image;
  if (!image) {
    try {
      image = (deps.electron ?? require("electron")).clipboard.readImage();
    } catch (error) {
      debugLogger.warn("Clipboard image read failed", { error: error.message }, "chatAttachments");
      return { ok: false, error: "UNREADABLE" };
    }
  }
  if (!image || image.isEmpty()) return { ok: false, error: "EMPTY" };

  const encoded = encodeDecodedImage(image);
  if (encoded.error) return { ok: false, error: encoded.error };

  // A pasted image has no filename, so it gets a descriptive one; the chip and
  // the prompt both use it. Filenames are never translated.
  return {
    ok: true,
    attachment: {
      kind: "image",
      name: "pasted-image.jpg",
      // The clipboard image never had a file, so report what will actually be
      // sent rather than an original size we don't have.
      bytes: Math.floor((encoded.image.length * 3) / 4),
      ...encoded,
    },
  };
}

/**
 * Reads one user-picked file into the shape the renderer's chat request needs.
 * Never throws: a failure is returned as `{ ok: false, error }` so a bad file
 * degrades to a toast instead of breaking the conversation.
 *
 * @returns {Promise<
 *   | { ok: true, attachment: { kind: "image", name, mediaType, image, bytes, width?, height? } }
 *   | { ok: true, attachment: { kind: "document", name, text, bytes, truncated, pageCount? } }
 *   | { ok: false, error: string }
 * >}
 */
async function readChatAttachment(filePath, deps = {}) {
  if (typeof filePath !== "string" || !filePath) return { ok: false, error: "UNREADABLE" };

  const kind = classifyFile(filePath);
  if (kind === "unsupported") return { ok: false, error: "UNSUPPORTED_TYPE" };

  const name = sanitizeFileName(filePath);

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    debugLogger.warn("Chat attachment unreadable", { error: error.message }, "chatAttachments");
    return { ok: false, error: "UNREADABLE" };
  }
  if (!stats.isFile()) return { ok: false, error: "UNREADABLE" };
  if (stats.size === 0) return { ok: false, error: "EMPTY" };
  if (stats.size > MAX_FILE_BYTES) return { ok: false, error: "TOO_LARGE" };

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    debugLogger.warn("Chat attachment read failed", { error: error.message }, "chatAttachments");
    return { ok: false, error: "UNREADABLE" };
  }

  const bytes = buffer.length;

  if (kind === "image") {
    if (bytes > MAX_IMAGE_SOURCE_BYTES) return { ok: false, error: "TOO_LARGE" };
    const nativeImage = deps.nativeImage ?? require("electron").nativeImage;
    const encoded = encodeImage(buffer, IMAGE_MEDIA_TYPES.get(extensionOf(filePath)), nativeImage);
    if (encoded.error) return { ok: false, error: encoded.error };
    return { ok: true, attachment: { kind: "image", name, bytes, ...encoded } };
  }

  if (kind === "pdf") {
    try {
      const extracted = await extractPdfText(buffer, deps);
      if (!extracted.ok) return { ok: false, error: extracted.error };
      return {
        ok: true,
        attachment: {
          kind: "document",
          name,
          bytes,
          text: extracted.text,
          truncated: extracted.truncated,
          pageCount: extracted.pageCount,
        },
      };
    } catch (error) {
      debugLogger.warn("PDF attachment failed", { error: error.message }, "chatAttachments");
      return { ok: false, error: "PDF_UNREADABLE" };
    }
  }

  const decoded = decodeTextBuffer(buffer);
  if (!decoded.ok) return { ok: false, error: decoded.error };
  return {
    ok: true,
    attachment: {
      kind: "document",
      name,
      bytes,
      text: decoded.text,
      truncated: decoded.truncated,
    },
  };
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  MAX_PDF_PAGES,
  MAX_ENCODED_IMAGE_BYTES,
  TEXT_EXTENSIONS,
  IMAGE_MEDIA_TYPES,
  classifyFile,
  sanitizeFileName,
  decodeTextBuffer,
  extractPdfText,
  encodeImage,
  readChatAttachment,
  readClipboardImage,
};
