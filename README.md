<p align="center">
  <img src="src/assets/logo.svg" alt="Eva AI assistant" width="120" />
</p>

<h1 align="center">Eva AI assistant</h1>

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
> Eva AI assistant is built on [OpenWhispr](https://github.com/OpenWhispr/openwhispr) and
> tracks it closely. The overwhelming majority of this codebase — the dictation engine,
> meeting transcription and diarization, notes, calendar sync, semantic search, the
> cloud/self-hosted/local model plumbing, and every platform integration — is upstream's
> work, unchanged.
>
> This README documents the whole app, but **[What Eva adds](#what-eva-adds)** below is the
> only part that is this fork's own. If you want the app without those additions, use
> [upstream](https://github.com/OpenWhispr/openwhispr).

## What Eva adds

Seven changes on top of upstream. Each is deliberately narrow and lives mostly in new
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

### 5. The assistant can open things, run things, and read the answers back

Say **"open vscode"** and it runs `code`. Say **"search for capybaras"** and your browser
opens on the results. Say **"ls Downloads"** and it runs the command and tells you what is
in there. One tool (`run_command`) does all three, and everything it may do is decided in
the **main process** — never by the model, and never by the renderer.

#### The commands file

Your aliases live in **`~/.openwhispr/commands.txt`**, one per line:

```
name, another name = the thing to run
```

Names are comma-separated so speech-to-text variance fans into one command — `vscode`,
`vs code` and `VS Code` all land on the same line. `#` starts a comment, blank lines are
ignored, and the value is everything after the **first** `=` (so a command may contain one).
**This file is the switch**: delete it and the tool refuses everything, approval path
included. There is no setting to find and no toggle to leave on.

#### Four kinds of value

| You write                      | It is                    | What happens                                          |
| ------------------------------ | ------------------------ | ----------------------------------------------------- |
| `code`                         | a program                | launched detached, so it outlives Eva. **No dialog.** |
| `https://github.com`           | a link                   | opened in your browser. **No dialog.**                |
| `https://duckduckgo.com/?q=%s` | a search link            | `%s` takes what you said, URL-encoded                 |
| `!df -h /`                     | a program, **read back** | runs, waits, the output goes to the assistant         |

A plain program value is launched and forgotten: right for opening a window, useless for
anything whose point is what it prints. That is what the `!` and the link forms are for.

#### A starter file

Copy this in and delete what you don't have installed. A name whose program is missing is
refused with a message saying so — and naming your other aliases, so the model retries with
one of those — so a leftover line is harmless, just noisy.

```ini
# --- the basics -------------------------------------------------------------
vscode, vs code = code
terminal        = ghostty
files           = nautilus

# --- looking things up ------------------------------------------------------
# `%s` is replaced with the words you said, escaped, so a link can never be
# talked into running anything. Links never need a confirmation.
search, look up = https://www.google.com/search?q=%s
youtube         = https://www.youtube.com/results?search_query=%s
maps, map       = https://www.google.com/maps/search/?api=1&query=%s

# --- sites, opened by name --------------------------------------------------
github   = https://github.com
mail     = https://mail.google.com
calendar = https://calendar.google.com

# --- answers, not windows ---------------------------------------------------
# The `!` makes the assistant wait and report what the command printed.
ls, list files = !ls
disk space     = !df -h /
uptime         = !uptime
memory         = !free -h
```

#### Editors, terminals and dev tools

```ini
vscode, vs code = code
insiders        = code-insiders
terminal        = ghostty
idea            = idea
pycharm         = pycharm
sublime         = subl
api client      = postman
database        = dbeaver
```

Full-screen programs (`vim`, `nvim`, `htop`, `top`, `ssh`, `lazygit`) need a terminal of
their own — see [showing you things](#showing-you-things-not-the-assistant) below, because a
bare `vim = vim` launches into nowhere.

#### Browsers and websites

```ini
browser   = firefox
chrome    = google-chrome
github    = https://github.com
mail      = https://mail.google.com
calendar  = https://calendar.google.com
drive     = https://drive.google.com
news      = https://news.ycombinator.com
dashboard = http://localhost:3000
```

Point `dashboard` at whatever you actually run locally — a dev server, a router page, a
home-server UI.

#### Searching from the assistant

```ini
search        = https://www.google.com/search?q=%s
youtube       = https://www.youtube.com/results?search_query=%s
maps, map     = https://www.google.com/maps/search/?api=1&query=%s
wikipedia     = https://en.wikipedia.org/w/index.php?search=%s
translate     = https://translate.google.com/?text=%s
stackoverflow = https://stackoverflow.com/search?q=%s
npm           = https://www.npmjs.com/search?q=%s
crates        = https://crates.io/search?q=%s
```

Any site with a search box is one line: find the query parameter, put `%s` where the words
go. "search the crates registry for serde" then opens it with the query already typed.

#### Folders

Words after a name are passed along as arguments, so `files Downloads` opens that folder.

```ini
files, file manager = nautilus
downloads           = nautilus ~/Downloads
projects            = nautilus ~/sites
screenshots         = nautilus ~/Pictures/Screenshots
```

#### Communication, media and apps

```ini
discord  = discord
telegram = telegram-desktop
slack    = slack
signal   = signal-desktop
mail app = thunderbird
music    = spotify
player   = vlc
photos   = gimp
ebooks   = calibre
torrents = qbittorrent
```

#### System settings and controls

```ini
monitor, task manager = gnome-system-monitor
settings              = gnome-control-center
wifi                  = gnome-control-center wifi
bluetooth             = gnome-control-center bluetooth
sound settings        = gnome-control-center sound
calculator            = gnome-calculator
system logs           = gnome-logs
lock, lock screen     = loginctl lock-session
mute                  = wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle
volume up             = wpctl set-volume -l 1.5 @DEFAULT_AUDIO_SINK@ 5%+
volume down           = wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-
```

`wpctl` and `loginctl` are Linux/PipeWire. The closest equivalents elsewhere:

```ini
# macOS
files    = open ~
terminal = open -a Terminal
settings = open -b com.apple.systempreferences
mute     = osascript -e 'set volume output muted true'

# Windows
files    = explorer
terminal = wt
settings = start ms-settings:
```

#### Answering questions (read-back)

A `!` makes the assistant wait for the command and answer from what it printed. This is the
form to reach for whenever you want the _answer_ rather than the window.

```ini
ls, list files = !ls
disk space     = !df -h /
memory         = !free -h
uptime         = !uptime
who is online  = !who
battery        = !upower -i $(upower -e | grep -i bat)
git status     = !git -C ~/code/myproject status --short
containers     = !docker ps
pods           = !kubectl get pods
weather report = !curl -s "wttr.in/?format=3"
my ip          = !curl -s ifconfig.me
```

Two bounds make this safe to use, and both are worth knowing about:

- **The wait is bounded.** A command still running after 10 seconds is stopped — killed as a
  process group, not just its shell — and reported as stopped rather than as finished. So
  only mark commands that end on their own: `!tail -f`, `!top` or a GUI app will be started
  and then killed.
- **The text is capped.** What the command prints is capped on the way out of the machine,
  and capped again (much lower) on the way into the model, because a local model's context
  window is small — see [tools and local models](#7-tools-work-with-local-models). `ls -R`
  of a big tree is thousands of lines; the model reads the head of it.

#### Showing you things (not the assistant)

A launched command gets no terminal — it is detached so it can outlive Eva — so a command
whose only job is to print has to either read back with `!` or surface itself:

```ini
top        = ghostty -e htop
containers = ghostty -e docker ps
logs       = ghostty -e journalctl -f
dev server = ghostty --working-directory=$HOME/code/myproject -e npm run dev
ip address = notify-send "IP" "$(curl -s ifconfig.me)"
disk space = notify-send "Disk" "$(df -h / | tail -1)"
```

`notify-send` is Linux. On macOS, `osascript -e 'display notification "…"'`; on Windows, a
PowerShell `New-BurntToastNotification` or a `msg` — or just use the `!` form and let the
assistant tell you.

#### Matching: what you say vs what you write

Matching is forgiving, because what reaches the tool is a rephrasing of what you said:

- **Case, spacing and punctuation are ignored** — `vscode`, `VS Code` and `vs-code` are one
  name.
- **A leading verb is dropped** — "open vscode", "launch vs code" and "run code" all match.
- **Words after a name become arguments** — `vscode ~/notes` runs `code ~/notes`, and
  `files /etc` runs `nautilus /etc`. They ride along only when they contain no shell syntax;
  anything with a `;`, `|`, `$(`, `>` or a quote goes to the dialog instead.
- **The value works too** — saying "code" or "df -h /" hits the same line, with no dialog,
  because a model that names the program instead of your nickname for it meant the same
  thing.
- **The name has to be near the start** of what the model sends (or one word in, after a
  verb). A heavily rephrased request falls through to the dialog instead — a dialog, never a
  wrong launch. That is deliberate: matching loosely enough to catch "how is the weather"
  mid-sentence is also loose enough to open your Billund page for "weather copenhagen".

#### Approving something that is not in the file

Anything unlisted still runs, after a dialog showing the **exact** command with **Run /
Run and remember / Cancel**. Enter and Escape both decline, so a stray keypress cannot
approve anything. "Run and remember" appends to `~/.openwhispr/approved-commands.json` and
silences that exact command from then on.

Two details worth knowing:

- The dialog has a **Show me the output** checkbox. Tick it and a one-off command reads back
  like a `!` alias — and if you also pick "Run and remember", that choice is remembered with
  it.
- If the program is not installed, you get that message instead of a dialog: no prompt to
  answer about something that cannot run.

#### What it refuses

A few commands are **refused outright and can never be approved**, because they destroy the
machine rather than do a job: `rm -rf /`, `rm -rf ~`, `mkfs`, `dd of=/dev/sda`, fork bombs,
`chmod -R 777 /`, and writes to `~/.ssh/authorized_keys`. Ordinary cleanup like
`rm -rf ~/Downloads/tmp` is _not_ on that list — it goes to the dialog like anything else.
The refusal applies to aliases too, so a `!` alias cannot be used to slip past it.

#### Worth knowing, because this is the security model rather than rough edges

- **An alias is standing permission, arguments included.** Anything that reaches the model —
  a web page, a note, a pasted screenshot, a PDF you attached — can ask for an alias by name
  and get it with no prompt, and can pass it plain-word arguments (`files Downloads`).
  Arguments carrying shell syntax are refused and fall through to the dialog, so an alias
  cannot be turned into a shell. Keep aliases to things whose worst case is "it opened the
  wrong thing".
- **Don't alias a general-purpose tool.** A `docker = docker` or `git = git` line would let
  the model append its own arguments — only shell syntax is filtered there — and those run
  with no dialog. `containers = !docker ps` is one fixed action; `docker` is a blank cheque.
- **The dialog shows the command and nothing else.** There is deliberately no model-written
  "reason" above it to argue for the click; the assistant's explanation belongs in the chat,
  at the same trust level as everything else it says. That is also why the tool takes no
  `reason` parameter.
- **Output is opt-in, because waiting is usually wrong.** An app you open should outlive
  Eva, so the default is to launch and walk away — output comes back only when you asked,
  with a `!` alias or the checkbox. The model cannot ask for it; only you can.
- **Read-back is a new channel.** It puts text from your machine into the model's context,
  which the silent path does not: a file name, a log line or a `curl` result could contain
  something shaped like an instruction. That is why the wait is bounded and the text is
  capped before the model reads it.

### 6. The assistant knows the date and time

Upstream only put a clock in the agent's prompt when a calendar tool happened to be
available, so with no calendar connected, "what time is it?" got you _"I don't have
real-time clock access — check your phone."_ The local date and time is now part of every
agent prompt, calendar or not, so time-relative questions ("is it too late to call?",
"what's on tomorrow?") have something to stand on.

### 7. Tools work with local models

Self-hosted models were only given the tool registry when their id declared a parameter
count of 4B or more. The parser understood `llama-3.1-8b-instruct` but not Ollama's
`name:tag` form, so `gemma4:e4b` was estimated at 0B and served **no tools at all** — which
is how a perfectly good model ends up insisting "I am a text-based AI and cannot run that"
while every other part of the app is fine.

- `src/models/localModelSize.ts` reads `4b`, `e4b`, `27b-a3b`, `gemma4:e4b` and friends.
- The 4B floor still applies to models you download in-app: a 1B model handed a dozen tool
  schemas is worse than no tools, because it will call the wrong one.
- A **self-hosted** model whose size cannot be read at all is allowed tools. You chose it and
  pointed the app at it; second-guessing that is not this code's job.

**One caveat that will bite long conversations.** Eva does not set `num_ctx`, so Ollama uses
the model's default — 4096 tokens for `gemma4:e4b` — and when a prompt is longer than that it
truncates **silently**, dropping the _oldest_ part. That is the system prompt, and the tool
instructions live there, so the symptom is a model that suddenly forgets it can run
commands, in a conversation that was working a minute ago. Raise it for the model you use:

```
# Modelfile
FROM gemma4:e4b
PARAMETER num_ctx 8192
```

```
ollama create gemma4-8k -f Modelfile
```

Then pick `gemma4-8k` in Settings → AI Models. Tools plus a system prompt plus a few turns
of history add up faster than you would think — measured, nine tools and no history already
spend about 2200 of those 4096 tokens.

## Status and caveats

- **Naming.** This is the fork's product name. Internal identifiers — the package name,
  app id, install directory, and in-app product strings — still say OpenWhispr, because
  renaming them changes where user data lives. Treat "Eva AI assistant" as the project
  name for now, not yet a rebranded build.
- **No binaries.** There are no Eva releases; build from source with the steps below.
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
git clone https://github.com/YOUR-USERNAME/eva-ai-assistant.git
cd eva-ai-assistant
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
