import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory-store.mjs';
import { evolveFame, fameAffinity } from '../src/fame.mjs';

function fixture(t) {
  const root = mkdtempSync(join(import.meta.dirname, '.memory-'));
  const store = new MemoryStore(join(root, 'memory.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

test('archive is idempotent and Chinese recall never crosses conversations', t => {
  const db = fixture(t);
  db.createSession('a', 'Conversation A');
  db.createSession('b', 'Conversation B');
  const e = { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '我喜欢茉莉花茶，不加糖。' }] } };
  db.appendEvent('a', 0, e);
  db.appendEvent('a', 0, e);
  db.appendEvent('b', 0, { ...e, data: { content: [{ type: 'text', text: '保密的茉莉花茶配方' }] } });
  assert.equal(db.stats('a').events, 1);
  assert.ok(db.recall('a', '茉莉花茶').some(x => x.text.includes('不加糖')));
  assert.ok(db.recall('a', '茉莉花茶').every(x => !x.text.includes('保密')));
});

test('conflicting repeat event is rejected without silently losing history', t => {
  const db = fixture(t);
  db.createSession('a', 'A');
  db.appendEvent('a', 0, { seq: 0, type: 'test', data: { value: 1 } });
  assert.throws(() => db.appendEvent('a', 0, { seq: 0, type: 'test', data: { value: 2 } }), /conflict/i);
  assert.equal(db.stats('a').events, 1);
});

test('working snapshot is bounded while archived history survives generation changes', t => {
  const db = fixture(t);
  db.createSession('a', 'A');
  for (let n = 0; n < 400; n++) {
    db.appendEvent('a', 0, { seq: n, type: 'user/message', data: { content: [{ type: 'text', text: `entry ${n} ` + 'x'.repeat(100) }] } });
  }
  db.checkpoint('a', { summary: 'Summary', fame: {}, recent: [], runtime: {} });
  assert.equal(db.stats('a').events, 400);
  assert.equal(db.getSession('a').generation, 1);
  assert.ok(db.context('a', 'entry', 1000).length <= 1000);
  assert.equal(db.snapshot('a').summary, 'Summary');
});

test('FAME inertia preserves state at zero dt and unknown observations stay unknown', () => {
  const prior = { mu: 0.2, chi: null };
  assert.equal(evolveFame(prior, { mu: 0.9, chi: null }, { dt: 0, tau: 1, xi: 0.7 }).mu, 0.2);
  const next = evolveFame(prior, { mu: 0.9, chi: null }, { dt: 1, tau: 1, xi: 0.7 });
  assert.ok(next.mu > 0.2 && next.mu < 0.9);
  assert.equal(next.chi, null);
});

test('replayed messages do not duplicate transcript or index and recall injections are not user facts', t => {
  const db = fixture(t);
  db.createSession('a','A');
  const msg = {seq:0,type:'user/message',data:{id:'original',source:{kind:'user'},content:[{type:'text',text:'真实的茉莉花茶偏好'}]}};
  db.appendEvent('a',0,msg);
  db.appendEvent('a',1,msg);
  db.appendEvent('a',1,{...msg,seq:1,data:{...msg.data,id:'injected',source:{kind:'fame-memory'},content:[{type:'text',text:'不能当成用户偏好的内部召回'}]}});
  assert.equal(db.transcript('a').length,1);
  assert.equal(db.recall('a','茉莉花茶').length,1);
  assert.equal(db.recall('a','内部召回').length,0);
});

test('retrieval keeps paper emotion meaning separate from engineering ranking and unknown values', t => {
  const db = fixture(t);
  db.createSession('a', 'A');
  db.recordFame('a', 'user', { mu: 0.8 });
  db.addMemory('a', { text: '项目代号青桥' });
  const first = db.recall('a', '青桥')[0];
  assert.equal(first.source.fame.user.vector.mu, 0.8);
  assert.equal(first.routing_metrics.emotion_affinity, 1);
  db.recordFame('a', 'user', { mu: 0.2 });
  assert.ok(Math.abs(db.recall('a', '青桥')[0].routing_metrics.emotion_affinity - 0.4) < 1e-10);
  db.recordFame('a', 'user', {});
  assert.equal(db.currentFame('a').user.vector.mu, null);
  assert.equal(db.recall('a', '青桥')[0].routing_metrics.emotion_affinity, null);
  assert.equal(fameAffinity({}, {}), null);
  assert.equal(db.recall('a', '完全不存在的目标').length, 0);
});

test('archive byte totals count UTF-8 bytes and upgrade old derived counters once', t => {
  const db = fixture(t);
  db.createSession('a');
  const event = { seq: 0, type: 'event', data: { text: '中'.repeat(1000) } };
  db.appendEvent('a', 0, event);
  assert.equal(db.stats('a').archiveBytes, Buffer.byteLength(JSON.stringify(event)));
  db.db.exec("DELETE FROM derived_meta WHERE name='byte-counter-v2'; UPDATE session_totals SET archive_bytes=1");
  const second = new MemoryStore(db.path);
  assert.equal(second.stats('a').archiveBytes, Buffer.byteLength(JSON.stringify(event)));
  second.close();
});

test('history and graph pagination use ordered session indexes without full-history sorting', t => {
  const db = fixture(t);
  for (const table of ['events', 'memories']) {
    const plan = db.db.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM ${table} WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT 50`).all('a', 9999);
    assert.ok(plan.some(row => row.detail.includes('INDEX')));
    assert.ok(plan.every(row => !row.detail.includes('TEMP B-TREE')), JSON.stringify(plan));
  }
});

test('long multi-part Chinese recall includes the final requested subject', t => {
  const db = fixture(t);
  db.createSession('a');
  db.addMemory('a', { text: '用户的手账第一页写着：慢慢来也算前进。' });
  const query = '我们前面聊了很多不同的事情，我想重新核对一下那些早期的约定，先不要给我建议或者马上继续其他话题，请回忆手账第一页写的那句话。';
  assert.ok(db.recall('a', query).some(row => row.text.includes('慢慢来也算前进')));
});
