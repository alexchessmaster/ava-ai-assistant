const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/models/localModelSize.ts");

test("Ollama's tag form is read, where the size follows a colon", async () => {
  const { estimateModelSizeB } = await load();

  // The shape a self-hosted server actually serves. A dash-only pattern read
  // every one of these as size 0 and silently withheld the tool registry, which
  // is why the assistant answered "I am a text-based AI".
  assert.equal(estimateModelSizeB("gemma4:e4b"), 4);
  assert.equal(estimateModelSizeB("deepseek-r1:8b"), 8);
  assert.equal(estimateModelSizeB("llama3.2:3b"), 3);
  assert.equal(estimateModelSizeB("gpt-oss:20b"), 20);
});

test("the other ways an id can carry its size still work", async () => {
  const { estimateModelSizeB } = await load();

  assert.equal(estimateModelSizeB("qwen2.5-7b-instruct"), 7);
  assert.equal(estimateModelSizeB("llama-3.3-70b-versatile"), 70);
  assert.equal(estimateModelSizeB("mistral_12b"), 12);
  assert.equal(estimateModelSizeB("model 30b"), 30);
});

test("an id with no size says so rather than guessing", async () => {
  const { estimateModelSizeB } = await load();

  for (const modelId of ["llama3:latest", "mistral", "phi-3-mini", "", undefined, 42]) {
    assert.equal(estimateModelSizeB(modelId), 0, `${modelId} names no size`);
  }
});

test("a size in a version is not mistaken for a parameter count", async () => {
  const { estimateModelSizeB } = await load();

  // "4" is the version, not a size, and taking it would put a 30B model above
  // the floor for the wrong reason.
  assert.equal(estimateModelSizeB("qwen2.5-coder"), 0);
  assert.equal(estimateModelSizeB("gemma3:27b"), 27);
});

test("the floor is applied to a model that names its size", async () => {
  const { localModelSupportsTools } = await load();

  assert.equal(localModelSupportsTools({ modelId: "qwen2.5-7b-instruct" }), true);
  assert.equal(localModelSupportsTools({ modelId: "gemma4:e4b" }), true);
  assert.equal(localModelSupportsTools({ modelId: "llama3.2:1b" }), false);
  assert.equal(localModelSupportsTools({ modelId: "qwen2.5:0.5b" }), false);

  // Self-hosted or not, a size below the floor is still refused.
  assert.equal(
    localModelSupportsTools({ modelId: "llama3.2:1b", isSelfHosted: true }),
    false
  );
});

test("an unreadable tag is trusted only on the user's own server", async () => {
  const { localModelSupportsTools } = await load();

  // They chose the server and the tag; an Ollama tag need not carry a size, and
  // refusing here is what produced an assistant insisting it had no tools.
  assert.equal(localModelSupportsTools({ modelId: "llama3:latest", isSelfHosted: true }), true);

  // The bundled registry always names a size, so an unreadable id there means
  // something is off and staying conservative costs nothing.
  assert.equal(localModelSupportsTools({ modelId: "llama3:latest" }), false);
});
