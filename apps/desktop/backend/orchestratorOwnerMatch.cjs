'use strict';

// Deterministic titled-owner match for a continuation the user named ("the
// agent working on <task>"). Pure: no I/O, no model call, no store or session
// access. A match is only a claim about titles; the caller still reads the live
// pane and binds verified evidence before any task reaches it.
const MIN_TOKEN_LENGTH = 3;
const MIN_MATCHED_TOKENS = 2;
const MIN_SCORE = 0.6;
const RUNNER_UP_MARGIN = 0.3;

// Words that carry no ownership evidence: English function words, and the
// product/provider vocabulary that appears in every title and instruction.
// The project's own name is added per call, so "the vibeTerminal agent" cannot
// select a pane merely for being in the project.
const STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'nor', 'yet', 'not', 'all', 'any', 'are', 'was', 'were', 'been', 'being',
  'has', 'have', 'had', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'did', 'does', 'done', 'doing', 'get', 'gets', 'got', 'let', 'its', 'their', 'them', 'they', 'there',
  'then', 'than', 'this', 'that', 'these', 'those', 'with', 'without', 'from', 'into', 'onto', 'over',
  'under', 'after', 'before', 'about', 'above', 'below', 'again', 'more', 'most', 'much', 'many',
  'some', 'such', 'only', 'just', 'also', 'very', 'you', 'your', 'yours', 'our', 'ours', 'his', 'her',
  'hers', 'him', 'she', 'who', 'whom', 'whose', 'what', 'when', 'where', 'which', 'why', 'how', 'here',
  'now', 'one', 'two', 'other', 'another', 'same', 'each', 'every', 'both', 'few', 'per', 'off', 'out',
  'via', 'use', 'using', 'used', 'need', 'needs', 'want', 'wants', 'keep', 'keeps', 'still', 'back',
  // Product, provider and harness vocabulary.
  'codex', 'claude', 'gemini', 'qwen', 'kimi', 'cursor', 'grok', 'opencode', 'fusion', 'openfusion',
  'web', 'code', 'terminal', 'terminals', 'pane', 'panes', 'session', 'sessions', 'conversation',
  'conversations', 'agent', 'agents', 'project', 'projects', 'lina', 'lena', 'vibe', 'vibeterminal',
  'task', 'tasks', 'tell', 'told', 'ask', 'asked', 'please', 'hey', 'continue', 'continues',
  'continuing', 'work', 'works', 'working', 'worked'
]);

const tokenize = value => (String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(word => word.length >= MIN_TOKEN_LENGTH);
const significant = (values, stop) => [...new Set(values.flatMap(value => tokenize(value)))].filter(word => !stop.has(word));
// A shell path or executable is a launcher default, never a task the user named.
const defaultName = name => /[\\/]/.test(name) || /\.exe$/i.test(name.trim());

// The one scoring pass both the titled-owner shortcut and the deterministic
// assignment resolver use. Each candidate supplies the texts that describe it
// (its pane name, conversation title, aliases, and the objective/title of the
// work item that owns it); the score is the fraction of that candidate's own
// distinctive words the user actually said, so a long title cannot win merely by
// containing more words. `stopwords` lets a caller widen the ignored vocabulary;
// the project name is always added, so "the vibeTerminal agent" selects nothing.
// Candidates whose texts carry fewer than two distinctive words are dropped:
// "Codex 3" or "✳ Claude Code" is a launcher label, not a task the user named.
// `perText` scores each description separately and keeps the candidate's best
// one, so a long recorded objective beside a short title cannot dilute a real
// title match; the pooled default is what the titled-owner shortcut uses.
function scoreCandidates({ instruction, candidates = [], projectName = '', stopwords = STOPWORDS, perText = false } = {}) {
  const stop = new Set([...stopwords, ...tokenize(projectName)]);
  const spoken = new Set(significant(Array.isArray(instruction) ? instruction : [instruction], stop));
  const rate = texts => {
    const words = significant(texts, stop);
    if (words.length < 2) return undefined;
    const matched = words.filter(word => spoken.has(word)).length;
    return { matched, wordCount: words.length, score: Number((matched / words.length).toFixed(3)) };
  };
  const better = (left, right) => !left || right && (right.score > left.score || right.score === left.score && right.matched > left.matched) ? right : left;
  const scored = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || candidate.id === undefined || candidate.id === null) continue;
    const texts = (Array.isArray(candidate.texts) ? candidate.texts : []).map(value => String(value ?? '')).filter(text => text && !defaultName(text));
    const best = perText ? texts.map(text => rate([text])).reduce((carry, item) => better(carry, item), undefined) : rate(texts);
    if (best) scored.push({ id: candidate.id, ...best });
  }
  return scored.sort((left, right) => right.score - left.score || right.matched - left.matched);
}

// Returns { status: 'matched', agentId, score } when exactly one candidate is
// eligible or the runner-up is at least RUNNER_UP_MARGIN behind;
// { status: 'ambiguous', candidateCount } with the number of candidates tied
// inside that margin; { status: 'no-match', candidateCount } with the number of
// candidates offered.
function resolveTitledOwner({ instruction, candidates = [], projectName = '' } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const usable = list.filter(candidate => candidate && typeof candidate.agentId === 'string' && candidate.agentId && !defaultName(String(candidate.name ?? '')));
  const scored = scoreCandidates({ instruction, projectName, candidates: usable.map(candidate =>
    ({ id: candidate.agentId, texts: [candidate.name, ...(Array.isArray(candidate.titles) ? candidate.titles : [])] })) });
  // A runner-up counts towards ambiguity as soon as it shares the same named
  // words, even when its own longer title keeps it under the threshold: two
  // panes about the chat section are two candidates, and the caller must ask.
  const eligible = scored.filter(item => item.matched >= MIN_MATCHED_TOKENS);
  const strong = eligible.filter(item => item.score >= MIN_SCORE);
  if (!strong.length) return { status: 'no-match', candidateCount: list.length };
  const best = strong[0];
  const tied = eligible.filter(item => item.score > best.score - RUNNER_UP_MARGIN);
  if (tied.length > 1) return { status: 'ambiguous', candidateCount: tied.length };
  return { status: 'matched', agentId: best.id, score: best.score };
}

module.exports = { resolveTitledOwner, scoreCandidates, STOPWORDS, MIN_SCORE, MIN_MATCHED_TOKENS, RUNNER_UP_MARGIN };
