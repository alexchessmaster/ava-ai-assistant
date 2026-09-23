// Running local commands on the assistant's behalf, from the main process.
//
// Authorization lives in ./commandAllowlist (pure, unit-tested); this file is
// the half that touches the disk, the user, and the OS. The user's alias file
// is the switch: without it the feature is off, including the confirmation
// path, so deleting one file turns the whole thing off.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { BrowserWindow, dialog, shell } = require("electron");

const {
  describeAliases,
  firstToken,
  needsExecutableCheck,
  parseCommandsFile,
  resolveCommand,
  sanitizeApproved,
  usesShellSyntax,
} = require("./commandAllowlist");

let debugLogger = null;
function log() {
  if (!debugLogger) debugLogger = require("./debugLogger");
  return debugLogger;
}

const COMMANDS_FILE = "commands.txt";
const APPROVED_FILE = "approved-commands.json";
const PROBE_TIMEOUT_MS = 2000;
// How long a command whose output was asked for may take before it is stopped
// and whatever it printed so far is reported. It also has to stay well inside
// the model request's own deadline, since the tool call is awaited.
const CAPTURE_TIMEOUT_MS = 10_000;
// A command that prints without end would otherwise grow the reply the model
// reads, so the text is cut off here.
const MAX_CAPTURE_BYTES = 16 * 1024;
const DIALOG_ACTIONS = { run: 0, remember: 1, cancel: 2 };
// A model that keeps proposing commands would otherwise walk the user through
// up to MAX_TOOL_STEPS dialogs in a single turn (tool calls run one after the
// other, so the in-flight guard below does not catch that).
const MAX_PROMPTS_PER_WINDOW = 5;
const PROMPT_WINDOW_MS = 60_000;

const defaultConfigDir = () => path.join(os.homedir(), ".openwhispr");

/**
 * Directories a desktop-launched app is typically missing but the user's
 * commands live in. macOS is the acute case: a Finder-launched app inherits
 * launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, which does not contain the Homebrew
 * or `/usr/local` shims that `code` and friends install — the exact command
 * this feature exists for. Used for the probe AND the launch, so what was
 * checked is what runs.
 */
function searchPath(env = process.env) {
  if (process.platform === "win32") return env.PATH;
  const extras = [
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), "bin"),
    path.join(os.homedir(), ".cargo", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/snap/bin",
  ].filter((dir) => !(env.PATH || "").split(path.delimiter).includes(dir));
  return [...extras, env.PATH].filter(Boolean).join(path.delimiter);
}

function spawnEnv() {
  return { ...process.env, PATH: searchPath() };
}

/**
 * The names the assistant may ask for, for the tool description. Names only:
 * the values are the user's own commands and URLs, and the description travels
 * to whatever model they have configured, so those never leave the machine.
 */
function listAliasNames(dir) {
  const aliases = readAliases(dir);
  if (!aliases) return [];
  return [...new Set(aliases.flatMap((entry) => entry.names))];
}

/**
 * The user's aliases, or null when the feature is off. A missing file means
 * off; an unreadable one means off too, because failing closed is the only
 * safe reading of "I cannot tell what is allowed".
 */
function readAliases(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, COMMANDS_FILE), "utf-8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      log().warn("Could not read the commands file", { error: error.message }, "commands");
    }
    return null;
  }
  return parseCommandsFile(text);
}

function readApproved(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, APPROVED_FILE), "utf-8"));
    return sanitizeApproved(raw);
  } catch {
    // Absent or corrupt: no approvals, which is the conservative reading.
    return [];
  }
}

function rememberApproved(dir, command, capture = false) {
  // One entry per command, latest wins: the same text approved once with output
  // and once without would otherwise resolve by whichever came first.
  const approved = readApproved(dir).filter((entry) => entry.command !== command);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, APPROVED_FILE),
      JSON.stringify([...approved, { command, capture }], null, 2),
      "utf-8"
    );
  } catch (error) {
    log().warn("Could not save an approved command", { error: error.message }, "commands");
  }
}

/**
 * Whether the first token of a command resolves — null when it does or when the
 * question cannot be answered, otherwise the missing token.
 *
 * Asks the shell rather than `which`: `command -v` resolves the shell's own
 * builtins too (`cd`, `eval`), so nothing has to be enumerated for the lookup to
 * be right, and it is the same resolution the launch will use.
 */
function missingExecutable(command, env) {
  const token = firstToken(command);
  if (!needsExecutableCheck(token)) return null;
  // `where` cannot see everything cmd.exe resolves (App Paths, ShellExecute,
  // its own builtins), so on Windows a miss would be a false negative that
  // blocks a command that works. The dialog is the gate there, not this.
  if (process.platform === "win32") return null;

  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", token],
      { env, timeout: PROBE_TIMEOUT_MS },
      (error) => {
        if (!error) return resolve(null);
        // ENOENT here means the shell itself is missing, not the command; with
        // no way to tell, let the command run rather than block a valid alias.
        if (error.code === "ENOENT") return resolve(null);
        resolve(token);
      }
    );
  });
}

/** Launch detached so a window the user just opened outlives this app. */
function launch(command, env) {
  const child = spawn(command, {
    shell: true,
    detached: true,
    stdio: "ignore",
    // Without this the child inherits the app's cwd — `/` for a packaged
    // macOS launch — so `code .` would open the filesystem root.
    cwd: os.homedir(),
    // The same PATH the pre-flight looked in, so what was checked is what runs.
    env,
    windowsHide: true,
  });
  // A detached child with piped stdio would either hold the app open or get
  // its pipes destroyed under it, so there is no output to report back.
  child.on("error", (error) => {
    log().warn("Failed to launch a command", { error: error.message }, "commands");
  });
  child.unref();
}

/**
 * End the whole process group. `shell: true` makes the child a shell, and the
 * command it ran is a further process, so signalling the child alone would
 * leave the real work behind. Detaching is what makes the group addressable —
 * which is why capture spawns detached as well.
 */
function killGroup(child) {
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    log().warn("Could not stop a command", { error: error.message }, "commands");
  }
}

/**
 * Run a command and wait for what it prints.
 *
 * `launch` deliberately walks away; this is the opposite, because the user
 * asked to see the result. Waiting needs a way out in both directions: the text
 * is capped, so a command that prints forever cannot grow the reply, and the
 * wait has a deadline, so a command that never exits (`tail -f`, a `top`, or a
 * GUI app marked `!` by mistake) is stopped rather than left holding the pipes
 * — with `close` never firing, the alternative is a tool call that hangs until
 * the whole request times out.
 *
 * @returns {Promise<{output: string, exitCode: number|null, timedOut: boolean, truncated: boolean, error?: string}>}
 */
function capture(command, env, timeoutMs = CAPTURE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: os.homedir(),
      env,
      windowsHide: true,
    });

    let output = "";
    let truncated = false;
    let settled = false;

    const collect = (chunk) => {
      if (truncated) return;
      output += chunk.toString();
      if (output.length > MAX_CAPTURE_BYTES) {
        output = output.slice(0, MAX_CAPTURE_BYTES);
        truncated = true;
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killGroup(child);
      finish({ output, exitCode: null, timedOut: true, truncated });
    }, timeoutMs);

    child.on("error", (error) => {
      log().warn("Failed to run a command", { error: error.message }, "commands");
      finish({ output, exitCode: null, timedOut: false, truncated, error: error.message });
    });
    child.on("close", (code) => finish({ output, exitCode: code, timedOut: false, truncated }));
  });
}

/**
 * Launch, or run and read back, and say which happened.
 *
 * @returns {Promise<{ok: boolean, message: string, capture?: object}>}
 */
async function runCommand(command, env, readOutput, timeoutMs = CAPTURE_TIMEOUT_MS) {
  if (!readOutput) {
    launch(command, env);
    return { ok: true, message: `Launched \`${command}\`.` };
  }

  const result = await capture(command, env, timeoutMs);
  if (result.error) {
    return { ok: false, message: `Could not run \`${command}\`: ${result.error}` };
  }

  // The message is read by the assistant as well as shown in the card, so it
  // never claims more than happened: no output is reported as no output.
  const how = result.timedOut
    ? `Stopped \`${command}\` after ${timeoutMs / 1000}s`
    : result.exitCode
      ? `\`${command}\` exited with code ${result.exitCode}`
      : `Ran \`${command}\``;
  const message = result.output.trim()
    ? `${how}:`
    : `${how}${result.timedOut ? " — nothing was printed." : ", and it printed nothing."}`;
  return { ok: true, message, capture: result };
}

// One confirmation at a time: the same await cannot be answered twice.
let confirmationPending = false;
let promptTimes = [];

/**
 * The window to make the dialog modal to, or null to show it standalone.
 * Standalone is the fallback because the dictation overlay is created
 * `focusable: false` on some Linux compositors and cannot be made focusable
 * again, and a modal owned by an unfocusable window risks a prompt the user
 * cannot click — which for a security prompt would strand the command.
 */
function dialogParent(sender) {
  const parent = sender ? BrowserWindow.fromWebContents(sender) : null;
  if (parent && !parent.isDestroyed() && parent.isFocusable()) return parent;
  return null;
}

async function confirm(command, { sender, dir, names }) {
  const options = {
    type: "warning",
    title: "Run this command?",
    // The exact string, and nothing the model wrote above it: the user is
    // approving this text, so no explanation may sit between them and it. (The
    // assistant's own rationale belongs in the chat, at the same trust level as
    // everything else it says.)
    message: command,
    detail:
      "The assistant proposed this command. Nothing has run yet.\n\n" +
      // A local model is easy to confuse, and shell syntax is where a confused
      // one does damage: say so, rather than letting the user skim past a `|`.
      (usesShellSyntax(command)
        ? "This one uses shell operators (|, ;, $, >), so it is more than " +
          "starting a program — read it before running it.\n\n"
        : "") +
      `"Run and remember" saves the exact command to ${path.join(
        dir,
        APPROVED_FILE
      )} so it will not ask again.` +
      (names ? `\n\nYour registered commands: ${names}` : ""),
    buttons: ["Run", "Run and remember", "Cancel"],
    // Off by default: reading output means waiting on the command, which is
    // wrong for the usual case (an app that stays open). This is not something
    // the model may choose — it is the user's, here, or a `!` in their file.
    checkboxLabel: "Show me the output",
    checkboxChecked: false,
    defaultId: DIALOG_ACTIONS.cancel,
    cancelId: DIALOG_ACTIONS.cancel,
    noLink: true,
  };

  const parent = dialogParent(sender);
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return { response: result.response, capture: result.checkboxChecked === true };
}

function disabledMessage(dir) {
  return (
    `Running commands is off. Create ${path.join(dir, COMMANDS_FILE)} with one alias per line, ` +
    `like "vscode = code", and the assistant can launch it by name.`
  );
}

function refusalFor(reason, detail) {
  switch (reason) {
    case "destructive":
      // Not approvable, by design: the dialog is for commands the user can
      // judge, and this list is the handful nobody should have to.
      return `Refused — that command ${detail}, so it is not run and cannot be approved.`;
    case "unsafe-text":
      return "That command spans more than one line, so it cannot be approved. Nothing was run.";
    case "too-long":
      return "That command is too long to approve. Nothing was run.";
    default:
      return "No command was given.";
  }
}

function promptBudgetSpent(now) {
  promptTimes = promptTimes.filter((time) => now - time < PROMPT_WINDOW_MS);
  return promptTimes.length >= MAX_PROMPTS_PER_WINDOW;
}

/**
 * The whole request: authorize, ask if needed, launch.
 *
 * @param {string} request
 * @param {{sender?: object, dir?: string, now?: number}} [options] `sender`
 *   parents the confirmation to the window that asked; `dir` and `now` exist so
 *   tests never touch the developer's real config directory or wall clock.
 * @returns {Promise<{ok: boolean, message: string, capture?: object}>}
 *   `message` is shown to the user in the tool card AND read by the assistant,
 *   so it says what happened and nothing more. `capture` carries what the
 *   command printed, when the user asked for it.
 */
async function requestRun(
  request,
  {
    sender = null,
    dir = defaultConfigDir(),
    now = Date.now(),
    captureTimeoutMs = CAPTURE_TIMEOUT_MS,
  } = {}
) {
  const aliases = readAliases(dir);
  if (aliases === null) return { ok: false, message: disabledMessage(dir) };

  const verdict = resolveCommand({ request, aliases, approved: readApproved(dir) });
  if (verdict.verdict === "reject") {
    return { ok: false, message: refusalFor(verdict.reason, verdict.detail) };
  }

  if (verdict.verdict === "open") {
    // A URL alias: the link is the user's own text and the query was
    // URL-encoded into it, so nothing here reaches a shell. No dialog — opening
    // a link is the one thing this tool does that cannot damage anything.
    if (!/^https?:\/\//i.test(verdict.url)) {
      return { ok: false, message: "Refused — that is not an http(s) link." };
    }
    try {
      await shell.openExternal(verdict.url);
    } catch (error) {
      log().warn("Could not open a URL", { error: error.message }, "commands");
      return { ok: false, message: `Could not open the browser: ${error.message}` };
    }
    log().info("Opened a URL", { alias: verdict.alias }, "commands");
    return {
      ok: true,
      message: verdict.query
        ? `Searched ${verdict.alias} for "${verdict.query}".`
        : `Opened ${verdict.alias}.`,
    };
  }

  const env = spawnEnv();

  if (verdict.verdict === "allow") {
    const missing = await missingExecutable(verdict.command, env);
    if (missing) {
      return { ok: false, message: `"${missing}" is not installed (not found on PATH).` };
    }
    const result = await runCommand(
      verdict.command,
      env,
      verdict.capture === true,
      captureTimeoutMs
    );
    log().info(
      "Ran a command",
      { source: verdict.source, capture: verdict.capture === true },
      "commands"
    );
    return result;
  }

  // Not authorized yet. A program that is not installed is not worth a dialog;
  // refusing here also tells the assistant which names the user registered, so
  // it can retry with one of those instead.
  const missing = await missingExecutable(verdict.command, env);
  if (missing) {
    const names = describeAliases(aliases);
    return {
      ok: false,
      message:
        `"${missing}" is not installed (not found on PATH).` +
        (names ? ` The user's registered commands are: ${names}.` : ""),
    };
  }

  if (confirmationPending) {
    return { ok: false, message: "Another command is already waiting to be approved." };
  }
  if (promptBudgetSpent(now)) {
    return {
      ok: false,
      message: `Too many commands proposed in a row. Nothing was run — ask the user to run it themselves.`,
    };
  }

  confirmationPending = true;
  let answer;
  try {
    promptTimes.push(now);
    answer = await confirm(verdict.command, {
      sender,
      dir,
      names: describeAliases(aliases),
    });
  } finally {
    confirmationPending = false;
  }

  const { response, capture: readOutput } = answer;
  if (response === DIALOG_ACTIONS.cancel) {
    return { ok: false, message: "Declined — nothing was run." };
  }

  if (response === DIALOG_ACTIONS.remember) {
    rememberApproved(dir, verdict.command, readOutput);
  }

  const result = await runCommand(verdict.command, env, readOutput, captureTimeoutMs);
  log().info(
    "Ran a confirmed command",
    { remembered: response === DIALOG_ACTIONS.remember, capture: readOutput },
    "commands"
  );
  return result;
}

module.exports = {
  listAliasNames,
  requestRun,
  searchPath,
};
