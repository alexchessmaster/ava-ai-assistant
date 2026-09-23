// Assistant-run command policy.
//
// The assistant can launch local programs, so every request has to be
// authorized before it reaches a shell. There are three answers, in this order:
//
//   1. Refuse. A handful of commands that destroy a machine outright are never
//      run and can never be approved. See DESTRUCTIVE_COMMANDS.
//   2. Allow. The user's own alias list, and anything they have remembered,
//      runs with no prompt.
//   3. Confirm. Everything else needs a dialog showing the user the exact
//      string, which the model cannot fabricate or write over.
//
// Kept Electron-free so the decision the whole feature rests on is unit-tested
// (test/helpers/commandAllowlist.test.js) — same split as dockPolicy.js.
//
// One property worth preserving: the string that actually gets executed is
// always text a human wrote (an alias value, an approved command) or the exact
// string the user just read in the confirmation dialog. Never a normalized or
// reconstructed form of a request. The one bounded exception is arguments
// appended to an alias (see appendArgs) — never shell syntax, only plain words.

// Anything the shell would interpret, plus quoting and path separators. When
// the first token contains one of these we cannot second-guess what the shell
// will run, so the pre-flight stays out of the way and the command goes
// through unchanged. `=` is here for leading `FOO=1 app` assignments, and the
// separators because a token carrying one is a path, not a name to look up.
const SHELL_METACHARACTERS = /[|&;<>()$`"'\\/*?[\]{}~!#=\s]/;

// What a model-supplied argument may NOT contain, for the one case where
// anything of the model's can join a command that runs without a dialog. Spaces
// and path punctuation are fine (`vscode ~/my project`); shell syntax, quoting,
// expansion and globbing are not, because those turn "an argument" back into
// "more command". `=`, `-`, `~`, `/`, `.`, `:`, `,`, `@`, `%`, `+` are allowed.
const UNSAFE_ARGUMENT = /[|&;<>()$`"'\\*?[\]{}!#\n\r\t]/;

// The confirmation dialog's whole security value is that the user reads the
// exact string that will run. A control character can break that: a newline
// renders a second line that is easy to miss, so a request carrying one is
// refused rather than shown. The cap is the same argument at the other end —
// a wall of text is not a command anyone reads.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f]/;
const MAX_REQUEST_LENGTH = 512;
// A URL alias is fed the rest of the line as its query, so the only limit is
// how much of the user's own speech can end up in a browser bar.
const MAX_QUERY_LENGTH = 300;

// Verbs people put in front of an app's name. Stripped only when the request
// does not otherwise match, so an alias actually named "open" still wins.
const LEADING_VERBS = new Set([
  "open",
  "launch",
  "start",
  "run",
  "go",
  "goto",
  "show",
  "play",
  "visit",
  "browse",
]);

// Commands that destroy a machine rather than do a job. Deliberately short and
// unambiguous: this is depth behind the dialog, not the boundary itself, and a
// long list would start refusing legitimate work (`rm -rf node_modules` must
// stay allowed). Each entry is judged on the whole command string, and applies
// to aliases too — an alias that matches one is inert.
const DESTRUCTIVE_COMMANDS = [
  {
    label: "deletes the whole filesystem or your home directory",
    test: (command) =>
      /\brm\b[^\n]*\s-[a-z]*[rR][a-z]*/.test(command) &&
      /(^|\s)(\/(\*)?|~(\/(\*)?)?|\$HOME(\/(\*)?)?)(\s|$)/.test(command),
  },
  { label: "formats a filesystem", test: (command) => /\bmkfs(\.\w+)?\b/.test(command) },
  {
    label: "writes raw data over a disk",
    // Named device nodes only: `of=/dev/null` and `of=/dev/stdout` are harmless
    // and people do write to them.
    test: (command) =>
      /\bdd\b[^\n]*\bof=\/dev\/(sd|hd|nvme|vd|mmcblk|disk|loop|mapper)/.test(command) ||
      />\s*\/dev\/(sd|hd|nvme|vd|mmcblk|disk|loop|mapper)/.test(command),
  },
  {
    label: "is a fork bomb",
    test: (command) => /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/.test(command),
  },
  {
    label: "makes the whole filesystem world-writable",
    test: (command) => /\bchmod\b[^\n]*\s-R\b[^\n]*\s[0-7]{3,4}\s+\/(\s|$)/.test(command),
  },
  {
    label: "installs an SSH key that would let anyone log in",
    test: (command) => /(>>?|\btee\b)[^\n]*authorized_keys/.test(command),
  },
];

/**
 * Comparison key for a name or command: case-insensitive, whitespace-collapsed.
 * Only ever used to match, never to produce something to execute — collapsing
 * whitespace inside quotes (`echo "a  b"`) would change what the shell runs.
 */
export function normalizeForMatch(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

/**
 * Squashed form for forgiving name matching: the characters people use freely
 * *inside* a name — spaces, hyphens, underscores — are dropped, so "VS Code",
 * "vs-code", "vs_code" and "vscode" are one name.
 *
 * Deliberately NOT every punctuation mark: `;`, `|`, `&` and `$` are meaning in
 * a shell, and treating them as noise made "files .; rm -rf /" look like the
 * alias "files" with arguments.
 */
export function squash(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/[-_\s]/g, "") : "";
}

/** Why this command is never run, or null when it is not on the list. */
export function describeDestructive(command) {
  if (typeof command !== "string" || !command) return null;
  const found = DESTRUCTIVE_COMMANDS.find((entry) => entry.test(command));
  return found ? found.label : null;
}

/** Whether a command leans on shell syntax, which the dialog should say out loud. */
export function usesShellSyntax(command) {
  return typeof command === "string" && /[|&;<>()`$]|\|\||&&/.test(command);
}

/**
 * A `!` in front of an alias's command asks for its output: instead of starting
 * the program and walking away, the run is waited on (with a deadline) and what
 * it printed is handed back. See `resolveCommand`.
 */
const CAPTURE_MARKER = "!";

/**
 * Parse the user's alias file. One entry per line:
 *
 *   vscode, vs code = code
 *   search          = https://duckduckgo.com/?q=%s
 *   disk            = !df -h
 *
 * Names are comma-separated so speech-to-text variance fans into one command.
 * `#` comments, blank lines, and lines without a `=` are skipped; the command
 * is everything after the FIRST `=`, so a command may contain `=` itself.
 *
 * @returns {Array<{names: string[], command: string, capture: boolean}>}
 */
export function parseCommandsFile(text) {
  const entries = [];
  // Strip a BOM: editors on Windows write one, and it would ride along on the
  // first alias name so that one line silently never matched.
  const body = String(text ?? "").replace(/^\ufeff/, "");
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const names = line
      .slice(0, separator)
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    let command = line.slice(separator + 1).trim();
    if (names.length === 0 || !command) continue;
    // The marker is stripped here, so what reaches the shell is exactly the
    // text after it: `!df -h` runs `df -h`, never a `!` the shell would read.
    const capture = command.startsWith(CAPTURE_MARKER);
    if (capture) command = command.slice(CAPTURE_MARKER.length).trim();
    if (!command) continue;
    entries.push({ names, command, capture });
  }
  return entries;
}

/**
 * The approvals file, defensively: it is written by the app, not by hand. Both
 * shapes are accepted — a bare command string from an older file, and
 * `{command, capture}` now that a remembered command can also read output.
 *
 * @returns {Array<{command: string, capture: boolean}>}
 */
export function sanitizeApproved(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return { command: entry.trim(), capture: false };
      if (entry && typeof entry.command === "string") {
        return { command: entry.command.trim(), capture: entry.capture === true };
      }
      return null;
    })
    .filter((entry) => entry && entry.command);
}

/** One line naming every alias, for the model's failures to quote back. */
export function describeAliases(aliases) {
  const names = aliases.flatMap((entry) => entry.names);
  return names.length > 0 ? names.join(", ") : "";
}

/**
 * Whether an alias opens a URL instead of running a program. A `%s` in it takes
 * the rest of the request as a query, so "search for capybaras" becomes a real
 * search URL; without `%s` it is simply a site to open by name.
 */
export function isUrlAlias(command) {
  return typeof command === "string" && /^https?:\/\//i.test(command.trim());
}

export function fillUrlTemplate(template, query) {
  const trimmed = typeof query === "string" ? query.trim().slice(0, MAX_QUERY_LENGTH) : "";
  const encoded = encodeURIComponent(trimmed);
  return template.includes("%s") ? template.replace("%s", encoded) : template;
}

// "search for capybaras" arrives as `search` + "for capybaras": the model copies
// the user's phrasing, so the preposition survives the name match. It is not
// part of what they asked to search for.
const QUERY_FILLER = /^(?:(?:for|about|up|the|please)\s+)+/i;

/** The part of a request that is actually the query. */
export function cleanQuery(value) {
  return typeof value === "string" ? value.trim().replace(QUERY_FILLER, "").trim() : "";
}

/**
 * Join model-supplied arguments onto an alias's own command — or refuse, when
 * they carry anything the shell would read as syntax. This is the only place
 * model text joins something that runs without a dialog, so it is restricted to
 * plain words: a path, a file name, a flag.
 */
export function appendArgs(command, rest) {
  const trimmed = typeof rest === "string" ? rest.trim() : "";
  if (!trimmed) return command;
  if (UNSAFE_ARGUMENT.test(trimmed)) return null;
  return `${command} ${trimmed}`;
}

/**
 * Find the alias a request names, and whatever follows it.
 *
 * Matching is forgiving on purpose, because the request is usually a rephrasing
 * of what the user said: punctuation and spacing are ignored, a leading verb is
 * dropped, and a multi-word name is matched longest-head-first so "vs code"
 * beats "vs".
 *
 * @returns {{entry: object, rest: string, kind: "name"|"value"} | null}
 */
function matchAlias(request, aliases) {
  const tokens = request.trim().split(/\s+/);

  const byName = (offset) => {
    // No real name is longer than four words, and each extra candidate is
    // another chance to mismatch.
    for (let end = Math.min(offset + 4, tokens.length); end > offset; end--) {
      const wanted = squash(tokens.slice(offset, end).join(" "));
      if (!wanted) continue;
      for (const entry of aliases) {
        if (entry.names.some((name) => squash(name) === wanted)) {
          return { entry, rest: tokens.slice(end).join(" "), kind: "name" };
        }
      }
    }
    return null;
  };

  // The user's own command text rather than the name they gave it, alone or
  // followed by arguments.
  const byValue = (offset) => {
    const wanted = squash(tokens.slice(offset).join(" "));
    for (const entry of aliases) {
      if (isUrlAlias(entry.command)) continue;
      const commandText = squash(entry.command);
      if (wanted === commandText) return { entry, rest: "", kind: "value" };

      const end = offset + entry.command.trim().split(/\s+/).length;
      if (end >= tokens.length) continue;
      if (squash(tokens.slice(offset, end).join(" ")) !== commandText) continue;
      return { entry, rest: tokens.slice(end).join(" "), kind: "value" };
    }
    return null;
  };

  // Without the verb first, so an alias actually named "open" still wins.
  const offsets = [0];
  if (tokens.length > 1 && LEADING_VERBS.has(tokens[0].toLowerCase())) offsets.push(1);

  for (const offset of offsets) {
    const named = byName(offset);
    if (named) return named;
    const valued = byValue(offset);
    if (valued) return valued;
  }

  return null;
}

/**
 * An allow verdict. `capture` is present only when the output is wanted, so a
 * verdict that does not read output keeps the shape every caller already
 * handles — treat a missing flag as "no".
 */
function allowed(command, source, capture) {
  return capture
    ? { verdict: "allow", command, source, capture: true }
    : { verdict: "allow", command, source };
}

/**
 * Decide what to do with a requested command.
 *
 * @returns {{verdict: "open", url: string, alias: string}
 *   | {verdict: "allow", command: string, source: "alias"|"aliasValue"|"aliasArgs"|"approved", capture?: true}
 *   | {verdict: "confirm", command: string}
 *   | {verdict: "reject", reason: string, detail?: string}}
 */
export function resolveCommand({ request, aliases = [], approved = [] }) {
  if (typeof request !== "string" || !request.trim()) {
    return { verdict: "reject", reason: "empty" };
  }
  if (UNSAFE_TEXT.test(request)) {
    return { verdict: "reject", reason: "unsafe-text" };
  }
  if (request.length > MAX_REQUEST_LENGTH) {
    return { verdict: "reject", reason: "too-long" };
  }

  const match = matchAlias(request, aliases);
  if (match) {
    const { entry, rest, kind } = match;

    // A URL alias takes the rest of the line as its query, safely: it is
    // URL-encoded into a user-authored link, never handed to a shell. A link
    // with no `%s` is just a site to open, so words after its name are ignored.
    if (isUrlAlias(entry.command)) {
      const takesQuery = entry.command.includes("%s");
      const query = takesQuery ? cleanQuery(rest).slice(0, MAX_QUERY_LENGTH) : "";
      return {
        verdict: "open",
        url: fillUrlTemplate(entry.command, query),
        alias: entry.names[0],
        query,
      };
    }

    // The command is the user's; the arguments may not be. appendArgs refuses
    // them when they carry shell syntax, which is the model writing a command
    // rather than passing a value — that goes to the dialog as the raw request.
    const command = appendArgs(entry.command, rest);
    if (command === null) return confirmOrRefuse(request.trim());

    const destructive = describeDestructive(command);
    if (destructive) return { verdict: "reject", reason: "destructive", detail: destructive };

    if (rest) return allowed(command, "aliasArgs", entry.capture === true);
    return allowed(command, kind === "value" ? "aliasValue" : "alias", entry.capture === true);
  }

  // Normalized here so a caller may pass bare strings (an older approvals file)
  // or the `{command, capture}` objects the app writes now.
  for (const entry of sanitizeApproved(approved)) {
    if (normalizeForMatch(entry.command) === normalizeForMatch(request)) {
      return allowed(entry.command, "approved", entry.capture);
    }
  }

  return confirmOrRefuse(request.trim());
}

function confirmOrRefuse(command) {
  const destructive = describeDestructive(command);
  if (destructive) return { verdict: "reject", reason: "destructive", detail: destructive };
  return { verdict: "confirm", command };
}

/** The first whitespace-delimited word, which is the program being launched. */
export function firstToken(command) {
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed) return "";
  return trimmed.split(/\s+/)[0];
}

/**
 * Whether looking up the first token would mean anything. A path, or anything
 * the shell would interpret, is left alone — a false "command not found" would
 * block a working alias, which is worse than no check at all.
 *
 * There is deliberately no list of shell builtins here. There used to be, to
 * stop `which` reporting `cd` or `eval` as missing, and it read like a list of
 * permitted commands to every person who opened this file — twice. It was how
 * the pre-flight asked, not what was allowed, and the honest fix was to stop
 * enumerating: the probe now asks the shell itself (`command -v`), which knows
 * its own builtins, so nothing has to be named to be looked up.
 */
export function needsExecutableCheck(token) {
  if (!token) return false;
  if (SHELL_METACHARACTERS.test(token)) return false;
  if (token.startsWith("-")) return false;
  return true;
}
