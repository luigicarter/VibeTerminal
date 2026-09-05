# Bundled voice error alerts

These seven English WAV clips are generated locally with the installed Windows
System.Speech voice listed in `manifest.json`. They contain only fixed application
error messages. No end-user audio files are ever written by this feature.

Runtime playback reads these bundled clips, validates their SHA-256 checksums,
and sends 24 kHz mono signed 16-bit PCM to the existing playback path. It requires
no operating-system speech synthesizer, network connection, OpenRouter request,
or paid API. If an asset is unavailable or invalid, the caller shows text only.

Maintainers can regenerate the files offline on Windows using
`node scripts/dev/generate-error-audio.cjs`. Generation selects an installed
English female voice when available, otherwise an installed English voice.
It never plays audio through the speakers. Commit the WAV files together with
the generated manifest; do not regenerate them on an end-user machine.
