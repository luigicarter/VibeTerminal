# Voice Dictation (Speech-to-Text)

> **Status: proposed design sketch — not implemented.** Nothing in this document
> exists in the codebase yet. It captures the research and architecture decided
> in a sketch session so the work can be picked up later. When/if built, update
> this file to describe what actually shipped.

Goal: let the user dictate into any pane — claude, cursor-agent, codex, opencode,
or a bare shell — with a "super light, super efficient" speech-to-text path,
ideally without a heavy local neural net / LLM.

## Key finding 1: how Claude Code's `/voice` actually works

Claude Code's `/voice` (v2.1.69+) is **not** lightweight because it avoids a
neural net. Per Anthropic's [voice-dictation docs](https://code.claude.com/docs/en/voice-dictation):

- It records mic audio and **streams it to Anthropic's servers** for
  transcription — *"audio is not processed locally."*
- It only works when authenticated with a **Claude.ai account** (not API key,
  Bedrock, Vertex, or Foundry).
- Coding-vocabulary tuning and the project-name / git-branch recognition hints
  are server-side.

So it is light *on the client* precisely because the heavy ASR model runs
**remotely**. "No heavy local neural net" and "as accurate as Claude Code" pull
in opposite directions — that is the core trade for any path we pick.

We **cannot** reuse Claude's `/voice` for the other CLIs: it is internal to the
`claude` binary, Claude.ai-account-gated, and may not even capture the mic
cleanly from a PTY child inside Electron.

## Key finding 2: STT is not a per-provider feature here

The PTY input path is fully provider-agnostic:

```
xterm onData → window.vibe.terminal.input(id, data)   (frontend/components/TerminalPane.tsx)
             → preload IPC → main → ptyHost "input" handler
             → session.terminal.write(data)            (backend/ptyHost.cjs)
```

`ptyHost.cjs` does a blind `terminal.write()` — claude, cursor-agent, codex,
opencode, and a bare PowerShell all receive identical bytes. There is also an
existing text-injection path: `pasteText(text) → terminal.paste(text)` in
`TerminalPane.tsx`, which re-emits through the same `onData → input` pipe.

**Conclusion:** build **one** app-level dictation feature (mic → text → inject
into the focused pane). It covers every provider — including the Claude pane —
identically. There is nothing Claude-specific to replicate.

## Architecture sketch

```
┌─ renderer ────────────────────────────────────────────┐
│  useDictation()                                         │
│    • getUserMedia({audio}) — push-to-talk on/off       │
│    • AudioWorklet → 16kHz mono PCM frames              │
│    • Transcriber (swappable)                            │
│         onPartial(text) → live overlay (dimmed)        │
│         onFinal(text)   → inject into focused pane     │
└───────────────────────────┬───────────────────────────┘
                            ▼
   terminal.injectText(selectedId, text)   ← mirror onContextMenuPaste pattern
                            ▼
   matching TerminalPane → pasteText(text) → terminal.paste()
                            ▼
   onData → window.vibe.terminal.input(id) → ptyHost write()  (already exists)
```

The right-hand side already exists. Delivering text to the correct pane should
copy the existing `onContextMenuPaste` listener pattern in `TerminalPane.tsx`
(main/controller broadcasts `{id, text}`; the pane whose id matches injects it).

### The swappable seam: `Transcriber`

```ts
// sketch — not real code
interface Transcriber {
  start(): void
  pushAudio(frame: Int16Array): void   // streaming engines
  stop(): Promise<string>              // final text
  onPartial?(cb: (t: string) => void)  // interim, dimmed
}
```

Picking/changing an engine = writing one adapter; nothing else moves.

## Engine options (Electron-on-Windows reality)

| Option | Local? | Footprint | Neural net? | Accuracy | Verdict |
|---|---|---|---|---|---|
| Web Speech API (`webkitSpeechRecognition`) | No (Google cloud) | ~0 | remote | Good | **Broken in Electron** (see below) |
| Cloud STT (Deepgram / Groq-Whisper / OpenAI) | No | ~0 client | remote | Excellent | "Same as Claude Code" path |
| **Vosk** (Kaldi) | **Yes** | ~50 MB model, CPU | small DNN-HMM, not an LLM | Decent | Best "light + offline" path |
| whisper.cpp tiny/base | Yes | 75–140 MB, heavier | transformer (LLM-ish) | Very good | The "heavy" thing to avoid |
| PocketSphinx (GMM-HMM) | Yes | tiny | truly no neural net | Poor for free speech | Not viable for coding prompts |

Verified gotchas:

- **Web Speech API does not work in Electron.** `webkitSpeechRecognition` throws
  a `network` error because the Google Speech key is baked into official Chrome
  builds and absent from Electron — a long-standing
  [documented limitation](https://github.com/electron/electron/issues/7749).
  Setting `GOOGLE_API_KEY` does not wire it up for speech. Scratch this option.
- **Vosk is the local sweet spot:** [50 MB models, CPU-only, streaming with
  <500 ms latency, Node.js bindings](https://alphacephei.com/vosk/), fully
  offline. It is a small Kaldi DNN-HMM — not a transformer/LLM, not "heavy."
- **Win+H (Windows 11 Voice Typing)** is a zero-code stopgap: with a pane
  focused, dictated text should land in xterm's hidden `<textarea>` and forward
  through the normal `onData` path. Worth a manual test first — it validates the
  inject path with no build.

## Decision status

Direction chosen in the sketch session: **build the app-level, provider-agnostic
feature.** Engine not yet locked. The remaining fork:

- **Local & offline (Vosk):** ~50 MB model + native dep shipped; private, no
  cost, no network; decent (not Claude-level) accuracy.
- **Cloud (same as Claude Code):** thinnest client, best accuracy; needs network
  + API key + per-use cost.

The vibeTerminal-side code (capture + inject) is identical either way; only the
`Transcriber` adapter differs.

## Open design questions

1. **Push-to-talk key — cannot copy Claude's "hold Space."** vibeTerminal
   forwards Space to the CLI, so hold-Space-to-talk would corrupt typing in the
   pane. Use a global chord (Electron `globalShortcut`, e.g. `Ctrl+Shift+Space`)
   or a click-and-hold mic button instead.
2. **Interim "dimmed" text is hard in a PTY.** We cannot paint inside the CLI's
   input line. Options: (a) a floating overlay near the pane showing the live
   transcript, inject final text on release (closest to Claude's feel); or
   (b) final-text-only, no preview (simplest). Lean to (a), ship (b) first.
3. **Do not auto-submit.** Inject without a trailing newline so the user reviews
   and presses Enter — matches Claude's "insert at cursor, don't send" and avoids
   firing a half-heard prompt at an agent. `terminal.paste()` already handles
   bracketed paste, so multiline dictation lands correctly.

## Likely file touch-points (when implemented)

| Piece | Location |
|---|---|
| Mic permission (`media`) | `backend/main.cjs` (`session.setPermissionRequestHandler`) |
| Capture + controller | new `frontend/voice/useDictation.ts` (AudioWorklet 48k→16k) |
| Engine host (if Vosk) | new `backend/voskHost.cjs` (clone the `ptyHost.cjs` JSON-line process model) |
| Inject IPC | `preload/preload.cjs` + main (`terminal.injectText(id, text)` + pane event) |
| Mic button / recording indicator | `frontend/components/TerminalPane.tsx` header `pane-actions` |

Packaging note for the Vosk path: native dep needs `electron-rebuild` (per-arch)
and the ~50 MB model ships in the installer — relevant to `docs/windows-release.md`.
