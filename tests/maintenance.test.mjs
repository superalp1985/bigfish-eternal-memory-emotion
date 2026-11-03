import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryStore } from '../src/memory-store.mjs';
import { createMaintenance } from '../src/maintenance.mjs';

test('saved annotations retry automatically and survive restart without resending', async t => {
  const root = mkdtempSync(join(import.meta.dirname, '.maintenance-'));
  const store = new MemoryStore(join(root, 'memory.sqlite'));
  let fail = true, attempts = 0, compactions = 0;
  const reference = { userText: 'tea', assistantText: 'remembered', reference: { generation: 0, seq: 12 } };
  const adapter = {
    async retryAnnotation(id, input) {
      assert.equal(id, 'one'); assert.deepEqual(input, reference); attempts++;
      if (fail) throw new Error('temporary outage');
    },
    async compact() { compactions++; },
  };
  let maintenance = createMaintenance(store, adapter, { interval: 10 });
  t.after(async () => { await maintenance.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  maintenance.schedule('one', { code: 'ANNOTATION_FAILED', annotation: reference, compactionError: { code: 'TIMEOUT' } });
  await assert.rejects(maintenance.ensure('one'), { code: 'MAINTENANCE_PENDING' });
  await maintenance.close();
  fail = false;
  maintenance = createMaintenance(store, adapter, { interval: 10 });
  for (let i = 0; i < 100 && maintenance.pending('one'); i++) await delay(10);
  assert.equal(maintenance.pending('one'), false);
  assert.equal(attempts, 2);
  assert.equal(compactions, 1);
});
