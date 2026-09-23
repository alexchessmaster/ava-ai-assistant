const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_TEXT_CHARS,
  classifyFile,
  sanitizeFileName,
  decodeTextBuffer,
  extractPdfText,
  encodeImage,
  readChatAttachment,
  readClipboardImage,
} = require("../../src/helpers/chatAttachments");

function withTempFiles(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-attachments-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const written = {};
  for (const [name, contents] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, contents);
    written[name] = filePath;
  }
  return written;
}

// A one-page PDF with a real text stream and correct xref offsets, so pdfjs
// parses it the same way it parses a user's file.
function buildMinimalPdf(text = "Hello attachment world") {
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  objects[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("classifyFile maps extensions to the three supported kinds", () => {
  assert.equal(classifyFile("/tmp/photo.PNG"), "image");
  assert.equal(classifyFile("/tmp/scan.jpeg"), "image");
  assert.equal(classifyFile("/tmp/notes.pdf"), "pdf");
  assert.equal(classifyFile("/tmp/report.md"), "text");
  assert.equal(classifyFile("/tmp/data.csv"), "text");
  assert.equal(classifyFile("/tmp/archive.zip"), "unsupported");
  assert.equal(classifyFile("/tmp/noextension"), "unsupported");
  assert.equal(classifyFile(""), "unsupported");
});

test("sanitizeFileName keeps the basename and strips prompt-breaking characters", () => {
  assert.equal(sanitizeFileName("/home/alex/reports/q3.pdf"), "q3.pdf");
  assert.equal(sanitizeFileName("C:\\Users\\alex\\q3.pdf"), "q3.pdf");
  assert.equal(sanitizeFileName('/tmp/a"b<c>d.txt'), "abcd.txt");
  assert.equal(sanitizeFileName("/tmp/" + "x".repeat(300) + ".txt").length, 120);
  // A name that sanitizes away entirely still yields something renderable.
  assert.equal(sanitizeFileName('/tmp/"<>"'), "attachment");
});

test("decodeTextBuffer strips a BOM and rejects binary content", () => {
  assert.deepEqual(decodeTextBuffer(Buffer.from("hello")), {
    ok: true,
    text: "hello",
    truncated: false,
  });

  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello")]);
  assert.equal(decodeTextBuffer(withBom).text, "hello");

  const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
  assert.deepEqual(decodeTextBuffer(binary), { ok: false, error: "BINARY" });
});

test("decodeTextBuffer truncates long text and says so", () => {
  const decoded = decodeTextBuffer(Buffer.from("a".repeat(MAX_TEXT_CHARS + 500)));
  assert.equal(decoded.truncated, true);
  assert.ok(decoded.text.startsWith("a".repeat(MAX_TEXT_CHARS)));
  assert.match(decoded.text, /\[attachment truncated: file is too long\]$/);
});

test("extractPdfText reads the text layer of a real PDF", async () => {
  const result = await extractPdfText(buildMinimalPdf("Hello attachment world"));
  assert.equal(result.ok, true);
  assert.equal(result.pageCount, 1);
  assert.equal(result.text.includes("Hello attachment world"), true);
  assert.equal(result.truncated, false);
});

test("extractPdfText reports a PDF with no text layer instead of returning nothing", async () => {
  // A stub stands in for pdfjs: an empty text layer is what a scanned PDF gives.
  const stub = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
        destroy: async () => {},
      }),
    }),
  };
  const result = await extractPdfText(Buffer.from("%PDF-1.4"), { loadPdfjs: async () => stub });
  assert.deepEqual(result, { ok: false, error: "PDF_NO_TEXT" });
});

test("extractPdfText stops at the page cap and flags the truncation", async () => {
  const destroyed = { value: false };
  const stub = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 500,
        getPage: async (pageNumber) => ({
          getTextContent: async () => ({ items: [{ str: `page ${pageNumber}` }] }),
        }),
        destroy: async () => {
          destroyed.value = true;
        },
      }),
    }),
  };
  const result = await extractPdfText(Buffer.from("%PDF-1.4"), { loadPdfjs: async () => stub });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.match(result.text, /page 1\b/);
  assert.equal(result.text.includes("page 500"), false);
  // The document must still be released on the truncated path.
  assert.equal(destroyed.value, true);
});

test("encodeImage passes a small image through untouched", () => {
  const buffer = Buffer.from("pretend-jpeg-bytes");
  const encoded = encodeImage(buffer, "image/png", null);
  assert.equal(encoded.mediaType, "image/png");
  assert.equal(encoded.image, buffer.toString("base64"));
});

test("encodeImage reports an image too large to send when no decoder is available", () => {
  const buffer = Buffer.alloc(2_000_000, 7);
  assert.deepEqual(encodeImage(buffer, "image/png", null), { error: "IMAGE_TOO_LARGE" });
});

test("encodeImage downsizes an oversized image from the original bitmap", () => {
  const resizes = [];
  const qualities = [];
  const nativeImage = {
    createFromBuffer: () => {
      const makeImage = (size) => ({
        isEmpty: () => false,
        getSize: () => size,
        toJPEG: (quality) => {
          qualities.push(quality);
          // Only the final rung makes it under budget.
          return Buffer.alloc(quality === 55 ? 1_000_000 : 4_000_000, 1);
        },
        resize: (options) => {
          resizes.push(options);
          return makeImage({
            width: options.width ?? size.width,
            height: options.height ?? size.height,
          });
        },
      });
      return makeImage({ width: 6000, height: 4000 });
    },
  };

  const encoded = encodeImage(Buffer.alloc(9_000_000, 1), "image/jpeg", nativeImage);
  assert.equal(encoded.mediaType, "image/jpeg");
  assert.deepEqual(resizes[0], { width: 1568, quality: "good" });
  assert.deepEqual(qualities, [85, 70, 55]);
});

test("readChatAttachment rejects unsupported and unreadable files", async (t) => {
  const files = withTempFiles(t, { "archive.zip": "not supported", "empty.txt": "" });

  assert.deepEqual(await readChatAttachment(files["archive.zip"]), {
    ok: false,
    error: "UNSUPPORTED_TYPE",
  });
  assert.deepEqual(await readChatAttachment(files["empty.txt"]), { ok: false, error: "EMPTY" });
  assert.deepEqual(
    await readChatAttachment(path.join(path.dirname(files["empty.txt"]), "gone.md")),
    {
      ok: false,
      error: "UNREADABLE",
    }
  );
  assert.deepEqual(await readChatAttachment(null), { ok: false, error: "UNREADABLE" });
});

test("readChatAttachment returns a document for a text file", async (t) => {
  const files = withTempFiles(t, { "notes.md": "# Title\n\nBody text." });
  const result = await readChatAttachment(files["notes.md"]);
  assert.equal(result.ok, true);
  assert.equal(result.attachment.kind, "document");
  assert.equal(result.attachment.name, "notes.md");
  assert.equal(result.attachment.text, "# Title\n\nBody text.");
  assert.equal(result.attachment.truncated, false);
});

test("readChatAttachment returns a document for a PDF", async (t) => {
  const files = withTempFiles(t, { "report.pdf": buildMinimalPdf("Quarterly figures") });
  const result = await readChatAttachment(files["report.pdf"]);
  assert.equal(result.ok, true);
  assert.equal(result.attachment.kind, "document");
  assert.equal(result.attachment.pageCount, 1);
  assert.match(result.attachment.text, /Quarterly figures/);
});

test("readChatAttachment returns an image attachment from an injected decoder", async (t) => {
  const files = withTempFiles(t, { "shot.png": Buffer.from("png-bytes") });
  const nativeImage = {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 100, height: 50 }),
      toJPEG: () => Buffer.from("jpeg"),
      resize: () => {
        throw new Error("a small image must not be resized");
      },
    }),
  };

  const result = await readChatAttachment(files["shot.png"], { nativeImage });
  assert.equal(result.ok, true);
  assert.equal(result.attachment.kind, "image");
  assert.equal(result.attachment.mediaType, "image/png");
  assert.equal(result.attachment.image, Buffer.from("png-bytes").toString("base64"));
  assert.equal(result.attachment.width, 100);
});

// A stand-in for Electron's NativeImage. `bytesAtQuality` decides the encoded
// size for a given rung, so a test can say which one produced the payload.
function fakeDecodedImage({ width, height, bytesAtQuality }) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toJPEG: (quality) => Buffer.alloc(bytesAtQuality(quality), 1),
    resize: ({ width: nextWidth, height: nextHeight }) =>
      fakeDecodedImage({
        width: nextWidth ?? width,
        height: nextHeight ?? height,
        bytesAtQuality,
      }),
  };
}

test("a pasted screenshot is encoded from the clipboard bitmap", () => {
  const qualities = [];
  const result = readClipboardImage({
    image: fakeDecodedImage({
      width: 3840,
      height: 2160,
      bytesAtQuality: (quality) => {
        qualities.push(quality);
        return 900_000;
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.attachment.kind, "image");
  assert.equal(result.attachment.mediaType, "image/jpeg");
  assert.deepEqual(qualities, [85], "the first rung already fits");
  assert.equal(result.attachment.width, 1568, "downsampled to the vision long edge");
  assert.equal(result.attachment.name, "pasted-image.jpg");
  assert.ok(result.attachment.bytes > 0, "the chip needs a size to show");
  assert.equal(typeof result.attachment.image, "string");
});

test("a clipboard image that only fits at a lower quality walks the ladder", () => {
  const qualities = [];
  const result = readClipboardImage({
    image: fakeDecodedImage({
      width: 2000,
      height: 2000,
      bytesAtQuality: (quality) => {
        qualities.push(quality);
        return quality === 55 ? 500_000 : 4_000_000;
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(qualities, [85, 70, 55]);
});

test("an image too large to send at any quality is reported, not sent", () => {
  const result = readClipboardImage({
    image: fakeDecodedImage({ width: 2000, height: 2000, bytesAtQuality: () => 4_000_000 }),
  });

  assert.deepEqual(result, { ok: false, error: "IMAGE_TOO_LARGE" });
});

test("an empty clipboard is not an error the user should see", () => {
  const empty = { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) };
  assert.deepEqual(readClipboardImage({ image: empty }), { ok: false, error: "EMPTY" });
});

test("a clipboard read that throws degrades instead of breaking the paste", () => {
  const result = readClipboardImage({
    electron: {
      clipboard: {
        readImage() {
          throw new Error("no display");
        },
      },
    },
  });

  assert.deepEqual(result, { ok: false, error: "UNREADABLE" });
});
