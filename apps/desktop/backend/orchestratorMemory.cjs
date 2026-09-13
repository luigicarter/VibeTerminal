'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { VERBS, OUTCOMES } = require('./orchestratorLedger.cjs');

// Memory as a store with deterministic retrieval, not a window. The ledger and
// pane memory stay the write path; this file is where their facts live once they
// are written, with indexes that answer "what did that terminal say", "what was
// the last prompt" and "what was that error" from recorded fact rather than from
// a model call. Every record here is something the application itself observed:
// it is reference data, never authority, and it never restores a grant.
//
// The conversation store's ten-megabyte message pool evicts by age, so this has
// its own file. Records are bounded per field, validated one row at a time (a
// malformed row is dropped without taking the file with it), and written with a
// temp-and-rename so a crash mid-write cannot truncate the memory.
const VERSION = 1;
const FILE = 'orchestrator-memory-v1.json';
const HALF_LIFE_MS = 7 * 86400000;
const LIMITS = Object.freeze({ episodes: 5000, episodeAgeMs: 90 * 86400000, paneFacts: 500, projectFacts: 100,
  summaries: 2000, bytes: 8 * 1024 * 1024 });
const CAPS = Object.freeze({ requestId: 200, project: 120, cwd: 1024, typedText: 300, error: 200, paneId: 200,
  paneName: 120, provider: 40, topics: 40, topic: 40, result: 400, results: 5, objective: 300, title: 120,
  reference: 120, promptText: 200, status: 40, projectResult: 120, projectResults: 3, openQuestions: 3,
  openQuestion: 200, aliases: 10, alias: 120, summaryText: 400, agentId: 256, excerpt: 240 });
const CREATED_BY = Object.freeze(['lina', 'user']);
// Speech, filler and grammar. A topic is what a request was about, so the words
// every request shares carry no retrieval signal and only crowd the index.
const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'yours', 'our', 'ours', 'are',
  'was', 'were', 'has', 'have', 'had', 'not', 'but', 'can', 'could', 'would', 'should', 'shall', 'will', 'did', 'does',
  'done', 'doing', 'about', 'into', 'onto', 'from', 'they', 'them', 'their', 'there', 'then', 'than', 'what', 'when',
  'where', 'which', 'who', 'whom', 'why', 'how', 'all', 'any', 'some', 'one', 'two', 'now', 'just', 'also', 'please',
  'thanks', 'thank', 'hey', 'okay', 'yeah', 'yes', 'like', 'want', 'need', 'get', 'got', 'put', 'set', 'let', 'its',
  'it’s', 'his', 'her', 'him', 'she', 'was', 'because', 'been', 'being', 'over', 'under', 'again', 'still', 'more',
  'most', 'other', 'another', 'same', 'such', 'very', 'here', 'out', 'off', 'own', 'too', 'only', 'able', 'make',
  'made', 'say', 'said', 'says', 'tell', 'told', 'ask', 'asked', 'give', 'given', 'take', 'taken', 'use', 'used',
  'going', 'gone', 'know', 'knew', 'think', 'thought', 'look', 'looked', 'see', 'seen', 'saw', 'was', 'were']);

const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
const copy = value => (value == null ? value : structuredClone(value));
function text(value, cap) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, cap) : null;
}
const finite = value => (Number.isFinite(Number(value)) ? Number(value) : null);
const projectKey = value => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const folderKey = value => (typeof value === 'string' && value
  ? value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '');

// Local calendar day: the user's "today", which is what a rollover line and the
// "other projects active today" line both mean.
function dayKey(at) {
  const time = Number(at);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return null;
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const words = value => (String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
function topicsFrom(sources, limit = CAPS.topics) {
  const found = new Set();
  for (const source of sources) {
    for (const word of words(source)) {
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      found.add(word.slice(0, CAPS.topic));
      if (found.size >= limit) return [...found];
    }
  }
  return [...found];
}

function secretCleaner(getSecrets) {
  return value => {
    const provided = getSecrets();
    // Failing to read the secret list drops the write rather than risking
    // disclosure, exactly as the other persisted stores do.
    if (!Array.isArray(provided)) throw new Error('Secret redaction is unavailable.');
    return provided.filter(item => typeof item === 'string' && item.length)
      .reduce((current, secret) => current.split(secret).join('[redacted]'), String(value))
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/gi, '[redacted]');
  };
}

function normalizePane(value, clean) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = text(clean(value.id ?? ''), CAPS.paneId);
  if (!id) return null;
  return { id, name: value.name == null ? null : text(clean(value.name), CAPS.paneName),
    provider: value.provider == null ? null : text(clean(value.provider), CAPS.provider) };
}

function resultLines(value, clean) {
  return (Array.isArray(value) ? value : []).map(item => text(clean(item ?? ''), CAPS.result))
    .filter(Boolean).slice(-CAPS.results);
}

// One episode per request: the ledger row plus what the request was about and
// what came back from it. An unknown verb or outcome is not an episode; the
// enumerations are closed so nothing a model wrote can enter this store.
function normalizeEpisode(input, clean) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const requestId = text(clean(input.requestId ?? ''), CAPS.requestId);
  if (!requestId || !VERBS.includes(input.verb) || !OUTCOMES.includes(input.outcome)) return null;
  const at = finite(input.at);
  if (at === null || at <= 0) return null;
  const pane = normalizePane(input.pane, clean);
  const typedText = input.typedText == null ? null : text(clean(input.typedText), CAPS.typedText);
  const results = resultLines(input.results, clean);
  const supplied = Array.isArray(input.topics)
    ? [...new Set(input.topics.filter(item => typeof item === 'string').map(item => item.toLowerCase().slice(0, CAPS.topic))
      .filter(item => item.length >= 3))].slice(0, CAPS.topics)
    : null;
  const episode = { requestId, at, verb: input.verb, project: input.project == null ? null : text(clean(input.project), CAPS.project),
    cwd: input.cwd == null ? null : text(clean(input.cwd), CAPS.cwd), pane, typedText, outcome: input.outcome,
    error: input.error == null ? null : text(clean(input.error), CAPS.error),
    topics: supplied || topicsFrom([input.instruction, typedText, pane?.name, ...results]), results };
  return episode;
}

function normalizePaneFact(input, clean) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const paneId = text(clean(input.paneId ?? ''), CAPS.paneId);
  if (!paneId) return null;
  const fact = { paneId,
    agentId: input.agentId == null ? null : text(clean(input.agentId), CAPS.agentId),
    project: input.project == null ? null : text(clean(input.project), CAPS.project),
    provider: input.provider == null ? null : text(clean(input.provider), CAPS.provider),
    title: input.title == null ? null : text(clean(input.title), CAPS.title),
    objective: input.objective == null ? null : text(clean(input.objective), CAPS.objective),
    createdBy: CREATED_BY.includes(input.createdBy) ? input.createdBy : null,
    lastUserReference: input.lastUserReference == null ? null : text(clean(input.lastUserReference), CAPS.reference),
    lastPromptAt: finite(input.lastPromptAt) > 0 ? finite(input.lastPromptAt) : null,
    lastPromptText: input.lastPromptText == null ? null : text(clean(input.lastPromptText), CAPS.promptText),
    results: resultLines(input.results, clean),
    status: input.status == null ? null : text(clean(input.status), CAPS.status),
    updatedAt: finite(input.updatedAt) > 0 ? finite(input.updatedAt) : null };
  if (fact.updatedAt === null) return null;
  return fact;
}

function normalizeProjectFact(input, clean) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const project = text(clean(input.project ?? ''), CAPS.project);
  if (!project) return null;
  const lastActivePane = normalizePane(input.lastActivePane, clean);
  return { project, cwd: input.cwd == null ? null : text(clean(input.cwd), CAPS.cwd),
    defaultProvider: input.defaultProvider == null ? null : text(clean(input.defaultProvider), CAPS.provider),
    lastActivePane: lastActivePane && { id: lastActivePane.id, name: lastActivePane.name },
    lastResults: (Array.isArray(input.lastResults) ? input.lastResults : [])
      .map(item => text(clean(item ?? ''), CAPS.projectResult)).filter(Boolean).slice(-CAPS.projectResults),
    openQuestions: (Array.isArray(input.openQuestions) ? input.openQuestions : [])
      .map(item => text(clean(item ?? ''), CAPS.openQuestion)).filter(Boolean).slice(-CAPS.openQuestions),
    aliases: [...new Set((Array.isArray(input.aliases) ? input.aliases : [])
      .map(item => text(clean(item ?? ''), CAPS.alias)).filter(Boolean))].slice(-CAPS.aliases),
    updatedAt: finite(input.updatedAt) > 0 ? finite(input.updatedAt) : null };
}

function normalizeSummary(input, clean) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const day = text(clean(input.day ?? ''), 10);
  const body = text(clean(input.text ?? ''), CAPS.summaryText);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !body) return null;
  const counts = {};
  if (input.counts && typeof input.counts === 'object' && !Array.isArray(input.counts)) {
    for (const [verb, value] of Object.entries(input.counts)) {
      if (VERBS.includes(verb) && Number.isSafeInteger(value) && value >= 0) counts[verb] = Math.min(value, 1e6);
    }
  }
  return { project: input.project == null ? null : text(clean(input.project), CAPS.project), day, text: body, counts };
}

// What a "start" verb means for the default provider of a project.
const START_VERBS = new Set(['start', 'open']);
const VERB_PHRASE = Object.freeze({ start: 'started a task in', follow_up: 'sent a follow-up to', open: 'opened',
  close: 'closed', answer: 'answered a question in', ask: 'answered you', status: 'checked what was running',
  results: 'reported results from', inspect: 'inspected', cancel: 'cancelled a request', failed: 'failed a request' });

function createMemoryStore({ userDataPath, now = Date.now, getSecrets = () => [] } = {}) {
  const file = path.join(userDataPath, FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const clean = secretCleaner(getSecrets);
  const episodes = new Map(), paneFacts = new Map(), projectFacts = new Map(), summaries = new Map();
  const byPane = new Map(), byProject = new Map(), byDay = new Map(), tokenIndex = new Map();
  let chain = Promise.resolve(), lastError = null, epoch = 0, fileExisted = false;

  const addIndex = (map, key, id) => { if (key == null) return; const set = map.get(key) || new Set(); set.add(id); map.set(key, set); };
  const dropIndex = (map, key, id) => { const set = map.get(key); if (!set) return; set.delete(id); if (!set.size) map.delete(key); };
  function index(episode) {
    addIndex(byPane, episode.pane?.id, episode.requestId);
    addIndex(byProject, projectKey(episode.project), episode.requestId);
    addIndex(byDay, dayKey(episode.at), episode.requestId);
    for (const topic of episode.topics) addIndex(tokenIndex, topic, episode.requestId);
  }
  function unindex(episode) {
    dropIndex(byPane, episode.pane?.id, episode.requestId);
    dropIndex(byProject, projectKey(episode.project), episode.requestId);
    dropIndex(byDay, dayKey(episode.at), episode.requestId);
    for (const topic of episode.topics) dropIndex(tokenIndex, topic, episode.requestId);
  }
  function rebuild() {
    byPane.clear(); byProject.clear(); byDay.clear(); tokenIndex.clear();
    for (const episode of episodes.values()) index(episode);
  }
  const ordered = list => [...list].sort((left, right) => left.at - right.at || left.requestId.localeCompare(right.requestId));
  const episodesOf = ids => [...(ids || [])].map(id => episodes.get(id)).filter(Boolean);

  function summaryFor(day) {
    const list = ordered(episodesOf(byDay.get(day)));
    if (!list.length) return [];
    const groups = new Map();
    for (const episode of list) {
      const key = projectKey(episode.project);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(episode);
    }
    const written = [];
    for (const [key, group] of groups) {
      const counts = {};
      for (const episode of group) counts[episode.verb] = (counts[episode.verb] || 0) + 1;
      const name = [...group].reverse().find(episode => episode.project)?.project || null;
      const panes = [...new Set(group.map(episode => episode.pane?.name).filter(Boolean))].slice(0, 3);
      const body = `${day} in ${name || 'no project'}: ${group.length} request${group.length === 1 ? '' : 's'} (` +
        `${Object.entries(counts).map(([verb, count]) => `${verb} ${count}`).join(', ')})` +
        `${panes.length ? `; panes: ${panes.join(', ')}` : ''}`;
      const summary = normalizeSummary({ project: name, day, text: body, counts }, clean);
      if (!summary) continue;
      summaries.set(`${day}|${key}`, summary);
      written.push(copy(summary));
    }
    return written;
  }

  // Episodes retire by age or by count, and never before the day they belong to
  // has a summary line: the gist of a day survives the rows that made it.
  function retain() {
    const cutoff = now() - LIMITS.episodeAgeMs;
    const all = ordered(episodes.values());
    const doomed = new Set(all.filter(episode => episode.at < cutoff));
    for (let position = 0; position < all.length - LIMITS.episodes; position++) doomed.add(all[position]);
    if (doomed.size) {
      for (const day of new Set([...doomed].map(episode => dayKey(episode.at)))) summaryFor(day);
      for (const episode of doomed) { unindex(episode); episodes.delete(episode.requestId); }
    }
    const oldestFirst = map => [...map.values()].sort((left, right) => (left.updatedAt || 0) - (right.updatedAt || 0));
    while (paneFacts.size > LIMITS.paneFacts) paneFacts.delete(oldestFirst(paneFacts)[0].paneId);
    while (projectFacts.size > LIMITS.projectFacts) projectFacts.delete(projectKey(oldestFirst(projectFacts)[0].project));
    while (summaries.size > LIMITS.summaries) summaries.delete(summaries.keys().next().value);
  }

  function snapshot() {
    return { version: VERSION, episodes: ordered(episodes.values()).map(copy),
      paneFacts: [...paneFacts.values()].map(copy), projectFacts: [...projectFacts.values()].map(copy),
      summaries: [...summaries.values()].map(copy) };
  }
  function save() {
    const generation = epoch;
    let data;
    try { data = JSON.stringify(snapshot()); } catch (error) { lastError = error; return; }
    if (Buffer.byteLength(data) > LIMITS.bytes) return;
    chain = chain.then(async () => {
      try {
        if (generation !== epoch) return;
        await fs.promises.mkdir(userDataPath, { recursive: true });
        await fs.promises.writeFile(temporary, data, { mode: 0o600 });
        if (generation !== epoch) { await fs.promises.rm(temporary, { force: true }); return; }
        await fs.promises.rename(temporary, file);
        lastError = null;
      } catch (error) { lastError = error; }
    });
  }

  // Load: every record is validated on its own, so one bad row costs that row
  // and nothing else. A file of another version is memory this build cannot read.
  try {
    if (fs.statSync(file).size <= LIMITS.bytes) {
      fileExisted = true;
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && saved.version === VERSION) {
        for (const row of Array.isArray(saved.episodes) ? saved.episodes : []) {
          const episode = normalizeEpisode(row, clean);
          if (episode && !episodes.has(episode.requestId)) episodes.set(episode.requestId, episode);
        }
        for (const row of Array.isArray(saved.paneFacts) ? saved.paneFacts : []) {
          const fact = normalizePaneFact(row, clean);
          if (fact) paneFacts.set(fact.paneId, fact);
        }
        for (const row of Array.isArray(saved.projectFacts) ? saved.projectFacts : []) {
          const fact = normalizeProjectFact(row, clean);
          if (fact) projectFacts.set(projectKey(fact.project), fact);
        }
        for (const row of Array.isArray(saved.summaries) ? saved.summaries : []) {
          const summary = normalizeSummary(row, clean);
          if (summary) summaries.set(`${summary.day}|${projectKey(summary.project)}`, summary);
        }
      }
    }
  } catch (error) { if (error?.code !== 'ENOENT') fileExisted = true; }
  rebuild();
  retain();

  // Derived from the project's own last twenty episodes, never from prose: the
  // provider it usually starts, the pane it last touched, its last results, and
  // the clarifications still waiting on the user. Aliases accumulate.
  function recomputeProjectFact(project, patch = {}) {
    const key = projectKey(project);
    if (!key) return null;
    const history = ordered(episodesOf(byProject.get(key)));
    const recent = history.slice(-20);
    const previous = projectFacts.get(key);
    const { aliases: addedAliases, ...rest } = patch || {};
    const providers = new Map();
    for (const episode of recent) {
      if (!START_VERBS.has(episode.verb) || !episode.pane?.provider) continue;
      providers.set(episode.pane.provider, (providers.get(episode.pane.provider) || 0) + 1);
    }
    const defaultProvider = [...providers.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
    const latest = [...recent].reverse();
    const fact = normalizeProjectFact({
      cwd: latest.find(episode => episode.cwd)?.cwd ?? previous?.cwd ?? null,
      defaultProvider: defaultProvider ?? previous?.defaultProvider ?? null,
      lastActivePane: latest.find(episode => episode.pane)?.pane ?? previous?.lastActivePane ?? null,
      lastResults: recent.flatMap(episode => episode.results).slice(-CAPS.projectResults),
      openQuestions: latest.filter(episode => episode.outcome === 'answered' && episode.typedText)
        .slice(0, CAPS.openQuestions).map(episode => episode.typedText),
      ...rest,
      aliases: [...(previous?.aliases || []), ...(Array.isArray(addedAliases) ? addedAliases : [])],
      project: history.at(-1)?.project || previous?.project || project, updatedAt: now(),
    }, clean);
    if (!fact) return null;
    projectFacts.set(key, fact);
    return copy(fact);
  }

  function writeEpisode(input) {
    const episode = normalizeEpisode(input, clean);
    if (!episode) return null;
    const existing = episodes.get(episode.requestId);
    if (existing) {
      // One row per request: a later settle refreshes the same episode and keeps
      // the time the action actually happened, plus every result already filed.
      unindex(existing);
      episode.at = existing.at;
      episode.results = [...new Set([...existing.results, ...episode.results])].slice(-CAPS.results);
      episode.topics = [...new Set([...existing.topics, ...episode.topics])].slice(0, CAPS.topics);
    }
    episodes.set(episode.requestId, episode);
    index(episode);
    return episode;
  }

  // The citation shape every retrieval returns. error travels with it because
  // "what was that error" is answered from the same row, and it is already capped
  // at the ledger's two hundred characters.
  function recallRow(episode) {
    return { requestId: episode.requestId, at: episode.at, project: episode.project,
      pane: episode.pane && { ...episode.pane }, verb: episode.verb, outcome: episode.outcome,
      typedText: episode.typedText, error: episode.error,
      resultExcerpt: episode.results.at(-1)?.slice(0, CAPS.excerpt) ?? null };
  }

  function recall({ query, pane, project, since, limit = 5 } = {}) {
    const tokens = topicsFrom([query]);
    const candidates = tokens.length
      ? episodesOf(new Set(tokens.flatMap(token => [...(tokenIndex.get(token) || [])])))
      : [...episodes.values()];
    const paneId = text(pane, CAPS.paneId);
    const key = projectKey(project);
    const floor = finite(since);
    const reference = now();
    const scored = [];
    for (const episode of candidates) {
      if (paneId && episode.pane?.id !== paneId) continue;
      if (key && projectKey(episode.project) !== key) continue;
      if (floor !== null && episode.at < floor) continue;
      const matched = tokens.filter(token => episode.topics.includes(token)).length;
      if (tokens.length && !matched) continue;
      const decay = Math.pow(0.5, Math.max(0, reference - episode.at) / HALF_LIFE_MS);
      scored.push({ episode, score: (tokens.length ? matched : 1) * decay });
    }
    scored.sort((left, right) => right.score - left.score || right.episode.at - left.episode.at);
    const size = Math.max(1, Math.min(20, Math.floor(Number(limit)) || 5));
    return scored.slice(0, size).map(item => recallRow(item.episode));
  }

  function latestDay() {
    const last = ordered(episodes.values()).at(-1);
    return last ? dayKey(last.at) : null;
  }

  return {
    recordEpisode(input) {
      const episode = writeEpisode(input);
      if (!episode) return null;
      if (episode.project) recomputeProjectFact(episode.project, Array.isArray(input?.aliases) ? { aliases: input.aliases } : {});
      retain();
      save();
      return copy(episode);
    },
    // A result summary belongs to the request that produced it and to the pane it
    // came from; one identity can be either, so both are tried.
    appendResult(id, summary) {
      const key = text(id, CAPS.requestId);
      const line = summary == null ? null : text(clean(summary), CAPS.result);
      if (!key || !line) return false;
      let changed = false;
      const episode = episodes.get(key);
      if (episode && !episode.results.includes(line)) {
        unindex(episode);
        episode.results = [...episode.results, line].slice(-CAPS.results);
        episode.topics = [...new Set([...episode.topics, ...topicsFrom([line])])].slice(0, CAPS.topics);
        index(episode);
        if (episode.project) recomputeProjectFact(episode.project);
        changed = true;
      }
      const fact = paneFacts.get(key);
      if (fact && !fact.results.includes(line)) {
        fact.results = [...fact.results, line].slice(-CAPS.results);
        fact.updatedAt = now();
        if (fact.project) recomputeProjectFact(fact.project);
        changed = true;
      }
      if (changed) save();
      return changed;
    },
    upsertPaneFact(input) {
      const key = text(input?.paneId, CAPS.paneId);
      if (!key) return null;
      const previous = paneFacts.get(key);
      const merged = normalizePaneFact({ ...previous, ...input,
        results: input?.results === undefined ? previous?.results : input.results,
        paneId: key, updatedAt: now() }, clean);
      if (!merged) return null;
      // A repeated observation is not a write: only a real change churns the file.
      if (previous && JSON.stringify({ ...previous, updatedAt: 0 }) === JSON.stringify({ ...merged, updatedAt: 0 })) return copy(previous);
      paneFacts.set(key, merged);
      if (merged.project) recomputeProjectFact(merged.project);
      retain();
      save();
      return copy(merged);
    },
    recomputeProjectFact(project, patch) { const fact = recomputeProjectFact(project, patch); if (fact) { retain(); save(); } return fact; },
    recall,
    recallPane(paneId) {
      const key = text(paneId, CAPS.paneId);
      if (!key) return { pane: null, episodes: [] };
      return { pane: copy(paneFacts.get(key)) || null,
        episodes: ordered(episodesOf(byPane.get(key))).slice(-5).reverse().map(recallRow) };
    },
    recallProject(project) {
      const key = projectKey(project);
      if (!key) return { project: null, episodes: [], summaries: [] };
      return { project: copy(projectFacts.get(key)) || null,
        episodes: ordered(episodesOf(byProject.get(key))).slice(-5).reverse().map(recallRow),
        summaries: [...summaries.values()].filter(summary => projectKey(summary.project) === key).slice(-5).map(copy) };
    },
    rollover(day) {
      const key = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dayKey(day ?? now());
      if (!key) return [];
      const written = summaryFor(key);
      if (written.length) { retain(); save(); }
      return written;
    },
    // Clear history: what Lina did and heard goes; what a pane and a project are
    // stays, because that is ownership rather than conversation.
    clearEpisodes() {
      const had = episodes.size || summaries.size;
      episodes.clear(); summaries.clear();
      rebuild();
      if (had) save();
      return had > 0;
    },
    forgetProject(project) {
      const key = projectKey(project);
      if (!key) return false;
      let changed = projectFacts.delete(key);
      for (const episode of episodesOf(byProject.get(key))) { unindex(episode); episodes.delete(episode.requestId); changed = true; }
      for (const [id, summary] of [...summaries]) if (projectKey(summary.project) === key) { summaries.delete(id); changed = true; }
      for (const [id, fact] of [...paneFacts]) if (projectKey(fact.project) === key) { paneFacts.delete(id); changed = true; }
      if (changed) save();
      return changed;
    },
    // Seeding runs once, on the first load with no memory file, so memory is not
    // empty after the update. Saved ledger rows are exact; older stores have only
    // tasks and receipts, from which the verb and outcome are derived the same way
    // the live settle point derives them.
    seedFromConversationStore(input) {
      let added = 0;
      for (const row of Array.isArray(input?.ledger) ? input.ledger : []) {
        if (typeof row?.requestId !== 'string' || episodes.has(row.requestId)) continue;
        if (writeEpisode({ ...row, instruction: row.typedText })) added++;
      }
      for (const task of Array.isArray(input?.tasks) ? input.tasks : []) {
        const requestId = typeof task?.requestId === 'string' ? task.requestId : null;
        if (!requestId || episodes.has(requestId)) continue;
        const receipts = (Array.isArray(input.receipts) ? input.receipts : []).filter(item => item?.requestId === requestId);
        const kinds = new Set(receipts.map(item => item.kind));
        const delivered = receipts.find(item => item.kind === 'send_prompt' &&
          ['written', 'submitted', 'delivered', 'sent', 'acknowledged', 'queued'].includes(item.status));
        const refused = receipts.find(item => item.kind === 'send_prompt' && ['rejected', 'failed'].includes(item.status));
        const created = receipts.find(item => item.kind === 'create_session' && ['created', 'acknowledged'].includes(item.status));
        const closed = receipts.find(item => item.kind === 'close' && ['closed', 'close_requested', 'acknowledged'].includes(item.status));
        const verb = kinds.has('close') ? 'close' : kinds.has('send_prompt') || kinds.has('terminal_interact') ? 'start'
          : kinds.has('create_session') ? 'open' : 'ask';
        const outcome = task.status === 'cancelled' ? 'cancelled'
          : delivered ? 'delivered-unconfirmed' : refused ? 'refused' : closed ? 'closed' : created ? 'created-only'
          : ['failed', 'paused'].includes(task.status) ? 'failed' : 'replied';
        const targetId = receipts.find(item => item.targetId)?.targetId || task.targets?.find(item => item?.id)?.id || null;
        const folder = task.projectPath || task.cwd || receipts.find(item => item.cwd)?.cwd || null;
        const messages = (Array.isArray(input.messages) ? input.messages : []).filter(item => item?.requestId === requestId && item.role === 'user');
        if (writeEpisode({ requestId, at: task.createdAt ?? task.at ?? task.updatedAt, verb, outcome,
          project: folder ? path.basename(String(folder).replace(/[\\/]+$/, '')) : null, cwd: folder,
          pane: targetId ? { id: targetId, name: task.targets?.find(item => item?.id === targetId)?.name ?? null, provider: null } : null,
          typedText: null, error: task.error ?? (refused ? refused.text : null),
          instruction: [task.text, task.instruction, ...messages.map(item => item.text)].filter(Boolean).join(' ') })) added++;
      }
      if (added) {
        for (const key of new Set([...episodes.values()].map(episode => episode.project).filter(Boolean))) recomputeProjectFact(key);
        retain();
        save();
      }
      return added;
    },
    // The block injected on every planning call, before its byte budget is applied.
    planningMemory({ project, cwd, at = now() } = {}) {
      const key = projectKey(project);
      const block = {};
      const fact = key ? projectFacts.get(key) : null;
      // Default provider, last active pane and the last two results. Open
      // questions and aliases stay in the fact and reach the brain through
      // recall_project when it asks, rather than on every call.
      if (fact) block.project = { project: fact.project, ...(fact.defaultProvider && { defaultProvider: fact.defaultProvider }),
        ...(fact.lastActivePane && { lastActivePane: fact.lastActivePane }),
        ...(fact.lastResults.length && { lastResults: fact.lastResults.slice(-2).map(line => line.slice(0, CAPS.projectResult)) }) };
      const scoped = key ? episodesOf(byProject.get(key))
        : cwd ? [...episodes.values()].filter(episode => folderKey(episode.cwd) === folderKey(cwd))
        : [...episodes.values()];
      // The injected episode is leaner than a recall citation: the planner needs
      // what Lina did, where, and how it turned out. Null fields and the pane's
      // provider are retrieval detail and stay behind the recall tools.
      const selected = ordered(scoped).slice(-5);
      if (selected.length) block.episodes = selected.map(episode => ({ requestId: episode.requestId, at: episode.at,
        verb: episode.verb, outcome: episode.outcome,
        ...(episode.pane && { pane: { id: episode.pane.id, ...(episode.pane.name && { name: episode.pane.name }) } }),
        ...(episode.typedText && { typedText: episode.typedText.slice(0, 200) }),
        ...(episode.error && { error: episode.error.slice(0, 120) }),
        ...(episode.results.length && { result: episode.results.at(-1).slice(0, 160) }) }));
      const today = dayKey(at);
      const elsewhere = [...new Set(episodesOf(byDay.get(today)).map(episode => episode.project)
        .filter(name => name && projectKey(name) !== key))];
      if (elsewhere.length) {
        block.elsewhere = `${elsewhere.length} other project${elsewhere.length === 1 ? '' : 's'} active today: ${elsewhere.slice(0, 3).join(', ')}`;
      }
      return Object.keys(block).length ? block : undefined;
    },
    latestDay,
    dayKey,
    snapshot,
    wasEmpty: () => !fileExisted,
    get size() { return episodes.size; },
    clear() {
      epoch++;
      episodes.clear(); paneFacts.clear(); projectFacts.clear(); summaries.clear(); rebuild();
      chain = chain.then(async () => {
        try { await fs.promises.rm(file, { force: true }); await fs.promises.rm(temporary, { force: true }); lastError = null; }
        catch (error) { lastError = error; }
      });
      return chain;
    },
    async flush() { await chain; if (lastError) throw lastError; },
  };
}

// The injected block, inside a fixed byte budget enforced here rather than left
// to fitMessages: the addressed project's own facts and its five most recent
// episodes are what a follow-up refers to, so the oldest episode goes first.
function boundedMemory(block, { maxBytes = 3072 } = {}) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const result = { ...block };
  if (Array.isArray(result.episodes)) result.episodes = result.episodes.slice(-5);
  const size = () => bytes(result);
  while (size() > maxBytes && Array.isArray(result.episodes) && result.episodes.length > 1) result.episodes = result.episodes.slice(1);
  if (size() > maxBytes && result.project) {
    result.project = { ...result.project, lastResults: (result.project.lastResults || []).slice(-1), openQuestions: undefined };
  }
  if (size() > maxBytes && Array.isArray(result.episodes)) {
    result.episodes = result.episodes.map(episode => ({ ...episode,
      typedText: episode.typedText ? episode.typedText.slice(0, 120) : episode.typedText,
      resultExcerpt: episode.resultExcerpt ? episode.resultExcerpt.slice(0, 120) : episode.resultExcerpt }));
  }
  if (size() > maxBytes) delete result.elsewhere;
  if (size() > maxBytes) delete result.project;
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (value === undefined || value === null || (Array.isArray(value) && !value.length)) delete result[key];
  }
  return Object.keys(result).length ? result : undefined;
}

// The questions the user asks most about Lina's own actions, as templates. A
// match is a lookup in the store, never a model call; anything that does not
// match falls through to the brain exactly as before. These are questions only:
// a correction such as "you didn't put in that prompt" asks for the delivery to
// be checked and repaired, which is the correction path's work, not a lookup.
const TEMPLATES = [
  { kind: 'recent-actions', pattern: /\bwhat (?:did|have) you (?:do|done|been doing)\b/i },
  { kind: 'last-prompt', pattern: /\bwhat (?:was|were) the last prompt\b/i },
  { kind: 'last-prompt', pattern: /\bdid you (?:enter|send|put in|paste|type|submit)\b[^?.!]{0,40}?\bprompt\b/i },
  { kind: 'last-prompt', pattern: /\bwhich (?:pane|terminal|one) did (?:i|you) (?:send|put|paste|type)\b/i },
  { kind: 'last-error', pattern: /\bwhat (?:was|is) (?:that|the|my|the last) (?:error|failure|problem|issue)\b/i },
  { kind: 'pane-result', pattern: /\bwhat(?:['’]s| is| was| were)? the (?:result|results|outcome|findings?)\b/i },
  { kind: 'pane-result', pattern: /\bwhat did (?:the\s+)?(.{2,80}?)\s*(?:terminal|agent|pane)?\s*(?:say|come back with|find|report|return)\b/i, capture: 'paneWords' },
];
const MINUTES = /\blast\s+(\d{1,3})\s*(?:minute|minutes|min|mins)\b/i;
// A sentence that asks about the past AND requests something new is not a lookup:
// only the brain can do both, so the fast path declines it and falls through.
const ALSO_REQUESTS = /\b(?:and|then|also|now)\b[^.?!]{0,80}?\b(?:put (?:it|that|them) in|send (?:it|that|them)|prompt it|ask me|do it|open|close|start|create|make|run)\b/i;
function memoryQuestion(instruction) {
  const sentence = String(instruction ?? '').trim();
  if (!sentence || sentence.length > 400 || ALSO_REQUESTS.test(sentence)) return null;
  for (const template of TEMPLATES) {
    const match = template.pattern.exec(sentence);
    if (!match) continue;
    const result = { kind: template.kind };
    if (template.capture === 'paneWords') {
      const words = text(match[1], 120);
      // "you" is the assistant, not a pane; that sentence is a recent-actions ask.
      if (!words || /^(?:you|it|that|this|they|he|she)$/i.test(words)) continue;
      result.paneWords = words;
    }
    const minutes = MINUTES.exec(sentence);
    if (minutes) result.minutes = Math.min(1440, Number(minutes[1]) || 0) || undefined;
    return result;
  }
  return null;
}

// Answers the matched question from the store, or returns null when the store
// does not hold the answer and the brain should take the request as it does now.
function answerMemoryQuestion(store, match, { project, at = Date.now() } = {}) {
  if (!store || !match) return null;
  const scoped = rows => {
    const here = project ? rows.filter(row => projectKey(row.project) === projectKey(project)) : [];
    return here.length ? here : rows;
  };
  if (match.kind === 'last-prompt') {
    const [latest] = scoped(store.recall({ limit: 20 })).filter(row => row.typedText);
    if (!latest) return null;
    return { key: 'last-prompt', episode: latest,
      context: { pane: latest.pane?.name || latest.pane?.provider || undefined, typedText: latest.typedText, outcome: latest.outcome } };
  }
  if (match.kind === 'last-error') {
    const [failed] = scoped(store.recall({ limit: 20 })).filter(row => row.error);
    if (!failed) return null;
    return { key: 'last-error', episode: failed, context: { pane: failed.pane?.name || undefined, reason: failed.error } };
  }
  if (match.kind === 'pane-result') {
    const rows = match.paneWords ? store.recall({ query: match.paneWords, limit: 10 }) : scoped(store.recall({ limit: 20 }));
    const answered = rows.find(row => row.resultExcerpt);
    if (!answered) return null;
    return { key: 'pane-result', episode: answered,
      context: { pane: answered.pane?.name || undefined, summary: answered.resultExcerpt } };
  }
  if (match.kind === 'recent-actions') {
    const since = match.minutes ? at - match.minutes * 60000 : undefined;
    const rows = store.recall({ limit: 20, ...(since !== undefined && { since }) })
      .filter(row => since !== undefined || dayKey(row.at) === dayKey(at));
    const listed = scoped(rows).slice(0, 4);
    if (!listed.length) return null;
    const actions = listed.map(row => `${VERB_PHRASE[row.verb] || 'worked in'} ${row.pane?.name || row.project || 'the workspace'}`).join('; ');
    return { key: 'recent-actions', episode: listed[0], context: { actions: actions.slice(0, 300) } };
  }
  return null;
}

module.exports = { createMemoryStore, boundedMemory, memoryQuestion, answerMemoryQuestion,
  topicsFrom, dayKey, VERSION, FILE, LIMITS, CAPS, HALF_LIFE_MS };
