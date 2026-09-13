'use strict';
// Speech recognition writes the same product, provider and project names many
// ways: "cloud code" and "claud code" for Claude Code, "codec", "codecs" and
// "cortex" for Codex, "Vybe", "Vibre", "Vib" and "Vibeturnal" for vibeTerminal,
// "Lena", "Alina" and "lean a" for lina. Every one of those reached the brain
// and the resolvers verbatim, so a correct instruction failed on the spelling
// alone. This pass rewrites the known variants to their canonical names before
// interpretation, deterministically and without a model round. It is a pure
// function: same text and same catalogs, same result, no I/O.
//
// The conversation keeps the original sentence. Only the copy the brain and the
// resolvers read is normalized.
const { stripWakePhrases } = require('../shared/wakePhraseVariants.cjs');

// Nouns that mark the words beside them as a project reference rather than
// ordinary speech. A fuzzy name match is only trusted next to one of these.
const PROJECT_NOUNS = new Set(['project', 'projects', 'app', 'apps', 'terminal', 'terminals', 'mobile',
  'web', 'website', 'repo', 'repository', 'folder', 'codebase', 'workspace']);
// Articles and prepositions the recognizer inserts inside a spoken name
// ("lean a web app", "lean on a web app"). Skipped between matched name words.
const SKIPPABLE = new Set(['a', 'the', 'on', 'of', 'in']);
// Observed misspellings that are too far from the real word for edit distance.
// One alias may stand for several name words ("Vibeturnal" is "vibe terminal").
const WORD_ALIASES = new Map([
  ['vybe', ['vibe']], ['vibre', ['vibe']], ['vib', ['vibe']], ['vibes', ['vibe']],
  ['vibeturnal', ['vibe', 'terminal']], ['vibeturnel', ['vibe', 'terminal']], ['vibeternal', ['vibe', 'terminal']],
  ['lena', ['lina']], ['leena', ['lina']], ['alina', ['lina']], ['elina', ['lina']], ['elena', ['lina']],
  ['lean', ['lina']], ['lenaweb', ['lina', 'web']],
  ['terranium', ['ternary']], ['ternarium', ['ternary']],
]);
// "LENA terminal", "Lunar Terminal" and "Lina terminal" are the product, not a
// project. Followed by "project" the same words mean the project, so the
// product rewrite stands down there and the project pass decides.
const PRODUCT_FIRST_WORDS = new Set(['lina', 'lena', 'leena', 'alina', 'elina', 'elena', 'helina', 'lunar', 'luna']);
const PRODUCT_NAME = 'Lina Terminal';
// Canonical provider labels with the spellings speech produces for them. Keyed
// by launcher kind so a build without a launcher never has its name invented.
// "open codex", "open claude code" and "open fusion" are deliberately absent:
// in speech those are the verb "open" plus a provider, not the launcher names.
const PROVIDER_VOCABULARY = [
  { kind: 'claude', canonical: 'Claude Code', aliases: ['claude code', 'cloud code', 'cloud-code', 'cloudcode', 'claud code', 'clod code', 'cloud codes', 'claude codes'] },
  { kind: 'codex-web', canonical: 'Codex Web', aliases: ['codex web', 'codex-web', 'codec web', 'codecs web', 'cortex web'] },
  { kind: 'codex', canonical: 'Codex', aliases: ['codex', 'codec', 'codecs', 'cortex', 'kodex', 'codeks'] },
  { kind: 'open-codex', canonical: 'Open Codex', aliases: ['open-codex'] },
  { kind: 'claude-custom', canonical: 'Open Claude Code', aliases: [] },
  { kind: 'gemini', canonical: 'Gemini', aliases: ['gemini', 'gemeni', 'jemini', 'jiminy'] },
  { kind: 'cursor', canonical: 'Cursor', aliases: ['cursor', 'curser'] },
  { kind: 'grok', canonical: 'Grok', aliases: ['grok', 'grock'] },
  { kind: 'kimi', canonical: 'Kimi', aliases: ['kimi', 'kimmy', 'kimmi'] },
  { kind: 'qwen', canonical: 'Qwen', aliases: ['qwen', 'quen'] },
  { kind: 'opencode', canonical: 'OpenCode', aliases: ['opencode'] },
  { kind: 'fusion', canonical: 'Fusion', aliases: ['fusion'] },
  { kind: 'openfusion', canonical: 'Open Fusion', aliases: ['openfusion'] },
  { kind: 'kimi-custom', canonical: 'Kimi + CC', aliases: [] },
];

const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;
function tokenize(text) {
  const tokens = [];
  for (const match of String(text).matchAll(WORD_PATTERN)) {
    tokens.push({ word: match[0].toLowerCase().replace(/[’]/g, "'"), start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}
// Bounded Levenshtein: the exact distance when it is at most max, otherwise
// max + 1. Long words never cost more than a short scan.
function withinDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] : 1 + Math.min(previous[j - 1], previous[j], current[j - 1]);
      best = Math.min(best, current[j]);
    }
    if (best > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}
// Phonetic tolerance, tightened by length: one edit for a short name word, two
// for a long one. Three-letter words must match exactly ("web" is not "vibe").
function fuzzyWord(spoken, target) {
  if (spoken.length < 4 || target.length < 4) return false;
  return withinDistance(spoken, target, target.length >= 6 ? 2 : 1);
}
function nameWords(name) {
  return String(name ?? '').replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean).map(word => word.toLowerCase());
}
// Quoted text is the user's own wording for someone else to read. Never rewrite
// inside it, even when it holds a name variant.
function quotedSpans(text) {
  const spans = [];
  for (const match of String(text).matchAll(/"[^"]*"|“[^”]*”|`[^`]*`/g)) spans.push([match.index, match.index + match[0].length]);
  return spans;
}

// Matches the word sequence of one project name starting at a token, allowing
// an alias word, a phonetic near-miss, a run-together spelling ("Lenaweb"), and
// at most two inserted articles inside the name.
function matchProjectWords(tokens, index, words) {
  let position = index, word = 0, exact = 0, skips = 0, loose = false;
  while (word < words.length) {
    if (position >= tokens.length) return null;
    const spoken = tokens[position].word;
    if (spoken === words[word]) { exact++; position++; word++; continue; }
    const alias = WORD_ALIASES.get(spoken);
    if (alias && word + alias.length <= words.length && alias.every((part, offset) => words[word + offset] === part)) {
      loose = true; position++; word += alias.length; continue;
    }
    let joined = false;
    for (let span = words.length - word; span >= 2; span--) {
      if (fuzzyWord(spoken, words.slice(word, word + span).join(''))) { loose = true; position++; word += span; joined = true; break; }
    }
    if (joined) continue;
    if (fuzzyWord(spoken, words[word])) { loose = true; position++; word++; continue; }
    if (word > 0 && skips < 2 && SKIPPABLE.has(spoken)) { skips++; position++; continue; }
    return null;
  }
  return { first: index, last: position - 1, exact, loose: loose || skips > 0 };
}
function adjacentNoun(tokens, first, last) {
  return PROJECT_NOUNS.has(tokens[first - 1]?.word) || PROJECT_NOUNS.has(tokens[last + 1]?.word);
}
function projectMatches(tokens, projects) {
  const targets = projects.map(project => ({ name: project, words: nameWords(project) }))
    .filter(target => target.words.length)
    .sort((left, right) => right.words.length - left.words.length || right.name.length - left.name.length);
  const matches = [];
  for (let index = 0; index < tokens.length; index++) {
    for (const target of targets) {
      const match = matchProjectWords(tokens, index, target.words);
      if (!match) continue;
      // A one-word project name is often an ordinary English word too ("Project",
      // "chat", "kimi"). Beside a project noun it is a reference; anywhere else
      // the sentence keeps its own words.
      if (target.words.length === 1 && !adjacentNoun(tokens, match.first, match.last)) continue;
      // An exact name needs no other evidence. A loose one is only a project
      // reference beside a project noun, or when the name carries one itself,
      // or when all but one of several name words were heard exactly.
      const trusted = !match.loose
        || target.words.some(word => PROJECT_NOUNS.has(word))
        || adjacentNoun(tokens, match.first, match.last)
        || (target.words.length >= 2 && match.exact >= target.words.length - 1);
      if (!trusted) continue;
      matches.push({ kind: 'project', priority: 2, start: tokens[match.first].start, end: tokens[match.last].end, to: target.name });
      break;
    }
  }
  return matches;
}
function productMatches(tokens) {
  const matches = [];
  for (let index = 0; index + 1 < tokens.length; index++) {
    if (!PRODUCT_FIRST_WORDS.has(tokens[index].word) || tokens[index + 1].word !== 'terminal') continue;
    if (tokens[index + 2]?.word === 'project') continue;
    matches.push({ kind: 'product', priority: 3, start: tokens[index].start, end: tokens[index + 1].end, to: PRODUCT_NAME });
  }
  return matches;
}
function providerMatches(tokens, vocabulary) {
  const entries = vocabulary.flatMap(entry => entry.aliases.map(alias => ({ words: nameWords(alias), canonical: entry.canonical })))
    .filter(entry => entry.words.length)
    .sort((left, right) => right.words.length - left.words.length || right.words.join('').length - left.words.join('').length);
  const matches = [];
  for (let index = 0; index < tokens.length; index++) {
    for (const entry of entries) {
      if (index + entry.words.length > tokens.length) continue;
      if (!entry.words.every((word, offset) => tokens[index + offset].word === word)) continue;
      matches.push({ kind: 'provider', priority: 1, start: tokens[index].start, end: tokens[index + entry.words.length - 1].end, to: entry.canonical });
      break;
    }
  }
  return matches;
}

// The provider names this build actually offers. With no catalog the built-in
// table is used whole; with one, only its launcher kinds are recognized, so a
// provider the user does not have is never named back to them.
function providerAliases(launchers = []) {
  const kinds = new Set((Array.isArray(launchers) ? launchers : []).map(item => item?.kind).filter(Boolean));
  const table = kinds.size ? PROVIDER_VOCABULARY.filter(entry => kinds.has(entry.kind)) : PROVIDER_VOCABULARY;
  return table.map(entry => ({ kind: entry.kind, canonical: entry.canonical, aliases: [...entry.aliases] }));
}
// The accepted spoken forms of each registered project name, for inspection and
// tests. The matcher itself is token based and also accepts phonetic near
// misses that no fixed list can enumerate.
function projectAliases(projects = []) {
  return (Array.isArray(projects) ? projects : []).map(project => (typeof project === 'string' ? project : project?.name))
    .filter(name => typeof name === 'string' && name.trim())
    .map(name => {
      const words = nameWords(name);
      const variants = new Set([name, name.toLowerCase(), words.join(' '), words.join('-'), words.join('')]);
      for (const [alias, expansion] of WORD_ALIASES) {
        for (let index = 0; index + expansion.length <= words.length; index++) {
          if (expansion.every((part, offset) => words[index + offset] === part)) {
            variants.add([...words.slice(0, index), alias, ...words.slice(index + expansion.length)].join(' '));
          }
        }
      }
      return { name, words, variants: [...variants] };
    });
}

function normalizeInstruction(text, { projects = [], launchers = [], wakePhrases = [] } = {}) {
  const original = String(text ?? '');
  const replacements = [];
  const wake = stripWakePhrases(original, wakePhrases);
  let working = wake.text;
  if (wake.removed) replacements.push({ kind: 'wake', from: wake.removed, to: '' });
  const names = (Array.isArray(projects) ? projects : []).map(project => (typeof project === 'string' ? project : project?.name))
    .filter(name => typeof name === 'string' && name.trim());
  const tokens = tokenize(working);
  const guarded = quotedSpans(working);
  const candidates = [...productMatches(tokens), ...projectMatches(tokens, names), ...providerMatches(tokens, providerAliases(launchers))]
    .filter(match => !guarded.some(([start, end]) => match.start < end && match.end > start))
    .sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start) || right.priority - left.priority);
  let consumedTo = -1;
  const accepted = [];
  for (const match of candidates) {
    if (match.start < consumedTo) continue;
    const from = working.slice(match.start, match.end);
    consumedTo = match.end;
    if (from === match.to) continue;
    accepted.push({ ...match, from });
  }
  for (const match of [...accepted].reverse()) working = working.slice(0, match.start) + match.to + working.slice(match.end);
  for (const match of accepted) replacements.push({ kind: match.kind, from: match.from, to: match.to });
  return { text: working, changed: working !== original, replacements };
}

module.exports = { normalizeInstruction, providerAliases, projectAliases, PROVIDER_VOCABULARY, PRODUCT_NAME };
