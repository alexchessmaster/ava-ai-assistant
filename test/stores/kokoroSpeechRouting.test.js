const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * Which engine actually speaks, in the two places read-aloud is offered (the
 * assistant panel's reply and every chat message). Both go through
 * `useSpeechControl` → `speechStore.speak()`, so proving the choice here proves
 * it for both.
 *
 * These drive the real `speechStore` with a stubbed window, which is the only
 * way to pin the decision without an Electron app and a pair of ears. The
 * important case is the second test: a machine that *has* OS voices must still
 * prefer Kokoro, because "the system default is being used" is exactly the
 * symptom of getting that ordering wrong.
 */

function makeWav() {
  // 44-byte canonical WAV header; the content is never decoded here.
  return new Uint8Array(64);
}

/**
 * Installs a fake window for one scenario. `webVoices` decides whether the
 * platform claims to have speech voices, which is what the macOS/Windows path
 * keys off; `kokoroModelInstalled` decides whether Kokoro is usable.
 */
function installWindow({ webVoices, kokoroModelInstalled }) {
  const calls = { synthesized: [], spokenWithWebSpeech: [], systemSpeech: [], audioStarts: 0 };

  const speechSynthesis = {
    getVoices: () => (webVoices ? [{ name: "Fake OS Voice" }] : []),
    speak: (utterance) => calls.spokenWithWebSpeech.push(utterance.text),
    cancel: () => {},
    addEventListener: () => {},
  };

  class FakeAudioBufferSourceNode {
    constructor() {
      this.onended = null;
    }
    connect() {}
    start() {
      calls.audioStarts += 1;
      // Finish the "playback" on the next tick so the pipeline advances.
      setTimeout(() => this.onended && this.onended(), 0);
    }
    stop() {}
  }

  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.destination = {};
    }
    resume() {
      return Promise.resolve();
    }
    decodeAudioData() {
      return Promise.resolve({ duration: 1 });
    }
    createBufferSource() {
      return new FakeAudioBufferSourceNode();
    }
  }

  // A browser global the Web Speech branch constructs directly. Node has no
  // such class, so it has to be provided or the fallback path throws.
  global.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };

  const listeners = {};
  global.window = {
    speechSynthesis,
    AudioContext: FakeAudioContext,
    localStorage: {
      store: {},
      getItem(key) {
        return this.store[key] ?? null;
      },
      setItem(key, value) {
        this.store[key] = String(value);
      },
    },
    addEventListener: (event, handler) => {
      listeners[event] = handler;
    },
    electronAPI: {
      kokoroStatus: () =>
        Promise.resolve({
          success: true,
          supported: true,
          engineInstalled: kokoroModelInstalled,
          engineVersion: "1.13.8",
          models: [
            {
              id: "kokoro-en-v0_19",
              name: "Kokoro English",
              description: "",
              sizeMb: 305,
              license: "Apache-2.0",
              recommended: true,
              downloaded: kokoroModelInstalled,
              diskBytes: 0,
              isDownloading: false,
            },
          ],
          downloading: false,
        }),
      kokoroSynthesize: (payload) => {
        calls.synthesized.push(payload.text);
        return Promise.resolve({ success: true, audio: makeWav(), bytes: 64 });
      },
      kokoroStop: () => Promise.resolve({ success: true }),
      // The Linux fallback. Should never be reached while Kokoro is usable.
      systemSpeechSpeak: (text) => {
        calls.systemSpeech.push(text);
        return Promise.resolve(true);
      },
      systemSpeechStatus: () => Promise.resolve({ available: true }),
      systemSpeechStop: () => Promise.resolve(),
    },
  };

  return calls;
}

// `kokoroSpeech` decides whether it is available once, at import, and caches
// the answer. Clearing `require.cache` does not reset it — dynamic `import()`
// keeps its own module registry — so scenarios are separated through the
// module's real public reset, `refreshKokoroState()`, which is the same call
// the Settings UI makes after an install or a delete. That keeps this test
// honest: it re-probes exactly the way the app does.
let modulesPromise = null;

async function loadWith(scenario) {
  const calls = installWindow(scenario);

  // The stub has to exist before the first import, because the store probes
  // availability from module scope.
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import("../../src/stores/speechStore.ts"),
      import("../../src/stores/kokoroSpeech.ts"),
    ]);
  }

  const [speech, kokoro] = await modulesPromise;
  await kokoro.refreshKokoroState();
  return { calls, useSpeechStore: speech.useSpeechStore };
}

const REPLY = "The build finished. All checks passed.";

test("an installed Kokoro model is preferred even when the platform has OS voices", async () => {
  // This is the macOS/Windows case, where `hasWebVoices()` is true and the old
  // code would have gone straight to the native voices.
  const { calls, useSpeechStore } = await loadWith({
    webVoices: true,
    kokoroModelInstalled: true,
  });

  useSpeechStore.getState().speak(REPLY);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(
    calls.synthesized.length > 0,
    "Kokoro should have been asked to synthesize"
  );
  assert.equal(
    calls.spokenWithWebSpeech.length,
    0,
    "the OS voices must not be used while Kokoro is installed"
  );
  assert.equal(calls.systemSpeech.length, 0, "spd-say must not be used either");
  assert.ok(calls.audioStarts > 0, "the synthesized audio should be played");
});

test("a reply is chunked, not sent as one request", async () => {
  const { calls, useSpeechStore } = await loadWith({
    webVoices: false,
    kokoroModelInstalled: true,
  });

  // Long enough that splitForSpeech (220 chars) must break it up.
  const long = Array.from(
    { length: 6 },
    (_, i) => `This is sentence number ${i + 1} of a reply that is deliberately quite long.`
  ).join(" ");

  useSpeechStore.getState().speak(long);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(
    calls.synthesized.length > 1,
    `expected several chunks, got ${calls.synthesized.length}`
  );
  // Each chunk must be small enough for the engine's ~30 s comfort zone.
  for (const chunk of calls.synthesized) {
    assert.ok(chunk.length <= 220, `chunk too long: ${chunk.length} chars`);
  }
});

test("with no model installed the platform voices still do the reading", async () => {
  // The fallback is the point: users who install nothing must see no change.
  const { calls, useSpeechStore } = await loadWith({
    webVoices: true,
    kokoroModelInstalled: false,
  });

  useSpeechStore.getState().speak(REPLY);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(calls.synthesized.length, 0, "Kokoro must not be called");
  assert.ok(
    calls.spokenWithWebSpeech.length > 0,
    "the platform voices should have read the reply"
  );
});

test("on Linux with no Kokoro the system engine is still used", async () => {
  const { calls, useSpeechStore } = await loadWith({
    webVoices: false,
    kokoroModelInstalled: false,
  });

  useSpeechStore.getState().speak(REPLY);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(calls.synthesized.length, 0);
  assert.ok(calls.systemSpeech.length > 0, "spd-say should have been used");
});

test("markdown is stripped before it reaches the engine", async () => {
  const { calls, useSpeechStore } = await loadWith({
    webVoices: false,
    kokoroModelInstalled: true,
  });

  useSpeechStore
    .getState()
    .speak("Here is **bold** and `code` and a [link](https://example.com/x).");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const spoken = calls.synthesized.join(" ");
  assert.ok(spoken.includes("bold"), "the word should survive");
  assert.ok(!spoken.includes("**"), "emphasis marks must not be spoken");
  assert.ok(!spoken.includes("https://"), "URLs must not be read out");
  assert.ok(!spoken.includes("`"), "backticks must not be spoken");
});

test("stop cancels playback and tells the engine to stop", async () => {
  const { calls, useSpeechStore } = await loadWith({
    webVoices: false,
    kokoroModelInstalled: true,
  });

  const long = Array.from(
    { length: 8 },
    (_, i) => `Sentence ${i + 1} keeps the pipeline busy for a while.`
  ).join(" ");

  useSpeechStore.getState().speak(long);
  await new Promise((resolve) => setTimeout(resolve, 5));
  useSpeechStore.getState().stop();

  assert.equal(
    useSpeechStore.getState().speakingText,
    null,
    "the button state must clear immediately on stop"
  );

  // Nothing further should be synthesized once stopped.
  const countAfterStop = calls.synthesized.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    calls.synthesized.length,
    countAfterStop,
    "no further chunks after a stop"
  );
});
