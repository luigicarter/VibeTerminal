# Voice cutoff analysis — September 16, 2026

The subsequent [repair](voice-cutoff-repair-2026-09-16.md) implements a 1.5-second
default and adjustable pause. This document retains the pre-repair evidence.

Analysis only; no voice behavior or installed-profile changes. Compared the
installed v0.1.125 `voiceController.cjs` with source: identical after newline
normalization. The preceding Orchestrator routing repair did not change it.

## Main finding

Automatic capture intentionally commits after **600 ms of classified silence**
when the local turn detector returns a completion score of at least 0.9 and
there has been at least 250 ms of live command speech. This is short enough to
consume a thinking pause between clauses. It is a policy/expectation mismatch;
passing the existing tests does not establish that it tolerates Ahmed's pauses.

`apps/desktop/backend/voiceController.cjs` defines the timings at lines 13–27,
chooses the pause at line 96, starts semantic analysis after 200 ms quiet at
line 320, and commits at lines 344–348. A score above 0.5 but below 0.9 uses
1,200 ms; a non-complete/uncertain result falls back to 3,000 ms. A model score
is not proof that a speaker has finished their whole request.

The local model evaluates the last eight seconds of audio. Its result is cached
for that speech revision; an unchanged pause does not cause a second semantic
check. Speech recognized before commitment invalidates it. Once commitment
happens, `finishRecording` freezes the WAV, clears the turn and starts
transcription. Later speech is not appended to that request. VAD/wake processing
is inactive during transcription/thinking, although a bounded audio ring remains.

## Retained live evidence

Read `%APPDATA%/vibe-terminal/logs/orchestrator-errors.jsonl` and its two rotations,
plus the separate voice-inference logs. Counts are retained samples, not a
complete history or a measured error rate.

| Window | 600 ms semantic end | 1,200 ms semantic end | 3,000 ms fallback |
| --- | ---: | ---: | ---: |
| Since September 13 | 18 | 6 | 2 |
| September 15 evening + September 16 morning, Toronto | 13 | 3 | 2 |
| September 16 morning | 3 | 0 | 1 |

Morning finishes at 08:55:00, 08:56:02 and 08:56:44 Toronto used exactly 600 ms;
their scores were approximately 0.983, 0.980 and 0.987. They are recorded at
current log lines 2144, 2193 and 2223. The 08:55:29 answer used the three-second
fallback (line 2164). That variability also explains why some pauses are tolerated
while others immediately end capture.

No matching recent voice-error/drop/overflow entries were found in the retained
logs for this evening/morning window. These records strongly support the fast
endpoint as the main explanation; they cannot establish which specific words
were lost. Original audio was not replayed. Quiet speech misclassified as silence
remains possible but unproven.

## Reproduction and existing test gap

Used the existing endpointing fixture with mocked microphone classifications,
completion model and transcription transport; no microphone, live model, or
real terminal involved. The isolated script is
`apps/desktop/.tmp/voice-cutoff-analysis.cjs`.

- Simulated 700 ms thinking pause, completion score 0.99: recording had already
  ended at 600 ms and was transcribing. Resumed speech did not extend the uploaded
  recording (19,200 samples).
- Same pause with score 0.7: recording remained open, retained resumed speech,
  and ended after the later 1,200 ms pause (40,000 samples).
- Both diagnostic reproduction assertions passed. Existing
  `voice-endpointing.test.cjs`: 10/10 passed, including a test that explicitly
  requires the 600 ms cutoff. Existing resumed-speech cases use a lower initial
  score and resume while recording is still open; they do not prove protection
  against a high-confidence premature endpoint.

## Recommended correction

Use an adjustable automatic pause with a more forgiving default, initially
around 1,500 ms, and remove the score-driven 600 ms shortcut. Keep early
transcription speculative: it can reduce latency while the recorder remains
open, but resumed speech must discard it. Preserve the existing buffered-frame
and capture/revision checks. Provide immediate explicit send for short commands.

Regression acceptance should include a falsely confident completion followed by
speech after 600–1,200 ms, long requests with natural clause pauses, quiet endings,
answer recording and manual-hold adoption, alongside the existing no-duplicate
transcription checks. Tune against consented real-microphone examples; synthetic
scores and timings cannot establish recognition quality in the user's room.

The hands-free documentation also has an obsolete earlier statement that sending
always waits at least 1.2 seconds; its later adaptive-pause section correctly
describes 600 ms. The running code and recorded timings establish actual behavior.
