'use strict';
// Loader and validator for the completion-ladder corpus.
//
// The corpus is data, and the one rule that matters is that it never becomes a
// second, drifting copy of what the user said: a turn that carries a `row`
// number must quote that row of scripts/backend/fixtures/orchestrator-utterances.json
// character for character, and a turn that carries no row must declare itself
// `synthetic`. Loading checks both, so a typo in a quoted sentence fails the
// load rather than quietly grading a different sentence.
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = path.resolve(__dirname, '../../backend/fixtures');
const CORPUS_FILE = path.join(FIXTURES, 'orchestrator-completion-ladder.json');
const UTTERANCES_FILE = path.join(FIXTURES, 'orchestrator-utterances.json');

const PANE_STATES = new Set(['idle', 'working', 'needs-input', 'done']);
const EXPECT_KEYS = new Set(['taskStatus', 'paneDelta', 'paneDeltaTotal', 'paneDeltaAtMost', 'createdKind',
  'promptDelivered', 'targetRef', 'targetRefAnyOf', 'targetRefsAll', 'ledgerOutcome', 'ledgerVerb',
  'paneScreenMatches', 'deliveredOrReplyMatches', 'interactedRef', 'replyMatches', 'replyMentions', 'replyMentionsAnyOf', 'noEffects', 'interruptedRef',
  'survivingRefs', 'question', 'questionAllowed']);
const FORBID_KEYS = new Set(['paneCreated', 'closedAny', 'interruptedAny', 'anyEffect', 'anyPromptDelivered', 'taskSent',
  'typedIntoRefs', 'question', 'replyMatchesForbidden']);
const GRADE_SOURCES = new Set(['paneCount', 'taskStatus', 'ledger', 'receipts', 'paneScreens', 'reply', 'memory', 'diagnostics']);
// Only the provider kinds whose CLI homes this harness can redirect. Everything
// else writes the user's real home and must never appear in a scenario.
const ALLOWED_KINDS = new Set(['codex', 'claude']);

const refsIn = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
  .filter(item => typeof item === 'string');

function validateCorpus(corpus, utterances) {
  const problems = [];
  const rows = new Map(utterances.map(row => [row.n, row]));
  const seenScenarios = new Set(), seenTurns = new Set();
  if (!Array.isArray(corpus?.scenarios) || !corpus.scenarios.length) problems.push('the corpus declares no scenarios');
  const projects = new Set(corpus?.projects || []);
  for (const scenario of corpus?.scenarios || []) {
    const where = `scenario ${scenario?.id}`;
    if (!scenario?.id) problems.push('a scenario has no id');
    else if (seenScenarios.has(scenario.id)) problems.push(`${where} is declared twice`);
    seenScenarios.add(scenario?.id);
    if (!Number.isInteger(scenario?.tier)) problems.push(`${where} has no tier`);
    const refs = new Set();
    for (const pane of scenario?.setup?.panes || []) {
      if (!pane?.ref) problems.push(`${where} has a pane with no ref`);
      if (refs.has(pane.ref)) problems.push(`${where} declares the pane ref ${pane.ref} twice`);
      refs.add(pane.ref);
      if (!ALLOWED_KINDS.has(pane.kind)) problems.push(`${where} pane ${pane.ref} uses kind ${pane.kind}, which writes the user's real CLI home`);
      if (!PANE_STATES.has(pane.state)) problems.push(`${where} pane ${pane.ref} has state ${pane.state}`);
      if (!projects.has(pane.project)) problems.push(`${where} pane ${pane.ref} names the unregistered project ${pane.project}`);
      if (pane.state !== 'idle' && !pane.objective) problems.push(`${where} pane ${pane.ref} is ${pane.state} but has no objective`);
      if (pane.state === 'done' && !pane.marker) problems.push(`${where} pane ${pane.ref} is done but names no marker`);
    }
    if (!Array.isArray(scenario?.turns) || !scenario.turns.length) problems.push(`${where} has no turns`);
    const turnIds = new Set();
    for (const turn of scenario?.turns || []) {
      const at = `${where} turn ${turn?.id}`;
      if (!turn?.id) problems.push(`${where} has a turn with no id`);
      else if (seenTurns.has(turn.id)) problems.push(`turn id ${turn.id} is declared twice`);
      seenTurns.add(turn?.id);
      turnIds.add(turn?.id);
      if (typeof turn?.text !== 'string' || !turn.text.trim()) problems.push(`${at} has no text`);
      if (turn?.row === undefined && turn?.synthetic !== true) problems.push(`${at} quotes no row and is not marked synthetic`);
      if (turn?.row !== undefined) {
        const row = rows.get(turn.row);
        if (!row) problems.push(`${at} quotes row #${turn.row}, which the utterance corpus does not have`);
        else if (row.text !== turn.text) problems.push(`${at} does not quote row #${turn.row} verbatim`);
        if (turn.synthetic) problems.push(`${at} quotes a row and is also marked synthetic`);
      }
      if (turn?.from && !projects.has(turn.from)) problems.push(`${at} is submitted from the unregistered project ${turn.from}`);
      for (const key of Object.keys(turn?.expect || {})) if (!EXPECT_KEYS.has(key)) problems.push(`${at} expects the unknown key ${key}`);
      for (const key of Object.keys(turn?.forbid || {})) if (!FORBID_KEYS.has(key)) problems.push(`${at} forbids the unknown key ${key}`);
      for (const source of turn?.grade || []) if (!GRADE_SOURCES.has(source)) problems.push(`${at} grades on the unknown source ${source}`);
      if (!Array.isArray(turn?.grade) || !turn.grade.length) problems.push(`${at} names no evidence to grade on`);
      if (!Object.keys(turn?.expect || {}).length) problems.push(`${at} expects nothing`);
      // Every pane reference must be resolvable: a setup ref, a pane this turn
      // opened, or an earlier turn in the same scenario.
      const referenced = [...refsIn(turn?.expect?.targetRef), ...refsIn(turn?.expect?.targetRefAnyOf),
        ...refsIn(turn?.expect?.targetRefsAll), ...refsIn(turn?.expect?.interruptedRef),
        ...refsIn(turn?.expect?.survivingRefs), ...refsIn(turn?.forbid?.typedIntoRefs),
        ...refsIn(turn?.expect?.paneScreenMatches?.ref), ...refsIn(turn?.expect?.deliveredOrReplyMatches?.ref), ...refsIn(turn?.expect?.interactedRef)];
      for (const ref of referenced) {
        if (ref === 'created' || refs.has(ref)) continue;
        if (ref.startsWith('@') && turnIds.has(ref.slice(1))) continue;
        problems.push(`${at} references ${ref}, which no setup pane or earlier turn provides`);
      }
      for (const pattern of [turn?.expect?.replyMatches, turn?.forbid?.replyMatchesForbidden,
        turn?.expect?.paneScreenMatches?.pattern, turn?.expect?.deliveredOrReplyMatches?.pattern]) {
        if (pattern === undefined) continue;
        try { new RegExp(String(pattern).replace(/^\(\?i\)/, '')); }
        catch (error) { problems.push(`${at} carries the unreadable pattern ${pattern}`); }
      }
    }
  }
  return problems;
}

function loadLadderCorpus({ tiers, scenario, environments = [], file = CORPUS_FILE, utterancesFile = UTTERANCES_FILE } = {}) {
  const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
  const utterances = JSON.parse(fs.readFileSync(utterancesFile, 'utf8'));
  const problems = validateCorpus(corpus, utterances);
  if (problems.length) throw new Error(`The ladder corpus is not loadable:\n  - ${problems.join('\n  - ')}`);
  let scenarios = corpus.scenarios;
  if (tiers && tiers.size) scenarios = scenarios.filter(item => tiers.has(item.tier));
  if (scenario) scenarios = scenarios.filter(item => item.id === scenario);
  // A scenario marked with an `environment` needs something this machine may not
  // be able to provide. It is opted in explicitly, never run and scored as if it
  // had failed on the Brain's account.
  const skipped = scenarios.filter(item => item.environment && !environments.includes(item.environment));
  scenarios = scenarios.filter(item => !item.environment || environments.includes(item.environment));
  // Only the projects the selection actually needs are registered, so a single
  // scenario run does not build a workspace it never looks at.
  const needed = new Set(scenarios.flatMap(item => [
    ...(item.setup?.panes || []).map(pane => pane.project),
    ...item.turns.map(turn => turn.from)]).filter(Boolean));
  return { ...corpus, scenarios, projects: corpus.projects.filter(name => needed.has(name)),
    skipped: skipped.map(item => ({ id: item.id, tier: item.tier, title: item.title, environment: item.environment,
      turns: item.turns.map(turn => turn.id) })) };
}

module.exports = { loadLadderCorpus, validateCorpus, CORPUS_FILE, UTTERANCES_FILE, ALLOWED_KINDS, EXPECT_KEYS, FORBID_KEYS };
