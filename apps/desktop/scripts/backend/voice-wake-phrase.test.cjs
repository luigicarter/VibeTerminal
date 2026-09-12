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

test('ordinary words that merely contain the name are never shortened', () => {
  for (const text of ['Hey Linaria, show my agents', 'Show Hey Lina in the terminal', 'Helina is a name', 'Heylina show my agents',
    'Lina, show my agents', 'ask Lena about the build', 'show my agents', '']) assert.equal(stripWakePrefix(text), text, text);
});

test('missing and non-string transcripts are handled without throwing', () => {
  assert.equal(stripWakePrefix(undefined), '');
  assert.equal(stripWakePrefix(null), '');
  assert.equal(stripWakePrefix(42), '42');
});
