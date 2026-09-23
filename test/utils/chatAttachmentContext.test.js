const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAttachmentRequestText,
} = require("../../src/utils/chatAttachmentContext.ts");

test("no documents leaves the message untouched", () => {
  assert.equal(buildAttachmentRequestText("what changed?", []), "what changed?");
});

test("a document is appended as a named block the model can attribute", () => {
  const result = buildAttachmentRequestText("summarize this", [
    { name: "report.pdf", text: "Revenue was up." },
  ]);
  assert.equal(result, "summarize this\n\n<file name=\"report.pdf\">\nRevenue was up.\n</file>");
});

test("documents keep the order they were attached in", () => {
  const result = buildAttachmentRequestText("compare", [
    { name: "a.txt", text: "first" },
    { name: "b.txt", text: "second" },
  ]);
  assert.ok(result.indexOf("<file name=\"a.txt\">") < result.indexOf("<file name=\"b.txt\">"));
  assert.equal(result.split("<file name=").length - 1, 2);
});

test("an attachment with no message text doesn't lead with blank lines", () => {
  const result = buildAttachmentRequestText("", [{ name: "a.txt", text: "first" }]);
  assert.equal(result, "<file name=\"a.txt\">\nfirst\n</file>");
});

test("an empty document body still produces a well-formed block", () => {
  const result = buildAttachmentRequestText("hi", [{ name: "a.txt", text: "" }]);
  assert.equal(result, "hi\n\n<file name=\"a.txt\">\n\n</file>");
});
