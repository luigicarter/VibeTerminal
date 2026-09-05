// Maintainer-only, offline asset generation. Runtime never invokes speech synthesis.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ERROR_AUDIO_TEXT, createLocalErrorAudio } = require('../../backend/localErrorAudio.cjs');

if (process.platform !== 'win32') throw new Error('Generation requires Windows System.Speech; playback does not.');
const directory = path.resolve(__dirname, '../../vendor/voice/alerts');
fs.mkdirSync(directory, { recursive: true });
const quote = value => `'${value.replaceAll("'", "''")}'`;
const speechCommands = Object.entries(ERROR_AUDIO_TEXT).map(([category, text]) => `$synth.SetOutputToWaveFile(${quote(path.join(directory, `${category}.wav`))}, $format)\n$synth.Speak(${quote(text)})\n$synth.SetOutputToNull()`).join('\n');
const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'en' })
  $selected = $voices | Where-Object { $_.VoiceInfo.Gender -eq 'Female' } | Select-Object -First 1
  if (-not $selected) { $selected = $voices | Select-Object -First 1 }
  if (-not $selected) { throw 'An installed English voice is required' }
  $synth.SelectVoice($selected.VoiceInfo.Name)
  $synth.Rate = 0
  $synth.Volume = 100
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  ${speechCommands}
  [Console]::WriteLine($synth.Voice.Name)
} finally { $synth.Dispose() }
`;
const voice = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120000, encoding: 'utf8' }).trim();
const clips = Object.fromEntries(Object.entries(ERROR_AUDIO_TEXT).map(([category, text]) => [category, {
  file: `${category}.wav`, text, voice, sampleRate: 24000, channels: 1, format: 's16le',
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, `${category}.wav`))).digest('hex'),
}]));
fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify({ version: 1, generator: 'Windows System.Speech.Synthesis.SpeechSynthesizer (offline)', clips }, null, 2)}\n`);
const loader = createLocalErrorAudio({ directory });
for (const category of Object.keys(clips)) console.log(`${category}: ${loader.load(category).durationMs} ms (${voice})`);
