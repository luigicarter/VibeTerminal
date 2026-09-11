# Bundled voice error alerts

These English WAV clips are generated locally with the installed Windows
System.Speech voice listed in `manifest.json`. They contain only fixed application
error and voice-feedback messages. No end-user audio files are ever written by
this feature. The exact fixed text is defined in `backend/localErrorAudio.cjs`
and recorded in `manifest.json` alongside each clip's checksum.

Runtime playback reads these bundled clips, validates their SHA-256 checksums,
and sends 24 kHz mono signed 16-bit PCM to the existing playback path. It requires
no operating-system speech synthesizer, network connection, OpenRouter request,
or paid API. These clips provide runtime fallback speech for failed requests,
missed or empty speech, transcription failures, spoken-reply failures, a busy
orchestrator, the session spending limit, and rejected answers. If an asset is
unavailable or invalid, the caller shows text only.

Maintainers can regenerate the files offline on Windows using
`node scripts/dev/generate-error-audio.cjs`. Generation selects an installed
English female voice when available, otherwise an installed English voice.
Pass category names to generate only selected clips while validating and
preserving all others, for example
`node scripts/dev/generate-error-audio.cjs not-understood transcription`.
It never plays audio through the speakers. Commit the WAV files together with
the generated manifest; do not regenerate them on an end-user machine.
