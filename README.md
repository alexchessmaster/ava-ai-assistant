<p align="center">
  <img src="src/assets/logo.svg" alt="Ava AI assistant" width="120" />
</p>

<h1 align="center">Ava AI assistant</h1>

<p align="center">
  <strong>A fork of <a href="https://github.com/OpenWhispr/openwhispr">OpenWhispr</a></strong> —
  privacy-first voice-to-text dictation with AI agents, meeting transcription, and notes.<br/>
  Same app, plus <strong>file attachments</strong>, <strong>read-aloud replies</strong>, and
  <strong>vision for self-hosted models</strong>.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/OpenWhispr/openwhispr?style=flat" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat" alt="Platform" />
  <a href="https://github.com/OpenWhispr/openwhispr"><img src="https://img.shields.io/badge/upstream-OpenWhispr-blue?style=flat" alt="Upstream" /></a>
</p>

---

> ### This is a fork
>
> Ava AI assistant is built on [OpenWhispr](https://github.com/OpenWhispr/openwhispr) and
> tracks it closely. The overwhelming majority of this codebase — the dictation engine,
> meeting transcription and diarization, notes, calendar sync, semantic search, the
> cloud/self-hosted/local model plumbing, and every platform integration — is upstream's
> work, unchanged.
>
> This README documents the whole app, but **[What Ava adds](#what-ava-adds)** below is the
> only part that is this fork's own. If you want the app without those additions, use
> [upstream](https://github.com/OpenWhispr/openwhispr).

## What Ava adds

Four changes on top of upstream. Each is deliberately narrow and lives mostly in new
files, so the fork rebases cleanly onto new OpenWhispr releases.

### 1. File attachments in the chat and the Voice Assistant

Send an image, PDF, or text file along with a message — in the Voice Assistant panel and
in the Control Panel chat. Three ways in:

- **Attach button** in the composer — images, PDFs, and text/code files
- **Paste** — `Ctrl+V` / `Cmd+V` an image straight from the clipboard, so a screenshot
  needs no detour through disk
- **Drag & drop** anywhere on the panel

Images reach the model through the same vision path screen context already uses. PDFs and
text files are reduced to text in the main process and folded into the request — never
into the stored conversation, so a 40-page PDF doesn't get re-persisted on every turn.
Attachments show as chips with a thumbnail or a name and size, and can be removed before
sending. A message can be an attachment alone, with no text.

### 2. Vision for self-hosted models

Upstream gates images on the model registry: a model id it doesn't recognise is refused
outright, and the self-hosted (LAN) transport could not carry an image at all. Both are
fixed here:

- Models the registry has never heard of — `gemma4:e4b` served by Ollama, or any id you
  type into a custom endpoint — are no longer refused when **you** attached the image.
  An automatic screenshot still drops conservatively, because there dropping beats
  failing the dictation it belongs to.
- The self-hosted transport now sends images, and the shared Chat Completions caller
  emits proper OpenAI `image_url` parts, so an OpenAI-compatible server (Ollama,
  llama.cpp server, vLLM) receives what it expects.

If a model genuinely can't read images, you get a toast naming it instead of an image
that silently never left.

### 3. Read replies aloud

A speaker button reads a message out loud: on the assistant's reply **and your own
messages** in the chat, and on the reply in the Voice Assistant panel.

Speech is generated locally by the built-in engine — Chromium's own speech synthesis,
which routes to the OS voices. Nothing is downloaded, nothing is sent anywhere, and it
works offline. On Linux that means speech-dispatcher/espeak-ng; macOS and Windows use
their native voices, which sound noticeably better.

Replies are cleaned before they're spoken: a markdown reply read literally would say
"asterisk asterisk important asterisk asterisk". Code blocks are never read (the engine
announces a code block instead), links are read as their label, and bare URLs are dropped.
Long replies are spoken in sentence-sized chunks so nothing gets truncated. Only one reply
plays at a time; `Esc` in the panel stops the reading.

### 4. Voice Assistant composer fix on Linux

Upstream creates the dictation overlay as a non-focusable window so it never steals focus
from the app you're dictating into. Electron's `setFocusable()` is macOS/Windows-only,
though, so on Linux that flag was permanent — meaning the Voice Assistant panel's text
field could never take the keyboard. Typing went to whatever app was focused before, and
reopening the panel didn't help.

The overlay is now created focusable on Linux, except on the compositors whose focus
theft motivated the original flag (the wlroots family and i3), where the guard stays.
`showInactive()` keeps the pill out of the way elsewhere, which was verified on Mutter.

### 5. The assistant can open things for you

Say **"open vscode"** and it runs `code`; say **"search for capybaras"** and your browser
opens on the results. The assistant has a `run_command` tool, and what it is allowed to do
is decided in the main process, never by the model:

- Names you list in **`~/.openwhispr/commands.txt`** run immediately, with no prompt. One
  per line, names comma-separated, `#` for comments:

  ```
  vscode, vs code      = code
  search, look up      = https://duckduckgo.com/?q=%s
  files                = nautilus
  ```

- A value starting with `https://` is a **link, not a program**: `%s` is replaced with what
  you said, URL-encoded, so `search capybaras` opens a real search page. Links are the one
  thing that never needs a confirmation — a link cannot run anything.
- A `!` in front of a value **reads the command's output**:

  ```
  ls, list files       = !ls
  disk space           = !df -h /
  ```

  Saying "ls Downloads" then runs `ls Downloads`, waits for it, and hands what it printed
  to the assistant, which can answer from it ("here's what's in your Downloads folder…").
  The wait is bounded twice: the text is capped (a command that prints forever cannot flood
  the reply) and a command still running after 10 seconds is stopped and reported as
  stopped, so one that never exits cannot hang the request. Only mark commands that end on
  their own. A command approved in the dialog can ask for its output with the
  **Show me the output** checkbox instead, which is the same thing for a one-off.
- Anything else still runs, but only after a dialog shows you the exact command with
  **Run / Run and remember / Cancel**. Remembered commands go in
  `~/.openwhispr/approved-commands.json`.
- A few commands are **refused outright and can never be approved**, because they destroy
  the machine rather than do a job: `rm -rf /`, `rm -rf ~`, `mkfs`, `dd of=/dev/sda`, fork
  bombs, `chmod -R 777 /`, and writes to `~/.ssh/authorized_keys`. Ordinary cleanup like
  `rm -rf ~/Downloads/tmp` is *not* on that list — it goes to the dialog like anything else.

Matching is forgiving, because what reaches the tool is a rephrasing of what you said:
case, spacing and punctuation are ignored (`vscode`, `VS Code`, `vs-code` are one name), a
leading verb is dropped (`open vscode`, `launch vs code`), and words after a name become
arguments (`vscode ~/notes` runs `code ~/notes`).

**The file is the switch.** Delete `commands.txt` and the tool refuses everything, including
the approval path.

Some things worth knowing, because they are the security model rather than rough edges:

- An alias is standing permission, arguments included. Anything that reaches the model — a
  web page, a note, a pasted screenshot — can ask for an alias by name and get it with no
  prompt, and can pass it plain-word arguments (`files Downloads`). Arguments carrying shell
  syntax are refused instead and fall through to the dialog, so an alias cannot be turned
  into a shell. A local model is easy to confuse, so keep aliases to things whose worst case
  is "it opened the wrong thing".
- The dialog shows the command and nothing else; there is deliberately no model-written
  "reason" above it to argue for the click. When a command uses shell operators (`|`, `;`,
  `$`, `>`), the dialog says so, because that is where a confused model does damage.
- Commands run detached, so an app you open stays open after Ava quits — and that is why
  output only comes back when it was asked for, with a `!` alias or the dialog's checkbox.
  The default is to walk away, because waiting on a window you just opened would be wrong.
- Read-back output is text from your machine entering the model's context, which is a
  channel the silent path does not have: a file name, a log line or a `curl` result could
  contain something that looks like an instruction. Passages like that are why the read-back
  wait is bounded and why the output is capped before the model reads it.

## Status and caveats

- **Naming.** This is the fork's product name. Internal identifiers — the package name,
  app id, install directory, and in-app product strings — still say OpenWhispr, because
  renaming them changes where user data lives. Treat "Ava AI assistant" as the project
  name for now, not yet a rebranded build.
- **No binaries.** There are no Ava releases; build from source with the steps below.
  Prebuilt installers for the unmodified app are on
  [upstream's releases page](https://github.com/OpenWhispr/openwhispr/releases).
- **PDF support adds a dependency** (`pdfjs-dist`), which is the single largest change to
  upstream's `package-lock.json`.
- **The new UI strings are English-only.** They are not in the locale bundles, on purpose:
  this repo's checks require every key to exist in all 11 languages, so translating two
  new buttons would mean touching thirteen upstream files. See `useSpeechControl.ts` and
  `useChatAttachments.ts` for where to add them.

## Building

Requires Node.js 24+ (the pinned version in `.nvmrc`; using another major will break
`npm ci` in CI).

```bash
git clone https://github.com/YOUR-USERNAME/ava-ai-assistant.git
cd ava-ai-assistant
npm install
npm run dev
```

Packaging is upstream's: `npm run build:linux:appimage`, `npm run build:mac`,
`npm run build:win`. See the [upstream docs](https://docs.openwhispr.com/quickstart) for
platform setup, code signing, and build details.

The mobile application lives in [`openwhispr-mobile`](openwhispr-mobile/) and is untouched
by this fork.

## Features inherited from OpenWhispr

Everything below is upstream's work, documented here because it is most of the app.

- **Voice dictation** — global hotkey to dictate into any app with automatic pasting
- **Dictation translation** — dedicated hotkey to dictate in one language and paste the text in another
- **AI agent** — talk to GPT-5, Claude, Gemini, Groq, Tinfoil, OpenRouter, or local models with a named voice assistant
- **Voice Assistant hotkey** — dedicated hotkey that sends what you say straight to your AI assistant as a command, no wake word needed and no cleanup pass; highlighted text is edited in place. With auto-paste enabled, answers paste at a focused text cursor or stream into a floating panel and copy to the clipboard when no writable cursor is available. You can also opt in to sending a screenshot of your current screen as context
- **Meeting transcription** — auto-detect Zoom, Teams, and FaceTime calls with live speaker diarization, voice fingerprinting, and Google, Microsoft, or Apple Calendar integration
- **Local speaker diarization** — on-device speaker labelling with voice fingerprint recognition across meetings, no cloud required
- **Notes** — create, organize, and search notes with folders, semantic search, cloud sync, and AI actions
- **Team spaces & sharing** — free for signed-in users; share notes on the web with link, domain, or invite-only visibility, and collaborate in team spaces with roles, invitations, and server-enforced membership
- **Audio import** — transcribe existing audio and video: drag in files, batch-upload, or paste a YouTube/audio URL, with optional speaker detection
- **Local or cloud — your choice** — all core features (transcription, AI reasoning, speaker diarization, semantic search) work with local models or cloud providers — including GPU-accelerated local Whisper on Metal, CUDA, and Vulkan (AMD/Intel)
- **Enterprise controls** — enforce organization policy, company SSO and SCIM, and centrally managed Amazon Bedrock or Azure OpenAI access without distributing cloud keys
- **Public API & MCP** — manage notes and transcriptions programmatically or connect your AI assistant via the [MCP server](https://docs.openwhispr.com/integrations/mcp)

## Documentation

Upstream's documentation applies to this fork, since the features it describes are
unchanged: **[docs.openwhispr.com](https://docs.openwhispr.com)**.

- [Getting started](https://docs.openwhispr.com/quickstart)
- [Platform guides](https://docs.openwhispr.com/platform/macos) (macOS, Windows, Linux)
- [API reference](https://docs.openwhispr.com/api/overview)
- [MCP server setup](https://docs.openwhispr.com/integrations/mcp)
- [Troubleshooting](https://docs.openwhispr.com/troubleshooting)

## Tech stack

React 19, TypeScript, Tailwind CSS v4, Electron 41, better-sqlite3, whisper.cpp,
sherpa-onnx, shadcn/ui — plus `pdfjs-dist` for PDF attachments, added by this fork.

## Contributing

Issues and pull requests for the fork's own additions are welcome here. For anything that
isn't specific to this fork, please send it to
[upstream](https://github.com/OpenWhispr/openwhispr) instead — that's where the app is
maintained and where the fixes belong.

If you are maintaining this fork, read **[AGENTS.md](AGENTS.md)**: it lists every file this
fork touches, the constraints that must not be undone, and how to merge upstream's changes
without breaking them.

## License

[MIT](LICENSE) — free for personal and commercial use. Copyright (c) 2024 OpenWhispr Team.

This fork is distributed under the same license as the project it is built on.

## Acknowledgments

All of the machinery below is upstream's; this fork only adds to it.

- **[OpenWhispr](https://github.com/OpenWhispr/openwhispr)** — the application this fork is built on
- **[OpenAI Whisper](https://github.com/openai/whisper)** — speech recognition model powering local and cloud transcription
- **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** — high-performance C++ implementation for local processing
- **[NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)** — fast multilingual ASR model
- **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** — cross-platform ONNX runtime for Parakeet inference
- **[Hugging Face](https://huggingface.co/)** — model hub hosting Whisper, Parakeet, and embedding model weights
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** — local LLM inference for AI text processing
- **[pdf.js](https://mozilla.github.io/pdf.js/)** — PDF text extraction for attachments (fork addition)
- **[Electron](https://www.electronjs.org/)** — cross-platform desktop framework
- **[React](https://react.dev/)** — UI component library
- **[shadcn/ui](https://ui.shadcn.com/)** — accessible components built on Radix primitives
- **[Neon](https://console.neon.tech/app/?promo=openwhispr)** — serverless Postgres powering OpenWhispr Cloud
