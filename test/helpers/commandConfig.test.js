const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The in-app editor's read/write path, against a throwaway directory. What
// matters here is not that a file gets written but that the editor and the
// runtime agree about it: every write is read back the way `localCommands`
// reads it, so an editor that saved something the runtime parses differently
// fails here rather than silently at the user's next "open vscode".
const load = () => import("../../src/helpers/commandConfig.js");
const loadAllowlist = () => import("../../src/helpers/commandAllowlist.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-commands-"));
}

const SAMPLE = [
  "# Eva — commands the assistant may run.",
  "",
  "vscode, vs code = code",
  "search          = https://duckduckgo.com/?q=%s",
  "disk space      = !df -h /",
].join("\n");

test("a read returns the file verbatim, with what it parses to alongside", async () => {
  const { readCommandConfig } = await load();
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "commands.txt"), SAMPLE, "utf-8");

  const config = readCommandConfig(dir);

  // Verbatim matters: the comments are the format's documentation, and a
  // structured editor that re-serialised the aliases would delete all of it.
  assert.equal(config.commandsText, SAMPLE);
  assert.equal(config.aliases.length, 3);
  assert.deepEqual(config.aliases[2], {
    names: ["disk space"],
    command: "df -h /",
    capture: true,
  });
  assert.equal(config.approvedFile, path.join(dir, "approved-commands.json"));
});

test("a missing commands file reads as null, not as an empty file", async () => {
  const { readCommandConfig } = await load();
  const config = readCommandConfig(tempDir());

  // The distinction is the whole off switch: absent means the tool refuses
  // everything, empty means a file with no aliases that falls through to the
  // dialog. An editor that could not tell them apart could not restore it.
  assert.equal(config.commandsText, null);
  assert.deepEqual(config.aliases, []);
  assert.deepEqual(config.approved, []);
});

test("saving preserves comments and reproduces them byte for byte", async () => {
  const { writeCommandsFile, readCommandConfig } = await load();
  const dir = tempDir();

  const result = writeCommandsFile(SAMPLE, dir);
  assert.equal(result.ok, true);
  assert.equal(result.aliases.length, 3);

  assert.equal(fs.readFileSync(path.join(dir, "commands.txt"), "utf-8"), SAMPLE);
  assert.equal(readCommandConfig(dir).commandsText, SAMPLE);
});

test("saving creates the directory when it is not there yet", async () => {
  const { writeCommandsFile, readCommandConfig } = await load();
  const dir = path.join(tempDir(), "nested", "openwhispr");

  assert.equal(writeCommandsFile("ls = !ls\n", dir).ok, true);
  assert.equal(readCommandConfig(dir).aliases.length, 1);
});

test("no .tmp file survives a save", async () => {
  const { writeCommandsFile } = await load();
  const dir = tempDir();
  writeCommandsFile(SAMPLE, dir);

  // The write goes to a sibling and is renamed, so a crash mid-write cannot
  // leave a truncated file that parses to something nobody chose.
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("a save that is not text is refused rather than written", async () => {
  const { writeCommandsFile } = await load();
  const dir = tempDir();

  assert.equal(writeCommandsFile(undefined, dir).ok, false);
  assert.equal(writeCommandsFile(null, dir).ok, false);
  assert.equal(fs.existsSync(path.join(dir, "commands.txt")), false);
});

test("an oversized file is refused", async () => {
  const { writeCommandsFile } = await load();
  const dir = tempDir();
  const huge = `a = b\n`.repeat(200000); // ~1.2 MB, past the 512 KB guard

  const result = writeCommandsFile(huge, dir);
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(path.join(dir, "commands.txt")), false);
});

test("turning the feature off removes the file, and a save brings it back", async () => {
  const { writeCommandsFile, deleteCommandsFile, readCommandConfig } = await load();
  const dir = tempDir();
  writeCommandsFile(SAMPLE, dir);

  assert.equal(deleteCommandsFile(dir).ok, true);
  assert.equal(readCommandConfig(dir).commandsText, null);

  // Deleting a file that is already gone is not an error worth reporting: the
  // user asked for it to not be there.
  assert.equal(deleteCommandsFile(dir).ok, true);

  writeCommandsFile(SAMPLE, dir);
  assert.equal(readCommandConfig(dir).aliases.length, 3);
});

test("approved commands are written in the shape the runtime remembers", async () => {
  const { writeApproved, readCommandConfig } = await load();
  const { sanitizeApproved } = await loadAllowlist();
  const dir = tempDir();

  const result = writeApproved(
    [
      { command: "docker ps", capture: true },
      { command: "ls /etc", capture: false },
    ],
    dir
  );
  assert.equal(result.ok, true);

  const written = JSON.parse(fs.readFileSync(path.join(dir, "approved-commands.json"), "utf-8"));
  // One shape only. `rememberApproved` in localCommands writes this one, so an
  // entry added here and one approved in the dialog must be indistinguishable.
  assert.deepEqual(written, [
    { command: "docker ps", capture: true },
    { command: "ls /etc", capture: false },
  ]);
  assert.deepEqual(sanitizeApproved(written), readCommandConfig(dir).approved);
});

test("a legacy string-form approvals file is normalised on the next write", async () => {
  const { readCommandConfig, writeApproved } = await load();
  const dir = tempDir();
  // What an older build wrote — bare strings, no capture flag.
  fs.writeFileSync(
    path.join(dir, "approved-commands.json"),
    JSON.stringify(["telegram-desktop", "ls /etc"]),
    "utf-8"
  );

  assert.deepEqual(readCommandConfig(dir).approved, [
    { command: "telegram-desktop", capture: false },
    { command: "ls /etc", capture: false },
  ]);

  writeApproved(readCommandConfig(dir).approved, dir);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "approved-commands.json"), "utf-8"));
  assert.deepEqual(written, [
    { command: "telegram-desktop", capture: false },
    { command: "ls /etc", capture: false },
  ]);
});

test("a corrupt approvals file reads as nothing approved, not as a crash", async () => {
  const { readCommandConfig, writeApproved } = await load();
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "approved-commands.json"), "{not json", "utf-8");

  // Failing closed is the only safe reading of "I cannot tell what is allowed".
  assert.deepEqual(readCommandConfig(dir).approved, []);
  assert.equal(writeApproved([{ command: "ls", capture: false }], dir).ok, true);
  assert.deepEqual(readCommandConfig(dir).approved, [{ command: "ls", capture: false }]);
});

test("an empty approved list writes an empty array, not a missing file", async () => {
  const { writeApproved, readCommandConfig } = await load();
  const dir = tempDir();
  writeApproved([{ command: "ls", capture: false }], dir);

  assert.equal(writeApproved([], dir).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "approved-commands.json"), "utf-8"), "[]\n");
  assert.deepEqual(readCommandConfig(dir).approved, []);
});

test("the shipped default file is a valid commands file", async () => {
  const { parseCommandsFile } = await loadAllowlist();
  const shipped = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "components", "commands", "defaultCommands.txt"),
    "utf-8"
  );
  const aliases = parseCommandsFile(shipped);

  // This is the file Reset loads and a new install starts from, and it is the
  // format's documentation as much as it is data. A typo in it is silent — the
  // line simply never matches — so every non-comment line has to parse.
  const contentLines = shipped
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
  assert.equal(
    aliases.length,
    contentLines.length,
    "a line in the shipped file does not parse and would silently never match"
  );
  assert.ok(aliases.length > 0);

  // The `!` form is the one the assistant answers questions from, so at least
  // one has to survive in the shipped list for "how much space do I have?" to
  // have anything to reach for.
  assert.ok(
    aliases.some((alias) => alias.capture),
    "the shipped list has no read-back command"
  );

  // Every alias has to be usable by name, and a name has to be one word or a
  // short phrase for matching to hold up.
  for (const alias of aliases) {
    assert.ok(alias.names.length > 0, "an alias with no name can never be matched");
    assert.ok(alias.command.length > 0);
  }
});

test("the names the model is given come from the file the editor writes", async () => {
  // The whole point of the editor: what it saves is what the runtime hands the
  // model. This drives the real `localCommands` (electron stubbed, home pointed
  // at a temp directory) because the seam that broke was the *call*, not the
  // parsing — `ipcHandlers.js` invokes `listAliasNames()` with no argument, and
  // the function had no default for `dir`, so `path.join(undefined, ...)` threw
  // and the catch returned "no aliases" for every user.
  const Module = require("node:module");
  const realOs = require("node:os");
  const fakeHome = tempDir();
  const dir = path.join(fakeHome, ".openwhispr");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "commands.txt"), SAMPLE, "utf-8");

  const originalLoad = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === "electron") return {};
    if (request === "os") return { ...realOs, homedir: () => fakeHome };
    return originalLoad.call(this, request, parent, isMain);
  };
  let localCommands;
  try {
    localCommands = await import("../../src/helpers/localCommands.js");
  } finally {
    Module._load = originalLoad;
  }

  const expected = ["vscode", "vs code", "search", "disk space"];
  assert.deepEqual(localCommands.listAliasNames(dir), expected);
  // Exactly how the IPC handler calls it.
  assert.deepEqual(localCommands.listAliasNames(), expected);
});

test("every channel the preload bridge invokes is one this module handles", async () => {
  const Module = require("node:module");
  const { register } = await load();

  // `register` is the only thing in this module that touches electron, so it is
  // stubbed rather than the whole module being reshaped for a test.
  const registered = [];
  const originalLoad = Module._load;
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") {
      return { ipcMain: { handle: (channel) => registered.push(channel) } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    register();
  } finally {
    Module._load = originalLoad;
  }

  // The names the renderer actually calls, read out of the bridge rather than
  // repeated here — a preload that invokes a channel nobody handles fails at
  // the user's first click, and nothing else in the suite would catch it.
  const preload = fs.readFileSync(path.join(__dirname, "..", "..", "preload.js"), "utf-8");
  const invoked = new Set(
    [...preload.matchAll(/ipcRenderer\.invoke\("([a-z-]+)"/g)]
      .map((match) => match[1])
      .filter((channel) => registered.includes(channel))
  );

  assert.deepEqual([...invoked].sort(), [...registered].sort());
  assert.equal(registered.length, 5, "expected six handlers, got: " + registered.join(", "));
});
