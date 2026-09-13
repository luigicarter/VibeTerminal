'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripWakePrefix } = require('../../shared/voiceWakePhrase.cjs');

test('every accepted wake pronunciation is removed from the start of a transcript', () => {
  for (const [text, expected] of [
    ['Hey Lina, show my agents', 'show my agents'],
    ['hey lina show my agents', 'show my agents'],
    ['HEY LINA! show my agents', 'show my agents'],
    ['HEY LENA! show my agents', 'show my agents'],
    ['He Lena, show my agents', 'show my agents'],
    ['Hey Alina, show my agents', 'show my agents'],
    ['Hey Elena show my agents', 'show my agents'],
    ['Hey, Elena, show my agents', 'show my agents'],
    ['Here, Lina, show my agents', 'show my agents'],
    ['Hey — Lina — show my agents', 'show my agents'],
    ['   Hey Lina, show my agents', 'show my agents'],
  ]) assert.equal(stripWakePrefix(text), expected, text);
});

test('the retired Hey Vibe spellings and pre-greeting filler leave the transcript too', () => {
  for (const [text, expected] of [
    ['Hey, bye. There is a terminal that is done.', 'There is a terminal that is done.'],
    ['Hey, vibe. Can you monitor it?', 'Can you monitor it?'],
    ['Hey Vibe! open a terminal', 'open a terminal'],
    ['Hey, vote. Thank you.', 'Thank you.'],
    ['Hey, but... Can you resume?', 'Can you resume?'],
    ["He'll be. Can you open a new Codex terminal?", 'Can you open a new Codex terminal?'],
    ['Hey, Elina. Never mind.', 'Never mind.'],
    ['Hey Lena. Hey Lena. Can you tell the agent to continue?', 'Can you tell the agent to continue?'],
    ['and all. Hey, Lena. Yeah, go ahead.', 'Yeah, go ahead.'],
    ['And... Hey, Lena. have a Codex terminal work in it.', 'have a Codex terminal work in it.'],
    ['. Hey, bye. prompt a codex terminal', 'prompt a codex terminal'],
    ['you Hey, vibe. - Yeah. I want a new terminal.', 'Yeah. I want a new terminal.'],
  ]) assert.equal(stripWakePrefix(text), expected, text);
});

test('speech before the greeting survives unless every word of it is filler', () => {
  for (const text of ['Close the terminal. Hey Lina, thanks', 'Really not. and Vibe Terminal have codex review the docs.',
    'Bye. hey Open Codex Terminal in Vibe Terminal project.', 'I am going to try something. Hey, Vibe. Can you add a pane?']) {
    assert.equal(stripWakePrefix(text), text, text);
  }
});

test('ordinary words that merely contain the name are never shortened', () => {
  for (const text of ['Hey Linaria, show my agents', 'Show Hey Lina in the terminal', 'Helina is a name', 'Heylina show my agents',
    'Lina, show my agents', 'ask Lena about the build', 'show my agents', '']) assert.equal(stripWakePrefix(text), text, text);
});

test('missing and non-string transcripts are handled without throwing', () => {
  assert.equal(stripWakePrefix(undefined), '');
  assert.equal(stripWakePrefix(null), '');
  assert.equal(stripWakePrefix(42), '42');
});
