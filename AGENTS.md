# AGENTS.md — fork maintenance guide

For an AI agent (or a human) picking this repository up later. `CLAUDE.md` describes
**upstream OpenWhispr** and is the authority on how the app works. This file describes
**only what this fork changed**, where those changes sit, and how to pull upstream's work
in without breaking them.

Read `CLAUDE.md` for the app. Read this for the diff.

---

## 1. What this repository is

**Eva AI assistant** — a fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr).

Nearly everything here is upstream's code, unchanged: dictation, meeting transcription and
diarization, notes, calendar sync, semantic search, the model/provider plumbing. The fork's
own work is §2 below — a handful of features, one platform fix, and some housekeeping.

The internal identifiers (package name, app id, install directory, in-app product strings)
still say OpenWhispr. Do not "fix" that as a drive-by: changing the app id moves where user
data lives, so existing installs would appear empty. It is a deliberate separate decision.

## 2. The fork's changes

### 2a. File attachments in the chat and the Voice Assistant

Attach images, PDFs and text files to a message — by button, by `Ctrl+V` of a clipboard
image, or by drag & drop. Images ride the existing vision path; documents are reduced to
text and folded into the request, never into stored history.

Relevant files:

- `src/helpers/chatAttachments.js` _(new)_ — the whole main-process reader: extension
  classification, size caps, the image quality ladder, PDF text extraction via `pdfjs-dist`,
  and `readClipboardImage` for pasted screenshots.
- `src/components/chat/useChatAttachments.ts` _(new)_ — the renderer side: chooser, intake,
  drag & drop, paste, staging, and the window-level drop guard.
- `src/components/chat/AttachmentTray.tsx` _(new)_ — the chips.
- `src/utils/chatAttachmentContext.ts` _(new)_ — request-text wrapper and the inlined
  prompt suffix.

### 2b. Vision for self-hosted models

Upstream gated images on the model registry and never carried them on the self-hosted
transport, so `gemma4:e4b` on Ollama was refused with "can't read images".

- `src/services/ai/inferenceProviders/lan.ts` — `supportsImages: true`.
- `src/services/ai/chatCompletionsContent.ts` _(new)_ — translates AI-SDK content parts
  into OpenAI `image_url` parts for the raw Chat Completions transports.
- `src/helpers/dictationRouting.js` — `resolveAgentImageTarget` gained
  `baseModelUnknown` / `allowUnregisteredModel`.
- `src/helpers/dictationAgentInference.js` — self-hosted resolves as image-wired;
  `resolveChatStreamingInference` gained `allowUnregisteredModelVision`.
- `src/services/ReasoningService.ts` — `callChatCompletionsApi` emits image parts, and
  `processTextStreamingRaw` accepts them.

**The rule to preserve:** an _unregistered_ model may receive an image **the user attached
themselves**; an automatic screenshot still drops conservatively. Dropping beats failing
the dictation it rode in with.

### 2c. Read replies aloud (local TTS)

A speaker button on the assistant panel's reply and on **every** chat message, including
the user's own.

- `src/utils/speechText.ts` _(new)_ — markdown to speech (code blocks are announced, not
  read), plus sentence chunking.
- `src/stores/speechStore.ts` _(new)_ — the shared engine. **Two backends, and the choice
  is not a preference** (see §4).
- `src/hooks/useSpeechControl.ts` _(new)_ — per-button wiring and labels.
- `src/helpers/systemSpeech.js` _(new)_ — the Linux backend, driving `spd-say`.

**A locally installed Kokoro model** is the third backend, and preferred over both when it is
present: it sounds identical on every platform, and on Linux it is the only genuinely good
option. It is opt-in — a ~305 MB download behind a button in Settings — and downloading
nothing changes nothing. All new files:

- `src/helpers/kokoroModels.js` — the two bundles, and the pure voice-name parsing.
- `src/helpers/kokoroEngine.js` — fetches the sherpa-onnx TTS binary **at runtime**.
- `src/helpers/kokoroDownload.js` — bundle download, extract, delete.
- `src/helpers/kokoroTts.js` — drives the CLI and enumerates voices.
- `src/helpers/kokoroIpc.js` — every IPC channel, registered from `main.js`.
- `src/stores/kokoroSpeech.ts` — chunking and Web Audio playback.
- `src/components/settings/KokoroSettings.tsx` — the Settings block.

Upstream files touched, kept deliberately tiny: `main.js` (one `require` + `register()`),
`preload.js` (eight methods), `speechStore.ts` (three insertions), `SettingsPage.tsx` (one
import, one mount). See §4 for the constraints that shaped this.

### 2d. Voice Assistant composer fix on Linux

`src/helpers/windowConfig.js` — the overlay is created focusable on Linux except where
focus theft was reported. **Read §4 before touching this.**

### 2e. The assistant can run local commands

`run_command` lets the assistant open things: "open vscode" → `code`. Authorization is
decided in the **main process**, never by the model or the renderer.

- `src/helpers/commandAllowlist.js` _(new)_ — the pure policy: parse the alias file,
  resolve a request to `open` (an https alias, opened in the browser) / `allow` /
  `confirm` / `reject`. Electron-free and unit-tested, so the decision the whole feature
  rests on is testable (`test/helpers/commandAllowlist.test.js`). A verdict carries
  `capture: true` only when the output was asked for, so a verdict that does not read
  output keeps the shape every caller already handles.
- `src/helpers/localCommands.js` _(new)_ — the main-process half: paths, the approval
  dialog, the PATH pre-flight, the detached spawn, the capture-with-deadline, the
  re-entrancy and burst guards.
  `test/helpers/runCommandIpc.test.js` drives the real `requestRun` with electron and
  `child_process` stubbed, against a temp config dir (`requestRun` takes
  `{sender, dir, now, captureTimeoutMs}` so tests touch neither the developer's
  `~/.openwhispr`, the wall clock, nor a real 10-second wait).
- `src/services/tools/runCommandTool.ts` _(new)_ — the renderer tool, a dumb pipe to
  `window.electronAPI.runCommand`.
- Wired in `src/helpers/ipcHandlers.js` (`run-command`, grouped with the fork's other
  handlers), `preload.js`, `src/types/electron.ts`, `src/services/tools/index.ts`,
  `src/config/prompts.ts` (one `TOOL_INSTRUCTIONS` entry — without it the tool is silently
  dropped from the system prompt), and `src/components/chat/toolIcons.ts`.

**The user's alias file is the switch**: `~/.openwhispr/commands.txt` absent means the
feature is off, approval path included. There is no settings flag and no renderer plumbing,
which is also why `useChatStreaming.ts` is untouched.

**Every entry point into these files must default its `dir`.** `requestRun` takes
`dir = defaultConfigDir()`, and `listAliasNames` did **not** — while `ipcHandlers.js` calls
`listAliasNames()` with no argument. `path.join(undefined, …)` threw a `TypeError`, the
`catch` in `readAliases` read a missing file into "no aliases" and logged a warning nobody
saw, and so **the user's registered names never reached the model** for the life of the
feature. The symptom is not an error: `run_command` simply arrives describing a tool with
no known names, and the model invents `df -h` where the user's `disk space` alias exists.
That matters because an invented command is not an alias, so it opens the approval dialog —
and a dialog-launched command has **no output capture** (the checkbox is off by default and
only the user can set it), so a _question_ gets an answer with nothing in it. Fixed, and
pinned by `test/helpers/commandConfig.test.js` → "the names the model is given come from
the file the editor writes", which drives the real `localCommands` with `electron` stubbed
and `os.homedir()` pointed at a temp directory.

**Properties to preserve** (§4 has the reasoning):

1. What executes is always text a human wrote (an alias value, an approved command) or the
   exact string the dialog displayed. Matching helpers (`normalizeForMatch`, `squash`) are
   for _matching only_ — collapsing whitespace inside quotes would change what the shell runs.
2. The approval dialog shows the command and nothing the model authored. Do not add a
   `reason` parameter to the tool, however helpful it looks.
3. Aliases are standing permission and always have been: anything that reaches the model can
   ask for one by name and get it unprompted, arguments included. That is the documented
   trade, not a bug.
4. `appendArgs` is the single place model text joins a command that runs with no dialog, so
   its `UNSAFE_ARGUMENT` rule (`;`, `|`, `$(`, backticks, quoting, globbing) is what stops an
   alias becoming a shell. Loosening it re-opens exactly that hole; the fallback — the whole
   raw request goes to the dialog — is the correct behaviour, not a bug to fix.
5. `DESTRUCTIVE_COMMANDS` is judged on the whole command string and applies to aliases too,
   so an alias matching one is inert. It is depth behind the dialog, **not the boundary**:
   keep it short and unambiguous, and never let it grow into a policy that refuses real work
   (`rm -rf node_modules` must stay allowed).
   There is deliberately **no list of shell builtins**: the pre-flight asks the shell itself
   (`command -v "$1"`), so `eval`, `exec` and `cd` need no enumeration and reach the dialog
   like anything else. A hand-written builtin list was here once; it read like a permissions
   allowlist and was removed rather than explained twice.
6. URL aliases (`https://…`) are opened with `shell.openExternal` and never confirmed,
   because a link cannot execute. The query is always `encodeURIComponent`-encoded into the
   user's own template, and the final URL is re-checked for an `http(s)` scheme.
7. Read-back — a `!` alias, or the dialog's checkbox — is the one path that **waits** on a
   command, and only the user can ask for it. The model may not: `run_command` takes a
   command, never a mode. Both bounds are load-bearing. `CAPTURE_TIMEOUT_MS` stops a command
   that never exits (`close` never fires, so without it the tool call hangs until the request
   times out), and the timeout kills the **process group** — `shell: true` makes the child a
   shell and the real program a further process. `MAX_CAPTURE_BYTES` stops a command that
   prints forever. What the model reads is capped again, much lower
   (`MODEL_OUTPUT_CHARS`): output is text from the user's machine entering the model's
   context, and a local model's window is small. The app never sets `num_ctx`, so Ollama
   truncates at the model's default — 4096 for `gemma4:e4b` — and what it drops is the
   **start** of the prompt, which is where the system prompt and the tool instructions live.
   Measured: ~2200 prompt tokens with nine tools and no history, so the margin is thin
   already. A model answering "I am an AI and cannot access your files" usually means the
   tools did not reach it — check the wiring before touching the prompt, and see the
   measured refusals in §4: when an explicit "run this command: …" _does_ work, the wiring
   is not the explanation either, and the prompt is not where the answer is.

### 2f. Editing the command files in the app

§2e's two files, edited from the UI: a **Commands** entry in the main-window sidebar,
between Dictionary and Integrations.

- `src/helpers/commandConfig.js` _(new)_ — the main-process read/write half, plus its own
  `register()` called from `main.js`. Every reader/writer takes `dir` explicitly so the
  tests touch a temp directory rather than the developer's `~/.openwhispr`.
- `src/components/CommandsView.tsx` _(new)_ — the two editors.
- `src/components/commands/defaultCommands.txt` _(new)_ — the list this app ships with:
  what Reset restores and what `Create the file` writes. The format's documentation as much
  as its data, which is why it is a real file of that format rather than a string literal.
- `src/helpers/localCommands.js` — exports `defaultConfigDir` (one line) so the editor and
  the runtime cannot disagree about where the files are.
- `src/components/controlPanelNav.ts` — the view id, the icon, the nav row.
- `src/components/ControlPanel.tsx` — a lazy import and a render branch.
- `src/types/electron.ts`, `preload.js` — five channels, named like the existing
  `run-command` / `get-command-aliases` pair.
- `test/helpers/commandConfig.test.js` _(new)_ — including a test that every channel the
  preload bridge invokes is one this module registers, so the two cannot drift.
- `test/components/fieldDirectionPolicy.test.js` — two entries in the review record that
  test exists to force. Adding a field to a component means adding a line here; that is
  the test working as designed, not a merge accident.

**Two shapes, on purpose.** `commands.txt` is read and written **verbatim**, because the
shipped file is mostly comments and they are the format's documentation — a structured
editor that re-serialised the parsed aliases would delete all of it. The parse runs
alongside only to report what the runtime will understand. `approved-commands.json` is
generated and has nothing to preserve, so it is a list, written in the `{command, capture}`
shape `rememberApproved` uses.

**Absent and empty are different files.** `commandsText` is null when the file is missing,
never `""`: absent is the switch that turns the feature off (including the approval path),
while empty is a file with no aliases that falls through to the dialog. The editor offers
"Turn off" as a separate, confirmed action for that reason. Do not collapse the two.

**Reset restores a shipped file, and writing it is the renderer's draft — not an IPC.**
`src/components/commands/defaultCommands.txt` is the whole default list, imported with
Vite's `?raw` rather than written as a string literal, so it stays a real file of its own
format: diffable, highlighted, and the format's documentation as much as its data. Two
things depend on it — Reset, and `Create the file` when the file is absent — and they share
one handler for that reason.

There is deliberately **no reset IPC and no backup file**. Reset only fills the editor's
draft, so Save stays the single path by which `commands.txt` changes: a mis-pressed Reset is
undone by Revert, and the restored list is visible before it takes effect. That matters most
in the case Reset exists for, where the list was already emptied _and saved_ — by then
Revert has nothing left to undo. (An earlier revision kept a `commands.txt.backup` and
restored from it. It was dropped because a Reset that sometimes brings back your own last
version and sometimes a built-in list is not something a user can predict, and the shipped
list is the richer of the two anyway.)

`test/helpers/commandConfig.test.js` → "the shipped default file is a valid commands file"
is the guard on that asset: every non-comment line in it must parse, and at least one `!`
read-back command must survive. A typo there is otherwise silent, because an unparseable
line simply never matches.

### 2g. Housekeeping

- `README.md` — rewritten for the fork.
- `electron-builder.json`, `package.json` — the `pdfjs-dist` dependency and its asar
  unpacking.
- `package-lock.json` — 434 lines, entirely `pdfjs-dist` and its optional
  `@napi-rs/canvas`. This is the single worst file to merge; see §5.

### 2h. Read a selection or pasted text aloud

A hotkey (Settings → Hotkeys → **Read aloud hotkey**, unset by default) that reads either the
text highlighted in another app, or text pasted into a panel it opens. Pause and playback speed
both work, and the speed persists across restarts.

Three tiers, one button each in the header: the full panel, a collapsed **control strip** (text
box hidden, Play/Pause + Stop + speed still on screen), and minimised back to the pill. Neither
collapsing nor minimising stops the audio — that is the point of both, since a passage you can't
put the window away from is not one you'd choose to listen to.

New files:

- `src/utils/speechSpeed.ts` — the speed: clamped, snapped to its step, persisted in
  localStorage. Read at speak time, so a change lands on the next chunk rather than needing a
  restart.
- `src/hooks/useReadAloudPanel.js` — panel lifecycle, the collapsed/minimised states, and the
  hotkey's play/pause/resume toggle.
- `src/components/readAloud/ReadAloudPanel.tsx` — the panel itself.

Upstream files touched, kept deliberately tiny: `hotkeyManager.js` (the `readAloud` slot),
`gnomeShortcut.js` / `hyprlandShortcut.js` (its native bindings), `environment.js` (the key),
`main.js` (one callback and its registration), `ipcHandlers.js` (`update`/`get` handlers plus
`set-read-aloud-panel-open`), `preload.js`, `electron.ts`, `settingsStore.ts`, `SettingsPage.tsx`
(one row, plain English), `speechStore.ts` and `kokoroSpeech.ts` (pause, resume, speed),
`systemSpeech.js` (`-r`), `windowManager.js` (`setReadAloudPanelOpen`, and `_applyPanelFocus`
extracted so both panels share the focus handover), `useMainWindowSizeOwner.js`,
`VoiceModePanelCore.tsx`, `App.jsx`, `voicePillPresentation.js`.

**The selection is read by the renderer, before the panel opens.** The capture is a synthetic
copy aimed at whatever window is foreground, and this panel becomes focusable the moment it
mounts — so reading it afterwards would copy out of our own window and always come back empty.
The main process only starts the target *probe* on the keypress, which the read then finds
resolved. Read §4 before moving that call.

Reading a selection is best-effort by design: with no `xdotool` on X11, or a helper built without
AT-SPI, the box simply opens empty for pasting. The README's per-platform notes cover what each
platform needs; the failure is silent, so a bug report about "nothing was selected" is worth
checking against the helper's `--capabilities` output before anything else.

## 3. Merging upstream

**There is a skill for this: `.claude/skills/merge-upstream/SKILL.md`** — run
`/merge-upstream`. It covers the preconditions, the conflict forecast, how to resolve each
class of conflict, what to check beyond the gate below, and the reporting format. Read it
rather than reconstructing the procedure.

**This section stays the authority, and the two must not be merged into one.** `.claude/` is
gitignored — by _upstream_, whose rule it is (`6ae83bbe`, before this fork's base) — so the
skill does not survive a clone, while this file does. Everything needed to perform a merge
therefore has to be true here, and the skill is the executable layer on top: it points back
at the list below rather than keeping a second copy that can drift. When they disagree, this
file is right, and the skill is the thing to fix.

The fork's last merge from upstream was **`fa8fb7ef`** (2026-09-24). To take upstream's
changes:

```bash
git remote add upstream https://github.com/OpenWhispr/openwhispr.git   # once
git fetch upstream
git merge upstream/main      # default; or `git rebase upstream/main` for linear history
```

**Merge, not rebase, unless you have a reason.** The fork is published at
`github.com/alexchessmaster/eva-ai-assistant` with all its commits pushed, so a rebase
rewrites published history and needs a force-push, and it re-hashes the fork's commits for
anyone who has cloned. A merge keeps them stable.

Before starting, ask git what would actually conflict, without touching the working tree:

```bash
git merge-tree --write-tree HEAD upstream/main >/dev/null; echo $?   # non-zero = conflicts
```

Then, in order:

1. `npm install` — **with Node 24** (`.nvmrc`). Another major rewrites `package-lock.json`
   incompatibly and breaks `npm ci` in CI.
2. `npm run quality-check` (lint + prettier + typecheck)
3. `npm run i18n:check`
4. `npm test` — expect the upstream figure; this fork adds tests but no new failures.
5. `npm run build:renderer`

**Conflict hot spots, in the order they are likely:**

| File                                           | What will clash                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `package-lock.json`                            | Any dependency change upstream. Regenerate with Node 24 rather than hand-merging.                  |
| `src/components/dictation/AssistantPanel.tsx`  | Busy component; the fork adds a hook call, ChatInput props, a footer button, and an Escape branch. |
| `src/components/chat/ChatInput.tsx`            | The fork adds props, an attach button and a paste handler around the existing input.               |
| `src/components/chat/useChatStreaming.ts`      | The fork adds `attachments` to `SendToAIOptions` and an attachment branch in the request build.    |
| `src/helpers/ipcHandlers.js`                   | The fork's handlers are grouped next to `select-audio-file` / `approve-audio-path`.                |
| `src/types/electron.ts`                        | The fork's API additions sit by `getPathForFile` and `captureScreenContext`.                       |
| `src/components/controlPanelNav.ts`            | Short and stable, but the fork adds a view id and a nav row.                                       |
| `src/components/ControlPanel.tsx`              | The fork adds one lazy import and one render branch among many.                                    |
| `test/components/fieldDirectionPolicy.test.js` | The review record for every `Input`/`Textarea` in the app. Any new field must add a line here.     |

Nothing in the fork modifies `src/locales/**`, so those merge cleanly — that is deliberate
(§4). **`src/config/prompts.ts` is the one exception**, and this line used to claim
otherwise: the fork owns the `run_command` entry in `TOOL_INSTRUCTIONS` and has rewritten
it twice, so expect a conflict there whenever upstream touches that file. Keep upstream's
other entries verbatim and re-apply the fork's `run_command` on top.

## 4. Constraints that will bite a future change

**Every panel that owns the overlay must be listed in `anyPanelMounted` (`App.jsx`).** This is
not a cosmetic "is something open" flag: on Linux it reaches `useLinuxPillInteractivity` as
`captureWindow`, and while that is false the native input region is shaped to the pill's
rectangle on a 50 ms sampler — every click outside the pill passes straight through to the window
underneath. A panel nobody registered therefore renders perfectly and cannot be clicked, typed
into, or focused, and the symptom reads like a focus bug rather than a missing registration. The
read-aloud panel shipped without it and behaved exactly that way.

**Playback speed is applied by the synthesiser, never by Web Audio.** `playbackRate` on a decoded
buffer resamples it, which moves the pitch — 1.2x turns Kokoro into a chipmunk. The engine's own
`--speed` scales durations instead and leaves the voice alone. Measured on the bundled model:
2.51 s → 2.14 s at 1.2x with the zero-crossing rate essentially unchanged (4252/s → 4119/s, where
a resample would have scaled it to ~5100/s). Reproduce it the §6 way before changing this.

**Pause is reconstructed, not delegated.** Web Audio offers no way to pause a buffer source, so
`kokoroSpeech.ts` records the chunk index and the elapsed offset from the audio clock and rebuilds
the node on resume — pause must invalidate the pipeline exactly as `stopKokoro()` does, or
synthesis already queued keeps running through the pause. `spd-say` has no pause at all (only
`-S` and `-C`; check `spd-say --help`), so that backend reports `pausable: false` and the control
offers Stop rather than a button that would silently do nothing.

**Do not add i18n keys for the fork's strings.** `test/locales/translationCoverage.test.js`
requires every literal `t()` key to resolve in `en`, and `scripts/check-i18n.js` requires
every `en` key to exist in 11 other locales. Two new buttons would therefore mean editing
thirteen upstream files on every merge. The fork's strings are plain English with a comment
saying where to add keys if translations are ever wanted — see `useSpeechControl.ts` and
`useChatAttachments.ts`. The attachment prompt suffix is inlined in
`chatAttachmentContext.ts` for the same reason.

**Chromium cannot speak on Linux, and that is not fixable here.** Electron's binary links
no speech-dispatcher (verify: `ldd node_modules/electron/dist/electron | grep -i speech` →
nothing), so `speechSynthesis.getVoices()` returns an empty list and no utterance plays.
The `--enable-speech-dispatcher` switch changes nothing. That is why `speechStore.ts`
falls back to `spd-say` through `systemSpeech.js` on Linux. **Do not "simplify" it back to
the Web Speech API** — it silently disables the feature there. macOS and Windows do work
through the Web Speech API and never touch `systemSpeech.js`.

**The Kokoro engine is fetched at runtime, and the engine directory is self-contained.**
Upstream's TTS-less sherpa-onnx binaries are bundled during `prebuild` by
`scripts/download-sherpa-onnx.js`; doing the same for TTS would mean editing that script,
`package.json`, and `electron-builder.json`, and then re-merging all three forever. So
`kokoroEngine.js` downloads the release archive on demand instead — no build-time footprint
at all. It keeps its **own copy** of the shared libraries rather than reusing
`resources/bin/`, for two reasons: the binary's RPATH is `$ORIGIN:$ORIGIN/../lib` (verify
with `readelf -d`), so a `bin/`+`lib/` layout resolves with no `LD_LIBRARY_PATH` on any
platform; and upstream pins sherpa-onnx to whatever Parakeet needs, so a version bump there
cannot break TTS here. Only four files are extracted from the ~28 MB archive — it is a whole
distribution, and a plain `tar xf` unpacks far more than the ~34 MB actually installed.

**Kokoro's performance numbers are measured, and the obvious answers are wrong.** Synthesis
runs at ~0.17 RTF (about 6x realtime), but only with **8 threads**: measured on a 24-core
machine, 4 threads took 3.60 s, 8 took 2.88 s, and 24 took 4.06 s for the same passage — a
model this small thrashes when oversubscribed. Hence `KOKORO_MAX_THREADS`. And because each
spawn reloads the model (~0.7-1.4 s), the renderer feeds the engine one `splitForSpeech`
chunk at a time rather than one sentence at a time: a chunk is ~4-12 s of audio, so playback
stays ahead of synthesis. Per-sentence spawns would pay the load cost every sentence and
fall behind. Re-measure before changing either number.

**Windows is gated off on purpose — do not "fix" it by adding the archive back.** The
Windows sherpa-onnx build imports `onnxruntime.dll` by bare name, and Windows 11 ships an
older copy in System32 that some loader configurations resolve instead; upstream works
around it (#2054) by renaming to `ow-onnxrt.dll` and rewriting every image's PE import
table. That cannot be verified from a Linux checkout, and shipping unverified binary
patching is worse than not shipping the platform. With no entry in `ENGINE_ARCHIVES`,
`getEngineDownloadUrl()` returns null and Settings reports "not available on this platform"
rather than installing an engine the OS cannot load. Windows read-aloud is unaffected — it
keeps using the native voices through Chromium. To add it, port `renameImportedModule` from
`scripts/lib/pe-imports.js` into a runtime helper, apply it during extraction, and add the
archive — with a Windows machine to test on.

**The overlay `focusable` flag is load-bearing in both directions.**
`windowConfig.js` creates the main window focusable on Linux except on wlroots/i3.
Electron's `setFocusable()` is `@platform darwin,win32`, so on Linux this creation flag is
final — a window made `focusable: false` can never be focused again, which left the
assistant panel's composer untypeable. But `focusable: false` was added upstream to stop
the overlay stealing focus from the app being dictated into, which breaks auto-paste.
`showInactive()` was measured not to focus the window even when focusable, so the guard
stays only where the theft was reported. Changing this needs the same measurement, not a
guess.

**The dropped-file navigation guard lives in the renderer**, not in `windowManager.js`: a
`dragover`/`drop` `preventDefault` in `useChatAttachments`. Without it, a file dropped
outside a drop zone navigates the window to that file and replaces the app UI. If that
hook is ever removed, the guard goes with it.

**The approval dialog is parented only to a focusable window.** `dialogParent()` in
`localCommands.js` falls back to a standalone dialog when the asking window cannot take
focus, because a modal owned by an unfocusable window can end up unclickable — and on Linux
`setFocusable()` is a no-op, so the overlay cannot be fixed after creation (§4). This is the
one place the fork deliberately takes focus; it is acceptable because it only ever happens
for a command the user (or a model acting with their consent) asked to run. Allowlisted
commands never prompt and never take focus.

**A model that refuses to look at the machine is not a prompt problem — measured, so
stop editing the prompt.** The symptom is an answer like "I don't have access to your local
files" to "how much space do I have left?", while "run this command: df -h" works. That
combination means the tool reached the model and the model chose not to call it, and the
obvious explanations were all tested against the real thing in 2026-09:

- the app's actual payload — `createToolRegistry`'s real schemas, the real names parsed
  out of a real `commands.txt`, `gemma4:e4b` on Ollama — calls
  `run_command({"command":"disk space"})` for that exact question, and did so with the
  **previous** wording too;
- with 0, 4 and 120 turns of history (~1.6k → ~3.4k prompt tokens);
- after the assistant had already refused twice in the same conversation, which is the
  "it anchored on its own refusal" theory;
- and with `num_ctx` forced to 2048 so Ollama truncated the history away.

None of them produced a refusal. So the wording, prompt truncation, and self-anchoring are
all ruled out, and every further round of prompt editing is guessing. Get the real request
first (`OPENWHISPR_LOG_LEVEL=debug`, then look at what was actually sent and which tools
were registered) before changing any text. The description was rewritten anyway — it now
names the _question_ case, which the old one left implicit — but that was hardening, not a
measured fix, and the difference between the two is the point of this paragraph.

**What it actually was**: the missing `dir` default on `listAliasNames` (§2e), which meant
the alias names never reached the model at all. That is the lesson — the refusal sent
everyone looking at prompt text, while the defect was one absent default argument three
files away from the prompt. When a tool is not being used, check what the model was
_told_, not only what it was told to do. (The literal refusal string was never reproduced
here even with the names absent, so treat the mechanism as established and the exact
wording as unconfirmed.)

**The dictation-agent route has no tools, so its prompt must say so.** `audioManager.js` and
`dictationAgentInference.js` build no tool registry — commands are wired only into the chat
streaming path (`useChatStreaming` → `createToolRegistry`), which is what the Voice Assistant
_panel_ uses. The DictationAgent prompt therefore governs a path that cannot save a note,
send a message or create a calendar entry, and a prompt that only says "reply with the result
only, no questions" will **fabricate success**: measured on `gemma4:e4b`, "open my calendar
and put this in for tomorrow at nine: standup" answered _"Standup added to your calendar for
tomorrow at 9:00 AM."_ The fix is one explicit rule telling it to say what it cannot do
instead of inventing a result — that is rule 5 of the prompt in README §5, and it works: all
four phrasings switch from a fabricated success to a plain "I cannot…". Do not remove it, and
re-check it if tools are ever wired into this route.

**The panel's prompt and its model come from different scopes.** `AssistantPanel.tsx` passes
`inferenceScope: "dictationAgent"` (so the _model_ is the Voice Assistant one), while its
_system prompt_ is `getAgentSystemPrompt()` → `resolvePrompt("chatAgent")`. That is upstream's
shape, not the fork's, and it is surprising enough to be worth knowing before debugging "the
Voice Assistant prompt does nothing" — for the panel it genuinely does not, because that
field is not the one being read.

**The pre-flight is a `which` lookup, and deliberately not on Windows.** `where` cannot see
what `cmd.exe` resolves through App Paths, ShellExecute, or its own builtins, so a Windows
miss would be a false negative that blocks a command that works; there the dialog is the
gate. On POSIX a miss is accurate, and refusing is what turns a typo into a real error
instead of a silent no-op. The probe and the spawn share one PATH (`searchPath()`), extended
with the user bin directories a desktop-launched app does not inherit — on macOS, a
Finder-launched app has launchd's minimal PATH and would not find `code` at all, which is
the exact command this feature exists for.

## 5. Optional: dropping PDF support

If `package-lock.json` churn becomes a problem, PDF attachments are self-contained and
removable: delete the `pdfjs-dist` dependency from `package.json`, its line from
`electron-builder.json`'s `asarUnpack`, the `.pdf` entries from `chatAttachments.js` and
`CHOOSER_ACCEPT` in `useChatAttachments.ts`, and the two PDF tests. Images, clipboard
paste and drag & drop are unaffected.

## 6. When a capability is in doubt, measure it

Two of this fork's bugs were settled by probing the real system rather than reasoning about
it, and both probes are cheap to reproduce. Prefer this to guessing:

- **Window focus / window type** — run a throwaway script with the repo's Electron
  (`./node_modules/.bin/electron /tmp/probe.js`) that creates the window combination under
  test and reports `win.isFocused()` and `document.hasFocus()`. This is how the
  `focusable` behaviour above was established. Add `app.on("window-all-closed", () => {})`
  or the app quits when the first window is destroyed.
- **Speech synthesis** — the same harness, evaluating
  `speechSynthesis.getVoices().length` inside the renderer, and checking `ldd` on the
  Electron binary for a linked speech library.

- **Kokoro playback speed** — that `--speed` reaches the Kokoro path at all, and that it changes
  tempo rather than pitch. Synthesise one sentence at 1.0 / 1.2 / 1.5 and compare the WAV
  durations *and* the zero-crossing rate. Duration alone cannot tell the two apart: a resample
  shortens the file and raises the pitch together, which is exactly the failure being ruled out.

The first two need a display; note the `DISPLAY` variable is set on a normal desktop session.
