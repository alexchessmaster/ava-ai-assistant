const test = require("node:test");
const assert = require("node:assert/strict");

const { toChatCompletionsContent } = require("../../src/services/ai/chatCompletionsContent.ts");

test("text-only parts collapse back to a plain string", () => {
  const result = toChatCompletionsContent([{ type: "text", text: "hello" }], true);
  assert.equal(result, "hello");
});

test("an image part becomes an OpenAI image_url carrying a data URL", () => {
  const result = toChatCompletionsContent(
    [
      { type: "text", text: "what is this?" },
      { type: "image", image: "AAAA", mediaType: "image/png" },
    ],
    true
  );

  assert.deepEqual(result, [
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]);
});

test("a transport with no image lane keeps only the text", () => {
  const result = toChatCompletionsContent(
    [
      { type: "text", text: "what is this?" },
      { type: "image", image: "AAAA", mediaType: "image/png" },
    ],
    false
  );

  assert.equal(result, "what is this?", "llama.cpp would choke on an image_url part");
});

test("several images all ride, and a missing mediaType falls back to jpeg", () => {
  const result = toChatCompletionsContent(
    [
      { type: "image", image: "AAA" },
      { type: "text", text: "compare" },
      { type: "image", image: "BBB", mediaType: "image/webp" },
    ],
    true
  );

  assert.deepEqual(result, [
    { type: "text", text: "compare" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
    { type: "image_url", image_url: { url: "data:image/webp;base64,BBB" } },
  ]);
});

test("an image part with no payload is skipped rather than sent empty", () => {
  const result = toChatCompletionsContent([{ type: "image", mediaType: "image/png" }], true);
  assert.equal(result, "");
});
