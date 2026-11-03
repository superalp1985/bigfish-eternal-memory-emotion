import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory-store.mjs';
import { createOverlay, writeOverlay } from '../src/knowledge-overlay.mjs';

function fixture(t) {
  const root = mkdtempSync(join(import.meta.dirname, '.overlay-'));
  const store = new MemoryStore(join(root, 'memory.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.createSession('a', 'A'); store.createSession('b', 'B');
  return { store, root };
}

test('nodes, edges and routes keep paper semantics, actor separation and source references', t => {
  const { store, root } = fixture(t);
  store.recordFame('a', 'user', { mu: 0.2, nu: 0.9 });
  store.recordFame('a', 'agent', { mu: 0.8, nu: 0.1 });
  store.addMemory('a', { text: '青桥项目', importance: 0.7, source: { generation: 0, seq: 2 } });
  store.addMemory('b', { text: 'Other private conversation' });
  const overlay = createOverlay(store, 'a');
  const node = overlay.nodes.find(n => n.type === 'ConversationMemory');
  assert.equal(node.fame.mu, 0.5);
  assert.equal(node.fame_participants.user.vector.nu, 0.9);
  assert.equal(node.fame_participants.agent.vector.nu, 0.1);
  assert.equal(node.fame.rho, null);
  assert.equal(node.routing_metrics.importance, 0.7);
  assert.equal(overlay.routes[0].fame.mu, 0.5);
  assert.equal(overlay.edges[0].fame.mu, 0.5);
  assert.deepEqual(node.source_refs, [{ type: 'conversation_event', session_id: 'a', generation: 0, seq: 2 }]);
  assert.ok(!JSON.stringify(overlay).includes('Other private'));
  assert.equal(overlay.manifest.legacy_fame_compatible, false);
  writeOverlay(store, 'a', join(root, 'export'));
  assert.equal(JSON.parse(readFileSync(join(root, 'export/project_manifest.json'))).fame_schema, 'FAME-Theory/8D');
  assert.throws(() => writeOverlay(store, 'a', join(root, 'export')), /exist/i);
});

test('graph pages are bounded, stable and do not convert legacy engineering vectors', t => {
  const { store } = fixture(t);
  for (let i = 0; i < 11; i++) store.addMemory('a', { text: `memory ${i}` });
  const first = createOverlay(store, 'a', { limit: 5 });
  assert.equal(first.pagination.memory_count, 5);
  assert.equal(first.pagination.has_more, true);
  const second = createOverlay(store, 'a', { limit: 5, after: first.pagination.next });
  const firstIds = new Set(first.nodes.filter(x => x.memory_id).map(x => x.id));
  assert.ok(second.nodes.filter(x => x.memory_id).every(x => !firstIds.has(x.id)));
  const last = createOverlay(store, 'a', { limit: 5, after: second.pagination.next });
  assert.equal(last.pagination.memory_count, 1);
  assert.equal(last.pagination.has_more, false);
  assert.throws(() => createOverlay(store, 'a', { limit: 10000 }), /Invalid/);
  store.db.prepare('UPDATE memories SET source=? WHERE session_id=?').run(JSON.stringify({
    fame_schema: 'legacy-engineering', fame: { user: { vector: { mu: 0.9 } } },
  }), 'a');
  assert.equal(createOverlay(store, 'a').nodes.find(x => x.memory_id).fame.mu, null);
});
