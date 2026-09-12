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

// Returns { status: 'matched', agentId, score } when exactly one candidate is
// eligible or the runner-up is at least RUNNER_UP_MARGIN behind;
// { status: 'ambiguous', candidateCount } with the number of candidates tied
// inside that margin; { status: 'no-match', candidateCount } with the number of
// candidates offered.
function resolveTitledOwner({ instruction, candidates = [], projectName = '' } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const stop = new Set([...STOPWORDS, ...tokenize(projectName)]);
  const spoken = new Set(significant([instruction], stop));
  const eligible = [];
  for (const candidate of list) {
    const name = String(candidate?.name ?? '');
    if (!candidate || typeof candidate.agentId !== 'string' || !candidate.agentId || defaultName(name)) continue;
    const words = significant([name, ...(Array.isArray(candidate.titles) ? candidate.titles : [])], stop);
    if (words.length < 2) continue;
    const matched = words.filter(word => spoken.has(word)).length;
    const score = Number((matched / words.length).toFixed(3));
    if (matched >= MIN_MATCHED_TOKENS && score >= MIN_SCORE) eligible.push({ agentId: candidate.agentId, score });
  }
  eligible.sort((a, b) => b.score - a.score);
  if (!eligible.length) return { status: 'no-match', candidateCount: list.length };
  const best = eligible[0];
  const tied = eligible.filter(item => item.score > best.score - RUNNER_UP_MARGIN);
  if (tied.length > 1) return { status: 'ambiguous', candidateCount: tied.length };
  return { status: 'matched', agentId: best.agentId, score: best.score };
}

module.exports = { resolveTitledOwner, STOPWORDS, MIN_SCORE, MIN_MATCHED_TOKENS, RUNNER_UP_MARGIN };
