const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const Module = require("node:module");

// Drives the real systemSpeech with electron and child_process stubbed. What is
// pinned here is the process hygiene, not the audio: this module spawns a CLI it
// does not control, and the failure mode is silent — a `spd-say` that never
// returns pins a core for as long as the machine is up, and nothing in the app
// notices. That is exactly what shipped once (twelve of them), so the two ways
// it happened are asserted below.
const modulePath = require.resolve("../../src/helpers/systemSpeech");

const originalLoad = Module._load;
const originalPlatform = process.platform;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;

let spawnCalls = [];
let execFileCalls = [];
let children = [];
let scheduled = [];
let cleared = [];

// isAvailable() only probes on Linux; read the platform as Linux so the tests
// mean the same thing on every machine.
Object.defineProperty(process, "platform", { value: "linux", configurable: true });

function makeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.signals = [];
  child.kill = (signal) => {
    child.killed = true;
    child.signals.push(signal ?? "SIGTERM");
    return true;
  };
  child.unref = () => {};
  children.push(child);
  return child;
}

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") {
    // isReady() false keeps debugLogger off the filesystem entirely.
    return { app: { isReady: () => false, getPath: () => "/tmp", getVersion: () => "0" } };
  }
  if (request === "child_process") {
    return {
      // The availability probe: the daemon answers, so the module proceeds.
      execFileSync: () => Buffer.from("espeak-ng\n"),
      execFile: (file, args, options, callback) => {
        execFileCalls.push({ file, args, options });
        callback?.();
        return makeChild();
      },
      spawn: (file, args) => {
        spawnCalls.push({ file, args });
        return makeChild();
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// modulePath is required after the patch, so the module sees the stubs.
const speech = require(modulePath);

function withCapturedTimers(run) {
  scheduled = [];
  cleared = [];
  global.setTimeout = (fn, ms) => {
    const handle = { unref: () => {} };
    scheduled.push({ fn, ms, handle });
    return handle;
  };
  global.clearTimeout = (handle) => cleared.push(handle);
  try {
    return run();
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
}

test.after(() => {
  Module._load = originalLoad;
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

test("stop cancels the daemon with -C, never -S", () => {
  execFileCalls = [];
  speech.stop();

  assert.equal(execFileCalls.length, 1, "one stop request");
  const [call] = execFileCalls;
  assert.equal(call.file, "spd-say");
  assert.deepEqual(
    call.args,
    ["-C"],
    "-S is measured to never return when nothing is playing, and this runs before every utterance"
  );
});

test("stop bounds the child it spawns", () => {
  execFileCalls = [];
  speech.stop();

  const { options } = execFileCalls[0];
  assert.ok(options.timeout > 0, "a stop that hangs must not outlive the app");
  assert.equal(options.killSignal, "SIGKILL");
  assert.equal(options.stdio, "ignore");
});

test("a speaking child is still waited on, and carries a deadline", () => {
  spawnCalls = [];
  withCapturedTimers(() => speech.speak("hello there", { onEnded: () => {} }));

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].file, "spd-say");
  assert.equal(spawnCalls[0].args[0], "-w", "the only completion signal the CLI offers");
  assert.equal(scheduled.length, 1, "an utterance that never ends must not run forever");
  assert.ok(scheduled[0].ms >= 30000, "generous enough to never cut a real passage short");
});

test("a longer passage gets a longer deadline", () => {
  withCapturedTimers(() => speech.speak("short", { onEnded: () => {} }));
  const shortMs = scheduled[0].ms;

  withCapturedTimers(() => speech.speak("x".repeat(400), { onEnded: () => {} }));
  const longMs = scheduled[0].ms;

  assert.ok(longMs > shortMs, "the deadline follows the length of the utterance");
});

test("a child that outlives its utterance is killed", () => {
  withCapturedTimers(() => speech.speak("stuck", { onEnded: () => {} }));
  const child = children[children.length - 1];

  assert.deepEqual(child.signals, [], "not killed while it is still speaking");
  scheduled[0].fn();
  assert.deepEqual(child.signals, ["SIGKILL"]);
});

test("a child that finishes on its own is not killed afterwards", () => {
  let ended = 0;
  // The close lands inside the window, so the disarming is the module's own.
  withCapturedTimers(() => {
    speech.speak("done", { onEnded: () => ended++ });
    children[children.length - 1].emit("close");
  });
  const child = children[children.length - 1];

  assert.equal(ended, 1, "completion reaches the renderer");
  assert.deepEqual(child.signals, []);
  assert.deepEqual(cleared, [scheduled[0].handle], "the deadline is disarmed, not left armed");
});
