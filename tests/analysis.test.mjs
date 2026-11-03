import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory-store.mjs';
import { validateObservation, createAnalysis } from '../src/analysis.mjs';

test('FAME extraction rejects invented out-of-range values and preserves unknown dimensions', () => {
  assert.throws(() => validateObservation({memories:[],fame:{user:{vector:{mu:10},confidence:.8}}}), /FAME/);
  const x = validateObservation({memories:[{text:'User likes jasmine tea',route:'../../private'}],fame:{agent:{vector:{chi:.6},confidence:.4}}});
  assert.equal(x.memories[0].route,'conversation/facts');
  assert.equal(x.fame.agent.vector.rho,null);
});

test('annotation is atomic and idempotent across working-generation replacements', async t => {
  const root = mkdtempSync(join(import.meta.dirname, '.analysis-'));
  const store = new MemoryStore(join(root, 'memory.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.createSession('a');
  const user = { seq: 0, type: 'user/message', data: { id: 'u', content: [{ type: 'text', text: 'tea' }] } };
  const assistant = { seq: 1, type: 'assistant/message', data: { message: { id: 'r', content: [{ type: 'text', text: 'remembered' }] } } };
  store.appendEvent('a', 0, user);
  store.appendEvent('a', 0, assistant);
  let calls = 0;
  const ctx = { llm: { async *stream() {
    calls++;
    yield { type: 'text-delta', text: JSON.stringify({ memories: [{ text: 'Prefers tea' }], fame: { user: { vector: { mu: 0.8 }, confidence: 0.5 } } }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const analysis = createAnalysis(ctx, store, {});
  await analysis.afterTurn('a', 'tea', 'remembered');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM fame_states').get().n, 2);
  assert.equal(store.stats('a').memories, 3);
  store.checkpoint('a', { summary: 'tea' });
  store.appendEvent('a', 1, user);
  store.appendEvent('a', 1, assistant);
  await analysis.afterTurn('a', 'tea', 'remembered');
  assert.equal(calls, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM fame_states').get().n, 2);
  assert.equal(store.stats('a').memories, 3);
});

test('long turns reach extraction as complete JSON and repeated replies require exact event references', async t => {
  const root = mkdtempSync(join(import.meta.dirname, '.analysis-'));
  const store = new MemoryStore(join(root, 'memory.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.createSession('a');
  const long = '长'.repeat(32000);
  for (const [seq, text] of [[0, long], [2, 'second']]) {
    store.appendEvent('a', 0, { seq, type: 'user/message', data: { id: `u${seq}`, content: [{ type: 'text', text }] } });
    store.appendEvent('a', 0, { seq: seq + 1, type: 'assistant/message', data: { message: { id: `a${seq}`, content: [{ type: 'text', text: 'okay' }] } } });
  }
  const inputs = [];
  const ctx = { llm: { async *stream(request) {
    inputs.push(JSON.parse(request.messages[0].content[0].text));
    yield { type: 'text-delta', text: '{"memories":[],"fame":{}}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const analysis = createAnalysis(ctx, store, {});
  await analysis.afterTurn('a', 'second', 'okay', { generation: 0, seq: 3 });
  await assert.rejects(analysis.afterTurn('a', long, 'okay'), /exact event reference/);
  await analysis.afterTurn('a', long, 'okay', { generation: 0, seq: 1 });
  assert.equal(inputs[1].userText, long);
  assert.equal(inputs[1].assistantText, 'okay');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM fame_states').get().n, 4);
});

test('compaction excludes runtime instructions and validates a structured summary before replacement', async () => {
  const requests = [];
  let output = '{"summary":"用户的手账原话：慢慢来也算前进。"}';
  const ctx = { llm: { async *stream(request) {
    requests.push(request);
    yield { type: 'text-delta', text: output };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const analysis = createAnalysis(ctx, { currentFame: () => ({}) }, {});
  const input = {
    sessionId: 'a', previousSummary: '原有约定',
    messages: [
      { role: 'system', content: 'RUNTIME INSTRUCTIONS' },
      { role: 'user', source: { kind: 'fame-memory' }, content: [{ type: 'text', text: 'RECALLED INJECTION' }] },
      { role: 'user', content: [{ type: 'text', text: '手账原话：慢慢来也算前进。' }] },
      { role: 'assistant', content: [{ type: 'text', text: '记住了。' }] },
    ],
  };
  assert.equal(await analysis.summarize(input), '用户的手账原话：慢慢来也算前进。');
  const sent = requests[0].messages[0].content[0].text;
  assert.ok(!sent.includes('RUNTIME INSTRUCTIONS'));
  assert.ok(!sent.includes('RECALLED INJECTION'));
  assert.ok(sent.includes('慢慢来也算前进'));
  assert.ok(sent.includes('原有约定'));
  output = '阿岚，我陪你继续聊。';
  await assert.rejects(analysis.summarize(input));
  output = '{"summary":""}';
  await assert.rejects(analysis.summarize(input));
});
