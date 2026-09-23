// The assistant's two command files, read and written for the in-app editor.
//
// `localCommands.js` is the runtime: it reads both files on every request and
// decides what may run. This module is the other half — the same two files,
// read and written for a human editing them in the main window. It does not
// decide anything about authorization; `commandAllowlist.js` still owns that,
// and nothing here can widen it. All this file can change is *what the user has
// allowed*, which is the user's own call to make.
//
// Two shapes, deliberately different:
//
//   - `commands.txt` is stored and returned **verbatim**. The shipped file is
//     mostly comments, and they are the documentation — a structured editor
//     that re-serialised the parsed aliases would silently delete all of it.
//     So the editor edits the file, and the parse happens alongside only to
//     report what the runtime will actually understand.
//   - `approved-commands.json` is a generated file with nothing to preserve, so
//     it is edited as a list. Written in the `{command, capture}` shape that
//     `rememberApproved` uses, so a command approved in the dialog and one
//     added here are indistinguishable to the runtime.

const fs = require("fs");
const path = require("path");

const { parseCommandsFile, sanitizeApproved } = require("./commandAllowlist");

const COMMANDS_FILE = "commands.txt";
const APPROVED_FILE = "approved-commands.json";
// A guard against a pathological paste rather than a limit anyone should meet:
// the shipped file is about 5 KB.
const MAX_COMMANDS_BYTES = 512 * 1024;
// The list is written by the app and grows one approval at a time. This only
// stops a hand-edited or corrupt file from being echoed back forever.
const MAX_APPROVED_ENTRIES = 500;

/**
 * Resolved lazily so this module never pulls `electron` in at load. The readers
 * and writers below take `dir` explicitly, which is what keeps them testable
 * against a throwaway directory — the same reason `localCommands.requestRun`
 * takes one.
 */
function defaultConfigDir() {
  return require("./localCommands").defaultConfigDir();
}

function getPaths(dir = defaultConfigDir()) {
  return {
    dir,
    commandsFile: path.join(dir, COMMANDS_FILE),
    approvedFile: path.join(dir, APPROVED_FILE),
  };
}

/**
 * Written to a sibling and renamed. A crash or a full disk mid-write then
 * leaves the previous file intact, rather than a truncated one that parses to
 * something the user never chose — which for the alias file silently changes
 * which commands run without asking.
 */
function writeAtomic(file, text) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, text, "utf-8");
  fs.renameSync(temp, file);
}

/**
 * Both files as the editor sees them.
 *
 * `commandsText` is `null` — not `""` — when the file is absent, because absent
 * is not an empty file: it is the switch that turns the whole feature off, and
 * the editor has to be able to show that and put it back. The distinction is
 * `localCommands.readAliases`'s too; an empty file is a file with no aliases.
 */
function readCommandConfig(dir = defaultConfigDir()) {
  const paths = getPaths(dir);

  let commandsText = null;
  try {
    commandsText = fs.readFileSync(paths.commandsFile, "utf-8");
  } catch {
    // Missing or unreadable: both mean "not configured".
  }

  let approvedRaw = null;
  try {
    approvedRaw = JSON.parse(fs.readFileSync(paths.approvedFile, "utf-8"));
  } catch {
    // Absent or corrupt. `sanitizeApproved(null)` is [] — the conservative
    // reading, and the same one the runtime takes.
  }

  return {
    ...paths,
    commandsText,
    // What the runtime will make of it, so the editor can say "14 commands"
    // rather than leaving the user to guess whether a line parsed.
    aliases: commandsText === null ? [] : parseCommandsFile(commandsText),
    approved: sanitizeApproved(approvedRaw),
  };
}

function writeCommandsFile(text, dir = defaultConfigDir()) {
  if (typeof text !== "string") {
    return { ok: false, error: "Nothing to save." };
  }
  if (Buffer.byteLength(text, "utf-8") > MAX_COMMANDS_BYTES) {
    return { ok: false, error: "That file is too large to save." };
  }

  const paths = getPaths(dir);
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    writeAtomic(paths.commandsFile, text);
  } catch (error) {
    return { ok: false, error: `Could not save: ${error.message}` };
  }

  return { ok: true, aliases: parseCommandsFile(text) };
}

/**
 * Removes the alias file, which is how the feature is turned off: no file means
 * the tool refuses everything, the approval dialog included. An empty file is
 * *not* the same thing — it is a file with no aliases, so every request would
 * still reach the dialog. The editor offers this as a separate, confirmed
 * action for exactly that reason.
 */
function deleteCommandsFile(dir = defaultConfigDir()) {
  const paths = getPaths(dir);
  try {
    fs.rmSync(paths.commandsFile, { force: true });
  } catch (error) {
    return { ok: false, error: `Could not remove it: ${error.message}` };
  }
  return { ok: true };
}

function writeApproved(list, dir = defaultConfigDir()) {
  const entries = sanitizeApproved(list).slice(0, MAX_APPROVED_ENTRIES);
  const paths = getPaths(dir);
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    writeAtomic(paths.approvedFile, `${JSON.stringify(entries, null, 2)}\n`);
  } catch (error) {
    return { ok: false, error: `Could not save: ${error.message}` };
  }
  return { ok: true, approved: entries };
}

/**
 * Shows the file in the OS file manager, or its directory when it does not
 * exist yet — `showItemInFolder` on a missing path does nothing at all, which
 * reads as a dead button.
 */
function revealConfigFile(which, dir = defaultConfigDir()) {
  const paths = getPaths(dir);
  const file = which === "approved" ? paths.approvedFile : paths.commandsFile;
  const { shell } = require("electron");

  if (fs.existsSync(file)) {
    shell.showItemInFolder(file);
    return { ok: true };
  }
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    shell.openPath(paths.dir);
  } catch (error) {
    return { ok: false, error: `Could not open the folder: ${error.message}` };
  }
  return { ok: true };
}

/**
 * Registers the channels the Commands view uses. Kept in this module, with one
 * `require` in `main.js`, so this fork's IPC stays out of `ipcHandlers.js` —
 * the same seam `kokoroIpc.js` uses.
 */
function register() {
  const { ipcMain } = require("electron");

  // The editor never passes a path in: the main process resolves the directory
  // itself, so a renderer cannot point these writers at an arbitrary file.
  ipcMain.handle("get-command-config", () => readCommandConfig());
  ipcMain.handle("save-commands-file", (_event, text) => writeCommandsFile(text));
  ipcMain.handle("delete-commands-file", () => deleteCommandsFile());
  ipcMain.handle("save-approved-commands", (_event, list) => writeApproved(list));
  ipcMain.handle("reveal-command-config", (_event, which) => revealConfigFile(which));
}

module.exports = {
  getPaths,
  readCommandConfig,
  writeCommandsFile,
  deleteCommandsFile,
  writeApproved,
  revealConfigFile,
  register,
};
