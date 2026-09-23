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
own work is four features, listed below.

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
   already. A model answering "I am an AI and cannot access your files" means the tools did
   not reach it; check the wiring before touching the prompt.

### 2f. Housekeeping

- `README.md` — rewritten for the fork.
- `electron-builder.json`, `package.json` — the `pdfjs-dist` dependency and its asar
  unpacking.
- `package-lock.json` — 434 lines, entirely `pdfjs-dist` and its optional
  `@napi-rs/canvas`. This is the single worst file to merge; see §5.

## 3. Merging upstream

The fork is one commit ahead of `d61e5213` plus an uncommitted working set. To take
upstream's changes:

```bash
git remote add upstream https://github.com/OpenWhispr/openwhispr.git   # once
git fetch upstream
git rebase upstream/main
```

Then, in order:

1. `npm install` — **with Node 24** (`.nvmrc`). Another major rewrites `package-lock.json`
   incompatibly and breaks `npm ci` in CI.
2. `npm run quality-check` (lint + prettier + typecheck)
3. `npm run i18n:check`
4. `npm test` — expect the upstream figure; this fork adds tests but no new failures.
5. `npm run build:renderer`

**Conflict hot spots, in the order they are likely:**

| File                                          | What will clash                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `package-lock.json`                           | Any dependency change upstream. Regenerate with Node 24 rather than hand-merging.                  |
| `src/components/dictation/AssistantPanel.tsx` | Busy component; the fork adds a hook call, ChatInput props, a footer button, and an Escape branch. |
| `src/components/chat/ChatInput.tsx`           | The fork adds props, an attach button and a paste handler around the existing input.               |
| `src/components/chat/useChatStreaming.ts`     | The fork adds `attachments` to `SendToAIOptions` and an attachment branch in the request build.    |
| `src/helpers/ipcHandlers.js`                  | The fork's handlers are grouped next to `select-audio-file` / `approve-audio-path`.                |
| `src/types/electron.ts`                       | The fork's API additions sit by `getPathForFile` and `captureScreenContext`.                       |

Nothing in the fork modifies `src/locales/**` or `src/config/prompts*`, so those merge
cleanly — that is deliberate (§4).

## 4. Constraints that will bite a future change

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

Both need a display; note the `DISPLAY` variable is set on a normal desktop session.
