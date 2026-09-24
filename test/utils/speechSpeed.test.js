const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => {
  const m = await import("../../src/utils/speechSpeed.ts");
  return m.default || m;
};

test("normalizeSpeechSpeed clamps to the supported range", async () => {
  const { normalizeSpeechSpeed } = await load();
  assert.equal(normalizeSpeechSpeed(0.1), 0.5);
  assert.equal(normalizeSpeechSpeed(9), 2);
  assert.equal(normalizeSpeechSpeed(-3), 0.5);
});

test("normalizeSpeechSpeed falls back to 1x for anything unparseable", async () => {
  const { normalizeSpeechSpeed } = await load();
  assert.equal(normalizeSpeechSpeed(undefined), 1);
  assert.equal(normalizeSpeechSpeed(null), 1);
  assert.equal(normalizeSpeechSpeed(NaN), 1);
  assert.equal(normalizeSpeechSpeed(""), 1);
  assert.equal(normalizeSpeechSpeed("fast"), 1);
});

test("normalizeSpeechSpeed snaps to a step so stored values stay on the grid", async () => {
  const { normalizeSpeechSpeed } = await load();
  assert.equal(normalizeSpeechSpeed(1.23), 1.25);
  assert.equal(normalizeSpeechSpeed(1.22), 1.2);
  // A value from localStorage arrives as a string.
  assert.equal(normalizeSpeechSpeed("1.2"), 1.2);
});

test("stepping accumulates without float drift", async () => {
  const { stepSpeechSpeed } = await load();
  // 0.05 is not representable in binary; four naive additions land on
  // 1.2000000000000002, which would render as "1.20x" and never equal 1.2.
  let speed = 1;
  for (let i = 0; i < 4; i += 1) speed = stepSpeechSpeed(speed, 1);
  assert.equal(speed, 1.2);

  // And back down again, from the top of the range.
  let down = 2;
  for (let i = 0; i < 20; i += 1) down = stepSpeechSpeed(down, -1);
  assert.equal(down, 1);
});

test("stepping cannot leave the range", async () => {
  const { stepSpeechSpeed } = await load();
  assert.equal(stepSpeechSpeed(2, 1), 2);
  assert.equal(stepSpeechSpeed(0.5, -1), 0.5);
});

test("formatSpeechSpeed keeps one decimal for whole steps", async () => {
  const { formatSpeechSpeed } = await load();
  assert.equal(formatSpeechSpeed(1), "1.0x");
  assert.equal(formatSpeechSpeed(1.2), "1.2x");
  assert.equal(formatSpeechSpeed(0.5), "0.5x");
  assert.equal(formatSpeechSpeed(2), "2.0x");
  // A fine step needs both decimals.
  assert.equal(formatSpeechSpeed(1.05), "1.05x");
});

test("readSpeechSpeed defaults to 1x when storage throws", async () => {
  const { readSpeechSpeed, SPEECH_SPEED_KEY } = await load();
  const original = globalThis.window;
  globalThis.window = {
    get localStorage() {
      throw new Error("site data blocked");
    },
  };
  try {
    assert.equal(readSpeechSpeed(), 1);
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
  assert.equal(SPEECH_SPEED_KEY, "speechSpeed");
});

test("writeSpeechSpeed persists the clamped value and readSpeechSpeed returns it", async () => {
  const { readSpeechSpeed, writeSpeechSpeed } = await load();
  const original = globalThis.window;
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
  };
  try {
    assert.equal(readSpeechSpeed(), 1);
    // Out-of-range input is clamped before it is stored, so a hand-edited
    // localStorage cannot smuggle in a speed the engines would reject.
    assert.equal(writeSpeechSpeed(5), 2);
    assert.equal(store.get("speechSpeed"), "2");
    assert.equal(readSpeechSpeed(), 2);
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});
