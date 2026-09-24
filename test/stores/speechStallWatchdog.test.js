const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * The guard rail on a reading that stops advancing.
 *
 * This does not test audio; it tests the one property that makes the guard rail
 * safe to have at all — the clock is reset by progress, not by the start. A
 * wall-clock cap would cut a long document off mid-sentence, which is this
 * feature working rather than failing, so the difference between "ten minutes
 * since it began" and "ten minutes since anything happened" is the whole point
 * and is what the first test below pins.
 *
 * The web-voices backend is the one driven here: it reports progress per chunk,
 * needs no subprocesses, and its chunk boundaries are visible in the utterance
 * list the stubbed engine is handed.
 */

const utterances = [];

function installWindow() {
  const speechSynthesis = {
    getVoices: () => [{ name: "Fake OS Voice" }],
    speak: (utterance) => utterances.push(utterance),
    cancel: () => {},
    pause: () => {},
    resume: () => {},
    addEventListener: () => {},
  };

  global.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };

  global.window = {
    speechSynthesis,
    localStorage: {
      store: {},
      getItem(key) {
        return this.store[key] ?? null;
      },
      setItem(key, value) {
        this.store[key] = String(value);
      },
    },
    addEventListener: () => {},
    // No Kokoro engine, so the web voices take the job and the chunks are
    // observable; the system backend is never reached because voices exist.
    electronAPI: {
      kokoroStatus: () =>
        Promise.resolve({
          success: true,
          supported: true,
          engineInstalled: false,
          models: [],
          downloading: false,
        }),
      systemSpeechStatus: () => Promise.resolve({ available: true }),
      systemSpeechStop: () => Promise.resolve(),
    },
  };
}

installWindow();

// Two sentences, each too long to merge, so the reading is two chunks and the
// first one ending is progress rather than the end.
const TWO_CHUNKS = `${"a".repeat(200)}. ${"b".repeat(200)}.`;
const TEN_MINUTES = 10 * 60 * 1000;

let storePromise = null;
function loadStore() {
  storePromise ??= import("../../src/stores/speechStore.ts");
  return storePromise;
}

test("a reading that keeps advancing is left alone however long it runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { useSpeechStore } = await loadStore();
  useSpeechStore.getState().stop();
  utterances.length = 0;

  useSpeechStore.getState().speak(TWO_CHUNKS);
  assert.equal(utterances.length, 2, "two chunks reached the engine");

  // Past the window on wall-clock terms, but progress resets the clock.
  t.mock.timers.tick(TEN_MINUTES - 1000);
  utterances[0].onend();

  t.mock.timers.tick(TEN_MINUTES - 1000);
  assert.equal(
    useSpeechStore.getState().speakingText,
    TWO_CHUNKS,
    "a long passage is still reading, not stalled"
  );

  utterances[1].onend();
  assert.equal(useSpeechStore.getState().speakingText, null, "the last chunk ends it");
});

test("a reading that stops advancing is stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { useSpeechStore } = await loadStore();
  useSpeechStore.getState().stop();
  utterances.length = 0;
  const warned = t.mock.method(console, "warn", () => {});

  useSpeechStore.getState().speak(TWO_CHUNKS);
  t.mock.timers.tick(TEN_MINUTES);

  assert.equal(useSpeechStore.getState().speakingText, null, "the silent reading is cleared");
  assert.equal(warned.mock.callCount(), 1, "and it is loud about it in the log");
});

test("a paused reading is not a stalled one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { useSpeechStore } = await loadStore();
  useSpeechStore.getState().stop();
  utterances.length = 0;

  useSpeechStore.getState().speak(TWO_CHUNKS);
  useSpeechStore.getState().pause();

  t.mock.timers.tick(TEN_MINUTES * 3);

  const state = useSpeechStore.getState();
  assert.equal(state.paused, true, "someone who paused keeps their place");
  assert.equal(state.speakingText, TWO_CHUNKS);
});

test("a stop disarms the watchdog", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { useSpeechStore } = await loadStore();
  useSpeechStore.getState().stop();
  utterances.length = 0;
  const warned = t.mock.method(console, "warn", () => {});

  useSpeechStore.getState().speak(TWO_CHUNKS);
  useSpeechStore.getState().stop();
  t.mock.timers.tick(TEN_MINUTES * 2);

  assert.equal(warned.mock.callCount(), 0, "nothing was left watching a stopped reading");
});
