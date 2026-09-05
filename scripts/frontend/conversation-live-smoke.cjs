'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
function load(file, mocks = {}) {
  const filename = path.resolve(__dirname, '../../frontend', file), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => name in mocks ? mocks[name] : name.startsWith('.') ? load(path.relative(path.resolve(__dirname, '../../frontend'), path.resolve(path.dirname(filename), `${name}.ts`)), mocks) : original(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return loaded.exports;
}
const { conversationPage, rebuildConversation } = load('conversationLive.ts');
const fragment = (id, text, start = 0, role = 'assistant') => ({ messageId: id, text, start, end: start + text.length, role });
const page = (version, fragments, cursor = null, hasMore = Boolean(cursor)) => ({ ok: true, sourceVersion: version, messages: fragments.map(({ role, text }) => ({ role, text })), messageRanges: fragments.map(({ messageId, start, end }) => ({ messageId, start, end })), nextCursor: cursor, hasMore });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function nodes(tree) { if (!tree || typeof tree !== 'object') return []; return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]; }
function text(tree) { if (typeof tree === 'string' || typeof tree === 'number') return String(tree); return tree && typeof tree === 'object' ? [tree.props?.children].flat(Infinity).map(text).join('') : ''; }
function harness(dispatch) {
  const cells = [], effects = [], layout = [], timers = new Map(), listeners = new Map(); let index = 0, serial = 0, dirty = false, mounted = true, tree;
  const element = { scrollHeight: 1200, clientHeight: 300, scrollTop: 0 };
  const effect = queue => (run, deps) => { const at = index++; const old = cells[at]; if (!old || !deps || deps.some((value, i) => value !== old.deps[i])) { old?.cleanup?.(); cells[at] = { deps }; queue.push(() => { cells[at].cleanup = run(); }); } };
  const react = {
    useState(initial) { const at = index++; if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial; return [cells[at], value => { if (!mounted) throw Error('State update after unmount'); const next = typeof value === 'function' ? value(cells[at]) : value; if (next !== cells[at]) { cells[at] = next; dirty = true; } }]; },
    useRef(initial) { const at = index++; return cells[at] ||= { current: initial }; },
    useEffect: effect(effects), useLayoutEffect: effect(layout),
  };
  global.document = { hidden: false, addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } };
  global.setInterval = callback => { timers.set(++serial, callback); return serial; };
  global.clearInterval = id => timers.delete(id);
  const { ConversationHistory } = load('components/ConversationHistory.tsx', { react, '../orchestratorUi': { relayApi: () => ({ dispatch }) } });
  function render() { index = 0; dirty = false; tree = ConversationHistory({ folders: [] }); const reader = nodes(tree).find(node => node.props?.['aria-label'] === 'Saved conversation messages'); if (reader) reader.ref.current = element; while (layout.length) layout.shift()(); while (effects.length) effects.shift()(); return tree; }
  async function flush() { for (let i = 0; i < 80; i++) { await Promise.resolve(); if (dirty && mounted) render(); } }
  render();
  return {
    flush, element, timers,
    get tree() { return tree; },
    reader() { return nodes(tree).find(node => node.props?.['aria-label'] === 'Saved conversation messages'); },
    button(label) { return nodes(tree).find(node => node.type === 'button' && text(node) === label); },
    async click(label) { const button = this.button(label); assert(button, `Missing button ${label}: ${text(tree)}`); button.props.onClick?.(); await flush(); },
    async select(reference) { const row = nodes(tree).find(node => node.props?.className === 'conversation-history-item' && node.key === reference); assert(row); row.props.onClick(); await flush(); },
    async tick() { for (const callback of timers.values()) callback(); await flush(); },
    scroll(top) { element.scrollTop = top; this.reader().props.onScroll({ currentTarget: element }); },
    hide(hidden) { document.hidden = hidden; listeners.get('visibilitychange')?.(); },
    unmount() { for (const cell of cells) cell?.cleanup?.(); mounted = false; },
  };
}

(async () => {
  // One source only, even when a long Unicode message crosses several pages.
  const unicode = '漢字🧪café\n'.repeat(6000);
  const cuts = [0, 15000, 30000, 45000, unicode.length];
  const fragments = cuts.slice(0, -1).map((start, i) => fragment('long', unicode.slice(start, cuts[i + 1]), start));
  const pages = fragments.map((part, i) => conversationPage(page('v2', [part], i ? `p${i - 1}` : null)));
  let reads = 0;
  const reconstructed = await rebuildConversation(pages.at(-1), [fragment('long', unicode)], async cursor => { reads++; return pages[Number(cursor.slice(1))]; }, () => true);
  assert.equal(reconstructed.fragments[0].text, unicode); assert.equal(reconstructed.fragments.length, 1); assert.equal(reads, pages.length - 1);
  const changed = await rebuildConversation(pages.at(-1), [fragment('long', unicode)], async () => ({ ...pages[1], sourceVersion: 'v3' }), () => true);
  assert.equal(changed, null, 'a changed source never partially updates the reader');
  let budgetReads = 0;
  const bounded = await rebuildConversation(conversationPage(page('v2', [fragment('new', 'x')], 'p0')), [fragment('missing', 'old')], async () => { budgetReads++; return conversationPage(page('v2', [fragment(`new${budgetReads}`, 'x')], `p${budgetReads}`)); }, () => true);
  assert.equal(bounded, null); assert.equal(budgetReads, 4, 'rebuild has a bounded read budget');
  const rewritten = await rebuildConversation(conversationPage(page('v2', [fragment('replacement', 'fresh')])), [fragment('removed', 'stale')], async () => { throw Error('unexpected older read'); }, () => true);
  assert.deepEqual(rewritten.fragments.map(part => part.text), ['fresh']);
  const trimmed = await rebuildConversation(pages.at(-1), [fragment('long', unicode.slice(30100), 30100)], async cursor => pages[Number(cursor.slice(1))], () => true);
  assert.equal(trimmed.fragments[0].start, 30100); assert.equal(trimmed.fragments[0].text, unicode.slice(30100));
  assert.equal(trimmed.bufferedOlder[0].text + trimmed.fragments[0].text, unicode.slice(30000), 'buffer preserves the fetched prefix without adding it to the live view');
  assert.equal(trimmed.olderCursor, 'p1', 'cursor stays before the fetched page and buffered prefix');
  const safePair = await rebuildConversation(conversationPage(page('v2', [fragment('pair', 'a🧪b')])), [fragment('pair', 'old', 2)], async () => { throw Error('unexpected'); }, () => true);
  assert.equal(safePair.fragments[0].start, 1); assert.equal(safePair.fragments[0].text, '🧪b'); assert.equal(safePair.bufferedOlder[0].text, 'a');
  const shortened = await rebuildConversation(conversationPage(page('v2', [fragment('shortened', 'abc'), fragment('next', 'new')])), [fragment('shortened', 'old suffix', 3)], async () => { throw Error('unexpected'); }, () => true);
  assert.deepEqual(shortened.fragments.map(part => part.text), ['new']);
  assert.equal(shortened.bufferedOlder[0].text, 'abc', 'shortened anchor remains available without rendering an empty message');
  assert.throws(() => conversationPage({ ...page('v1', [fragment('m', 'abc')]), sourceVersion: '' }), /source version/);

  const realInterval = global.setInterval, realClearInterval = global.clearInterval, realDocument = global.document;
  let ui;
  try {
    let a = page('a1', [fragment('m', 'First reply')], 'older-a1');
    const calls = []; let held = null, heldSearch = null, active = 0, maximum = 0, failRead = false;
    const dispatch = async request => {
      calls.push(request);
      if (request.kind === 'list_conversations') return { ok: true, conversations: [{ reference: 'a', id: 'a', title: 'A', cwd: 'C:/test', provider: 'codex' }, { reference: 'b', id: 'b', title: 'B', cwd: 'C:/test', provider: 'codex' }] };
      if (request.kind === 'search_conversation') {
        if (heldSearch) { const pending = heldSearch; heldSearch = null; return pending.promise; }
        return { ok: true, sourceVersion: a.sourceVersion, matches: [{ role: 'assistant', snippet: 'Edited reply', readCursor: 'match', messageId: 'm' }], coverage: { complete: true } };
      }
      assert.equal(request.kind, 'read_conversation'); active++; maximum = Math.max(maximum, active);
      try {
        if (held) { const pending = held; held = null; return await pending.promise; }
        if (failRead) throw Error('History unavailable');
        if (request.reference === 'b') return page('b1', [fragment('b', 'Other chat')]);
        if (request.cursor) return page(a.sourceVersion, [fragment('old', 'Earlier 🧪 messages')]);
        return a;
      } finally { active--; }
    };
    ui = harness(dispatch); await ui.flush(); await ui.tick();
    assert.equal(calls.filter(call => call.kind === 'read_conversation').length, 0, 'no selected conversation means no polling');
    await ui.select('a'); assert(text(ui.reader()).includes('First reply')); assert.equal(ui.element.scrollTop, 1200, 'initial view follows latest');
    a = page('a2', [fragment('m', 'First reply'), fragment('n', 'New reply')], 'older-a2');
    await ui.tick(); assert(text(ui.reader()).includes('New reply'), 'new response appears without clicking'); assert.equal(ui.element.scrollTop, 1200);
    a = page('a3', [fragment('m', 'Edited reply'), fragment('n', 'New reply')], 'older-a3');
    await ui.tick(); assert(!text(ui.reader()).includes('First reply')); assert(text(ui.reader()).includes('Edited reply'), 'same message ID edits replace old text');
    ui.scroll(100); a = page('a4', [fragment('m', 'Edited reply'), fragment('n', 'New reply'), fragment('o', 'While reading')], 'older-a4');
    await ui.tick(); assert(ui.button('Conversation updated')); assert(!text(ui.reader()).includes('While reading')); assert.equal(ui.element.scrollTop, 100);
    await ui.click('Conversation updated'); assert(text(ui.reader()).includes('While reading')); assert.equal(ui.element.scrollTop, 1200);
    await ui.click('Load earlier'); assert(text(ui.reader()).includes('Earlier 🧪 messages')); const olderText = text(ui.reader()), oldTop = ui.element.scrollTop;
    a = page('a5', [fragment('m', 'Edited reply'), fragment('n', 'New reply'), fragment('o', 'While reading'), fragment('p', 'After earlier load')]);
    await ui.tick(); assert.equal(text(ui.reader()), olderText); assert.equal(ui.element.scrollTop, oldTop); assert(ui.button('Conversation updated'));
    await ui.click('Latest'); assert(text(ui.reader()).includes('After earlier load'));
    // Searches pause automatic replacement and cannot attach fresh cursors to an old view.
    const searchInput = () => nodes(ui.tree).find(node => node.props?.['aria-label'] === 'Search text in selected conversation');
    searchInput().props.onChange({ target: { value: 'Edited' } }); await ui.flush();
    const submitSearch = async () => { const form = nodes(ui.tree).find(node => node.type === 'form' && nodes(node).includes(searchInput())); assert(form); form.props.onSubmit({ preventDefault() {} }); await ui.flush(); };
    held = deferred(); const searchPoll = held; await ui.tick(); heldSearch = deferred(); const pendingSearch = heldSearch;
    await submitSearch(); searchPoll.resolve(page('a6', [fragment('m', 'New during search')])); await ui.flush();
    pendingSearch.resolve({ ok: true, sourceVersion: 'a5', matches: [{ role: 'assistant', snippet: 'Edited reply', readCursor: 'match', messageId: 'm' }], coverage: { complete: true } }); await ui.flush();
    assert(ui.button('Jump to match')); assert(!text(ui.reader()).includes('New during search'), 'pending search invalidates a live replacement');
    a = page('a6', [fragment('m', 'New during search')]); await ui.tick(); assert(ui.button('Jump to match'), 'version polling preserves searches while browsing'); assert(ui.button('Conversation updated'));
    await submitSearch(); assert(!ui.button('Jump to match')); assert(text(ui.tree).includes('Use Latest before searching'));
    await ui.click('Latest'); assert.equal(searchInput().props.value, 'Edited', 'refresh preserves typed search query');
    // Repeated failures preserve content, expose a stable status, and back off.
    const beforeFailure = text(ui.reader()); failRead = true;
    await ui.tick(); await ui.tick(); assert(!text(ui.tree).includes('temporarily unavailable')); await ui.tick(); assert(text(ui.tree).includes('temporarily unavailable')); assert.equal(text(ui.reader()), beforeFailure);
    const requestsBeforeBackoff = calls.length; await ui.tick(); await ui.tick(); await ui.tick(); await ui.tick(); assert.equal(calls.length, requestsBeforeBackoff);
    failRead = false; await ui.tick(); assert(!text(ui.tree).includes('temporarily unavailable'));
    // Buffered older text is available even when the fresh source has no older cursor.
    a = page('a7', [fragment('m', 'Prefix plus New during search', 0)]);
    held = deferred(); const partial = held;
    const latestClick = ui.click('Latest'); partial.resolve(page('a7', [fragment('m', 'New during search', 12)])); await latestClick;
    a = page('a8', [fragment('m', 'Prefix plus New during search and append')]); await ui.tick();
    assert(!text(ui.reader()).includes('Prefix plus')); assert(ui.button('Load earlier')); const beforeBuffer = calls.length;
    await ui.click('Load earlier'); assert(text(ui.reader()).includes('Prefix plus New during search and append')); assert.equal(calls.length, beforeBuffer, 'buffered prefix loads without a skipped network page');
    // A provider returning a different revision for a manual older page is rejected.
    a = page('a9', [fragment('m', 'Current tail')], 'old-a9'); await ui.click('Latest'); const frozen = text(ui.reader());
    a = page('a10', [fragment('m', 'Changed tail')]); await ui.click('Load earlier'); assert.equal(text(ui.reader()), frozen); assert(ui.button('Conversation updated'));
    await ui.click('Latest');
    const beforeHidden = calls.length; ui.hide(true); await ui.tick(); assert.equal(calls.length, beforeHidden);
    ui.hide(false); held = deferred(); const hiddenPending = held; await ui.tick(); ui.hide(true); hiddenPending.resolve(page('a6', [fragment('m', 'Hidden stale update')])); await ui.flush(); assert(!text(ui.reader()).includes('Hidden stale update'));
    ui.hide(false); held = deferred(); const pending = held; await ui.tick(); const beforeOverlap = calls.length; await ui.tick(); await ui.tick(); assert.equal(calls.length, beforeOverlap, 'only one poll request is in flight');
    await ui.select('b'); pending.resolve(page('a6', [fragment('m', 'Wrong conversation')])); await ui.flush(); assert(text(ui.reader()).includes('Other chat')); assert(!text(ui.reader()).includes('Wrong conversation')); assert.equal(maximum, 1, 'manual and automatic reads are serialized');
    held = deferred(); const unmounted = held; await ui.tick(); ui.unmount(); unmounted.resolve(page('b2', [fragment('b', 'After unmount')])); await ui.flush(); assert.equal(ui.timers.size, 0);
    ui = null;
  } finally { ui?.unmount(); global.setInterval = realInterval; global.clearInterval = realClearInterval; if (realDocument === undefined) delete global.document; else global.document = realDocument; }
  console.log('Conversation live smoke passed: fresh replies, same-ID edits, browsing preservation, Unicode rebuild, revision/budget guards, visibility/selection/unmount races, serialized reads.');
})().catch(error => { console.error(error); process.exitCode = 1; });
