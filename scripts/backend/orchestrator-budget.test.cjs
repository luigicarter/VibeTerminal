'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelInputBudget, fitMessages, createReadBudget } = require('../../backend/orchestratorBudget.cjs');
const size = value => Buffer.byteLength(JSON.stringify(value));

test('model input budget reserves output and protocol, has fallback and hard ceiling', () => {
  assert.equal(modelInputBudget(1000000), 48000);
  assert.equal(modelInputBudget(undefined), 14160);
  assert.equal(modelInputBudget(4096), 1872);
  assert.equal(modelInputBudget(100), 0);
});
test('many Unicode and escaped reads respect request and individual serialized excerpt budgets', () => {
  const budget = createReadBudget();
  let spent = 0;
  for (let sequence = 0; sequence < 50; sequence++) {
    const result = budget.projectRead({ id: 'a', generation: 'g', sequence, status: 'waiting', text: ('漢😀\n"\\').repeat(20000), history: 'SECRET_HISTORY', screen: 'DUPLICATE_SCREEN' });
    const cost = size(result.text || '') - 2;
    spent += cost;
    assert.ok(cost <= 4000);
    assert.ok(spent <= 12000);
    assert.equal(result.status, 'waiting');
    assert.equal(result.sequence, sequence);
    assert.equal(result.history, undefined);
    assert.equal(result.screen, undefined);
    assert.equal(JSON.stringify(result).includes('SECRET_HISTORY'), false);
    assert.equal((result.text || '').includes('\ufffd'), false);
  }
  assert.equal(budget.remainingBytes, 12000 - spent);
});
test('same pane generation and sequence does not duplicate output; changes and generations do', () => {
  const budget = createReadBudget({ maxBytes: 10, perReadBytes: 4 });
  assert.equal(budget.projectRead({ id: 'a', generation: 1, sequence: 1, text: 'abcdef' }).text, 'cdef');
  const duplicate = budget.projectRead({ id: 'a', generation: 1, sequence: 1, text: 'abcdef', status: 'complete' });
  assert.equal(duplicate.text, undefined);
  assert.equal(duplicate.unchanged, true);
  assert.equal(duplicate.status, 'complete');
  assert.equal(budget.projectRead({ id: 'a', generation: 1, sequence: 2, text: 'abcdefXY' }).text, 'efXY');
  assert.equal(budget.projectRead({ id: 'a', generation: 2, sequence: 2, text: 'new' }).text, 'ew');
  assert.equal(budget.remainingBytes, 0);
  assert.equal(budget.projectRead({ id: 'a', generation: 2, sequence: 3, text: 'no more', status: 'failed' }).status, 'failed');
});
test('fit shrinks context but preserves current exact instruction and target without mutation', () => {
  const instruction = 'Tell A: ' + '漢"\\'.repeat(40);
  const messages = [{ role: 'system', content: 'POLICY' }, { role: 'user', content: JSON.stringify({ instruction, targetId: 'a', conversationTarget: { id: 'a', generation: 'g' }, roots: { projects: 'large'.repeat(4000) }, recentConversation: Array(8).fill({ text: 'old'.repeat(4000) }), sessions: Array(40).fill({ id: 'old', name: 'big'.repeat(500) }) }) }];
  const initial = JSON.stringify(messages);
  const fitted = fitMessages({ messages, contextLength: 4096 });
  assert.ok(size({ messages: fitted, tools: [] }) <= modelInputBudget(4096));
  assert.equal(fitted[0].content, 'POLICY');
  const user = JSON.parse(fitted[1].content);
  assert.equal(user.instruction, instruction);
  assert.deepEqual(user.conversationTarget, { id: 'a', generation: 'g' });
  assert.equal(user.targetId, 'a');
  assert.equal(JSON.stringify(messages), initial);
});
test('tool compaction retains protocol pairing and authoritative receipts', () => {
  const messages = [{ role: 'system', content: 'POLICY' }, { role: 'user', content: 'current exact request' }];
  for (let i = 0; i < 5; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `call${i}`, type: 'function', function: { name: 'workspace', arguments: '{"kind":"read_session"}' } }] });
    messages.push({ role: 'tool', tool_call_id: `call${i}`, content: JSON.stringify({ ok: true, status: 'delivered', target: { id: 'a', generation: 'g' }, observation: { status: 'waiting', text: i === 4 ? 'latest page' : 'huge'.repeat(3000), history: 'private' } }) });
  }
  const fitted = fitMessages({ messages, tools: [{ type: 'function' }], contextLength: 10000, maxBytes: 4500 });
  assert.ok(size({ messages: fitted, tools: [{ type: 'function' }] }) <= 4500);
  assert.equal(fitted.length, messages.length);
  assert.equal(JSON.parse(fitted.at(-1).content).observation.text, 'latest page');
  for (let i = 2; i < fitted.length; i += 2) {
    assert.equal(fitted[i].tool_calls[0].id, fitted[i + 1].tool_call_id);
    const receipt = JSON.parse(fitted[i + 1].content);
    assert.equal(receipt.status, 'delivered');
    assert.equal(receipt.observation.status, 'waiting');
    assert.deepEqual(receipt.target, { id: 'a', generation: 'g' });
  }
});
test('batch reset permits later pages and preserves source cursor provenance and page order', () => {
  const budget = createReadBudget({ maxBytes: 4, perReadBytes: 4 });
  const original = { id: 'a', sequence: 1, source: 'archive', range: { start: 0, end: 6 }, nextCursor: '6', hasMore: true, text: 'abcdef' };
  const snapshot = JSON.stringify(original);
  const first = budget.projectRead(original, { tail: false });
  assert.equal(first.text, 'abcd');
  assert.equal(first.retrySamePage, true);
  assert.equal(first.contextTrimmed, true);
  assert.equal(first.nextCursor, '6');
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.range, original.range);
  assert.equal(first.source, 'archive');
  assert.equal(budget.remainingBytes, 0);
  budget.reset();
  assert.equal(budget.remainingBytes, 4);
  assert.equal(budget.projectRead(original, { tail: false }).text, 'abcd');
  budget.reset();
  const next = budget.projectRead({ ...original, range: { start: 6, end: 10 }, text: 'ghij' }, { tail: false });
  assert.equal(next.text, 'ghij');
  assert.equal(next.unchanged, false);
  assert.equal(next.retrySamePage, undefined);
  assert.equal(JSON.stringify(original), snapshot);
});
test('fifty progressive scan rounds preserve latest page and exact user payload within a bounded context', () => {
  const budget = createReadBudget();
  const instruction = 'Scan the complete source progressively, then compare the errors; do not modify files.';
  const target = { id: 'a', generation: 'g' };
  let messages = [{ role: 'system', content: 'POLICY' }, { role: 'user', content: JSON.stringify({ instruction, conversationTarget: target, recentConversation: [{ text: 'old'.repeat(3000) }] }) }];
  let bytesRead = 0;
  for (let round = 0; round < 50; round++) {
    budget.reset();
    const source = { id: 'a', generation: 'g', source: 'native-history', range: { start: round * 1000, end: (round + 1) * 1000 }, nextCursor: String(round + 1), hasMore: round < 49, text: `PAGE ${round} ` + '漢'.repeat(1000) };
    const original = JSON.stringify(source);
    const projected = budget.projectRead(source, { tail: false });
    bytesRead += size(projected.text);
    messages.push({ role: 'assistant', tool_calls: [{ id: `page${round}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify({ kind: 'read_conversation', cursor: String(round) }) } }] });
    messages.push({ role: 'tool', tool_call_id: `page${round}`, content: JSON.stringify(projected) });
    messages = fitMessages({ messages, contextLength: 16000, maxBytes: 7500 });
    assert.ok(size({ messages, tools: [] }) <= 7500);
    const user = JSON.parse(messages.find(message => message.role === 'user').content);
    assert.equal(user.instruction, instruction);
    assert.deepEqual(user.conversationTarget, target);
    const latest = JSON.parse(messages.at(-1).content);
    assert.equal(latest.text, source.text);
    assert.equal(latest.nextCursor, source.nextCursor);
    assert.equal(JSON.stringify(source), original);
    for (let i = 2; i < messages.length; i += 2) assert.equal(messages[i].tool_calls[0].id, messages[i + 1].tool_call_id);
  }
  assert.ok(bytesRead > 12000 * 10);
});
test('oversized newest page fails locally instead of silently discarding unread source content', () => {
  const messages = [{ role: 'system', content: 'POLICY' }, { role: 'user', content: 'Scan the source' }, { role: 'assistant', tool_calls: [{ id: 'a', type: 'function', function: { name: 'workspace', arguments: '{"kind":"read_conversation"}' } }] }, { role: 'tool', tool_call_id: 'a', content: JSON.stringify({ text: 'latest'.repeat(1000), nextCursor: 'next' }) }];
  assert.throws(() => fitMessages({ messages, contextLength: 4096 }), { code: 'LOCAL_CONTEXT_LIMIT' });
});
test('tiny model fails locally before a caller can send HTTP; plain instructions and schemas immutable', () => {
  let calls = 0;
  function caller() {
    const messages = fitMessages({ messages: [{ role: 'system', content: 'policy' }, { role: 'user', content: 'exact request'.repeat(1000) }], tools: [{ schema: 'required' }], contextLength: 100 });
    calls++;
    return messages;
  }
  assert.throws(caller, { code: 'LOCAL_CONTEXT_LIMIT' });
  assert.equal(calls, 0);
});


test('saved conversation page deduplication respects source revision and page ranges', () => {
  const budget=createReadBudget();const page={reference:'ref',sourceVersion:'v1',range:{start:0,end:10},text:'first page'};
  assert.equal(budget.projectRead(page,{tail:false}).text,'first page');
  assert.equal(budget.projectRead(page,{tail:false}).unchanged,true);
  assert.equal(budget.projectRead({...page,sourceVersion:'v2',text:'new output'},{tail:false}).text,'new output');
  budget.reset();assert.equal(budget.projectRead(page,{tail:false}).text,'first page');
});
