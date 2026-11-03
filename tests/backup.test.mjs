import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { MemoryStore } from '../src/memory-store.mjs';

let backup;
try {
  backup = await import('../src/backup.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' ||
      error.url !== new URL('../src/backup.mjs', import.meta.url).href) throw error;
}

function api() {
  assert.equal(typeof backup?.exportVault, 'function', 'exportVault must be implemented');
  assert.equal(typeof backup?.importVault, 'function', 'importVault must be implemented');
  return backup;
}

function fixture(t) {
  const scratch = resolve(import.meta.dirname, '../work');
  const root = mkdtempSync(join(scratch, '.backup-test-'));
  const store = new MemoryStore(join(root, 'current.sqlite'));
  const parent = join(root, 'vaults');
  mkdirSync(parent);
  t.after(() => {
    store.close();
    const target = resolve(root);
    assert.ok(target.startsWith(`${scratch}${sep}.backup-test-`));
    rmSync(target, { recursive: true, force: true });
  });
  return { root, store, parent, archive: join(root, 'memory.fame.gz') };
}

function populate(store) {
  store.createSession('tea', '茶与长期记忆', {
    provider: 'deepseek', model: 'deepseek-chat', apiKey: 'TEST-ONLY-SECRET',
    cwd: 'Z:\\private-machine\\workspace', endpoint: 'http://private-machine',
    nested: { password: 'TEST-ONLY-PASSWORD' },
  });
  store.createSession('other', '另一个会话');
  store.appendEvent('tea', 0, {
    seq: 0, type: 'user/message',
    data: { content: [{ type: 'text', text: '我喜欢茉莉花茶，不加糖。' }] },
  });
  store.appendEvent('other', 0, {
    seq: 0, type: 'assistant/message',
    data: { content: [{ type: 'text', text: '另一个会话的茉莉花茶配方。' }] },
  });
  const left = store.addMemory('tea', { text: '中文索引需要重建', route: 'preferences/drink' });
  const right = store.addMemory('tea', { text: '保持长期记忆与来源' });
  store.db.prepare('INSERT INTO edges VALUES(?,?,?,?,?)')
    .run('edge-1', 'tea', left.id, right.id, 'supports');
  store.recordFame('tea', 'user', { mu: 0.8, chi: 0.2 }, {
    evidence: [{ generation: 0, seq: 0 }], confidence: 0.9,
  });
  store.recordFame('tea', 'agent', { rho: 0.6 });
  store.checkpoint('tea', { summary: '饮茶偏好：不加糖', fame: {}, recent: [], runtime: {} });
  store.appendEvent('tea', 1, { seq: 0, type: 'test', data: { value: '新一代' } });
}

function records(path) {
  return gunzipSync(readFileSync(path)).toString('utf8').trimEnd().split('\n').map(JSON.parse);
}

function writeRecords(path, data, { reseal = true } = {}) {
  const copy = structuredClone(data);
  if (reseal && copy.at(-1)?.type === 'footer') {
    const body = copy.slice(0, -1);
    const counts = { sessions: 0, events: 0, memories: 0, edges: 0, fame_states: 0, checkpoints: 0 };
    let count = 0;
    for (const record of body) {
      if (record.type !== 'row') continue;
      count++;
      if (Object.hasOwn(counts, record.table)) counts[record.table]++;
    }
    copy.at(-1).counts = counts;
    copy.at(-1).records = count;
    copy.at(-1).sha256 = createHash('sha256')
      .update(body.map(record => `${JSON.stringify(record)}\n`).join('')).digest('hex');
  }
  writeFileSync(path, gzipSync(copy.map(record => `${JSON.stringify(record)}\n`).join('')));
}

async function rejectedImport(t, mutate) {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  await exportVault(f.store, f.archive);
  const data = records(f.archive);
  mutate(data);
  writeRecords(f.archive, data);
  await assert.rejects(importVault(f.archive, f.parent));
  assert.deepEqual(readdirSync(f.parent), [], 'failed import must remove its temporary vault');
  assert.equal(f.store.stats('tea').events, 2);
}

test('roundtrip preserves Chinese history, multiple sessions, FAME, edges and searchable memory', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  const expectedFame = f.store.currentFame('tea');
  await exportVault(f.store, f.archive);
  const result = await importVault(f.archive, f.parent);
  assert.equal(result.sessions, 2);
  assert.notEqual(result.path, f.store.path);
  assert.equal(resolve(result.root), resolve(result.path, '..'));
  assert.ok(resolve(result.root).startsWith(`${resolve(f.parent)}${sep}`));
  const restored = new MemoryStore(result.path);
  try {
    assert.equal(restored.stats('tea').events, 2);
    assert.equal(restored.stats('other').events, 1);
    assert.equal(restored.snapshot('tea').summary, '饮茶偏好：不加糖');
    assert.deepEqual(restored.currentFame('tea'), expectedFame);
    assert.equal(restored.db.prepare('SELECT count(*) AS n FROM edges').get().n, 1);
    assert.ok(restored.recall('tea', '茉莉花茶').some(row => row.text.includes('不加糖')));
    assert.ok(restored.recall('tea', '茉莉花茶').every(row => !row.text.includes('配方')));
    assert.deepEqual(restored.getSession('tea').options, {});
  } finally { restored.close(); }
  assert.deepEqual(readdirSync(f.parent), [result.root.slice(f.parent.length + 1)]);
});

test('portable export excludes configuration and extra database tables without changing the source', async t => {
  const { exportVault } = api();
  const f = fixture(t);
  populate(f.store);
  f.store.db.exec("CREATE TABLE machine_secrets(value TEXT); INSERT INTO machine_secrets VALUES('OTHER-TEST-SECRET')");
  await exportVault(f.store, f.archive);
  const plain = gunzipSync(readFileSync(f.archive)).toString('utf8');
  for (const secret of ['TEST-ONLY-SECRET', 'TEST-ONLY-PASSWORD', 'private-machine', 'OTHER-TEST-SECRET', f.store.path]) {
    assert.ok(!plain.includes(secret), 'configuration must not enter the portable archive');
  }
  assert.equal(f.store.getSession('tea').options.apiKey, 'TEST-ONLY-SECRET');
});

test('provider and model identifiers can be retained explicitly without their connection settings', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  await exportVault(f.store, f.archive, { preserveModel: true });
  const result = await importVault(f.archive, f.parent);
  const restored = new MemoryStore(result.path);
  try {
    assert.deepEqual(restored.getSession('tea').options, { provider: 'deepseek', model: 'deepseek-chat' });
  } finally { restored.close(); }
});

test('import strips hidden configuration even when an archive has a valid checksum', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  await exportVault(f.store, f.archive);
  const data = records(f.archive);
  data.find(record => record.table === 'sessions').row.options = JSON.stringify({
    apiKey: 'INJECTED-TEST-SECRET', cwd: 'Z:\\machine', provider: 'Z:\\machine', model: 'deepseek-chat',
  });
  writeRecords(f.archive, data);
  const result = await importVault(f.archive, f.parent);
  const restored = new MemoryStore(result.path);
  try { assert.deepEqual(restored.getSession('tea').options, { model: 'deepseek-chat' }); }
  finally { restored.close(); }
});

test('an empty archive imports successfully and every import creates a distinct vault', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  await exportVault(f.store, f.archive);
  const first = await importVault(f.archive, f.parent);
  const second = await importVault(f.archive, f.parent);
  assert.equal(first.sessions, 0);
  assert.equal(second.sessions, 0);
  assert.notEqual(first.root, second.root);
  assert.equal(readdirSync(f.parent).length, 2);
});

test('export never replaces an existing destination', async t => {
  const { exportVault } = api();
  const f = fixture(t);
  writeFileSync(f.archive, 'existing archive');
  await assert.rejects(exportVault(f.store, f.archive));
  assert.equal(readFileSync(f.archive, 'utf8'), 'existing archive');
  assert.ok(!readdirSync(f.root).some(name => name.startsWith('.fame-export-')));
});

test('export pins an independent snapshot while the live store continues committing writes', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  const pending = exportVault(f.store, f.archive);
  f.store.appendEvent('tea', 1, { seq: 1, type: 'test', data: { value: 'after snapshot' } });
  f.store.createSession('later', 'created after export began');
  await pending;
  const result = await importVault(f.archive, f.parent);
  const restored = new MemoryStore(result.path);
  try {
    assert.equal(result.sessions, 2);
    assert.equal(restored.stats('tea').events, 2);
    assert.equal(f.store.stats('tea').events, 3);
    assert.equal(f.store.db.isTransaction, false);
  } finally { restored.close(); }
});

test('streaming export and import yield while handling a vault larger than stream buffers', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  f.store.createSession('large');
  f.store.transaction(() => {
    const insert = f.store.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?)');
    for (let n = 0; n < 1800; n++) {
      insert.run(`memory-${n}`, 'large', 'facts', `中文事实 ${n} ${'text '.repeat(400)}`, '{}', 0.5, '2026-11-03T00:00:00.000Z');
    }
  });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  t.after(() => clearInterval(timer));
  await exportVault(f.store, f.archive);
  const afterExport = ticks;
  const result = await importVault(f.archive, f.parent);
  assert.ok(afterExport > 0, 'export must yield for streaming backpressure');
  assert.ok(ticks > afterExport, 'import must yield between batches');
  const restored = new MemoryStore(result.path);
  try {
    assert.equal(restored.db.prepare('SELECT count(*) AS n FROM memories').get().n, 1800);
    assert.ok(restored.recall('large', '中文事实').length > 0);
  } finally { restored.close(); }
});

test('changed archive content is rejected even when gzip itself is valid', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  await exportVault(f.store, f.archive);
  const data = records(f.archive);
  data.find(record => record.table === 'sessions').row.title = 'tampered';
  writeRecords(f.archive, data, { reseal: false });
  await assert.rejects(importVault(f.archive, f.parent), /hash|checksum|integrity/i);
  assert.deepEqual(readdirSync(f.parent), []);
});

test('compressed truncation and missing footer both reject without leaving a vault', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  await exportVault(f.store, f.archive);
  const original = readFileSync(f.archive);
  const data = records(f.archive);
  writeFileSync(f.archive, original.subarray(0, original.length - 8));
  await assert.rejects(importVault(f.archive, f.parent));
  assert.deepEqual(readdirSync(f.parent), []);
  writeRecords(f.archive, data.slice(0, -1), { reseal: false });
  await assert.rejects(importVault(f.archive, f.parent), /footer|truncat|incomplete/i);
  assert.deepEqual(readdirSync(f.parent), []);
});

test('footer count mismatches and records after the footer are rejected', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  await exportVault(f.store, f.archive);
  const data = records(f.archive);
  const badCount = structuredClone(data);
  badCount.at(-1).counts.sessions++;
  writeRecords(f.archive, badCount, { reseal: false });
  await assert.rejects(importVault(f.archive, f.parent), /count/i);
  assert.deepEqual(readdirSync(f.parent), []);
  writeRecords(f.archive, [...data, data[1]], { reseal: false });
  await assert.rejects(importVault(f.archive, f.parent), /footer|trailing/i);
  assert.deepEqual(readdirSync(f.parent), []);
});

test('unsupported format versions are rejected', async t => {
  await rejectedImport(t, data => { data[0].version = 999; });
});

test('illegal table names never become executable SQL', async t => {
  await rejectedImport(t, data => { data[1].table = 'sessions; DROP TABLE sessions;--'; });
});

test('unrecognized columns and schema metadata are rejected', async t => {
  await rejectedImport(t, data => { data[1].row.machine_path = 'Z:\\machine'; });
});

test('invalid session foreign keys are rejected before publication', async t => {
  await rejectedImport(t, data => {
    data.find(record => record.table === 'memories').row.session_id = 'absent';
  });
});

test('an active generation without a corresponding checkpoint is rejected', async t => {
  await rejectedImport(t, data => {
    data.find(record => record.table === 'sessions' && record.row.id === 'tea').row.generation = 99;
  });
});

test('duplicate primary keys are rejected', async t => {
  await rejectedImport(t, data => { data.splice(2, 0, structuredClone(data[1])); });
});

test('event hashes are verified independently of the outer archive checksum', async t => {
  await rejectedImport(t, data => { data.find(record => record.table === 'events').row.sha = '0'.repeat(64); });
});

test('checkpoint hashes are verified independently of the outer archive checksum', async t => {
  await rejectedImport(t, data => { data.find(record => record.table === 'checkpoints').row.sha = '0'.repeat(64); });
});

test('FAME values outside the declared range are rejected', async t => {
  await rejectedImport(t, data => {
    const row = data.find(record => record.table === 'fame_states').row;
    row.vector = JSON.stringify({ ...JSON.parse(row.vector), mu: 2 });
  });
});

test('oversized decompressed records are rejected before JSON materialization', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  await exportVault(f.store, f.archive);
  const header = records(f.archive)[0];
  writeFileSync(f.archive, gzipSync(`${JSON.stringify(header)}\n${'x'.repeat(8 * 1024 * 1024 + 1)}\n`));
  await assert.rejects(importVault(f.archive, f.parent), /large|limit|size/i);
  assert.deepEqual(readdirSync(f.parent), []);
});

test('oversized source records fail export without publishing or leaving temporary files', async t => {
  const { exportVault } = api();
  const f = fixture(t);
  f.store.createSession('large');
  f.store.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?)')
    .run('huge', 'large', 'facts', 'x'.repeat(8 * 1024 * 1024 + 1), '{}', 0.5, '2026-11-03');
  await assert.rejects(exportVault(f.store, f.archive), /large|limit|size/i);
  assert.ok(!readdirSync(f.root).some(name => name === 'memory.fame.gz' || name.startsWith('.fame-export-')));
});

test('incompatible source schemas fail without publishing an archive', async t => {
  const { exportVault } = api();
  const f = fixture(t);
  f.store.db.exec('ALTER TABLE memories ADD COLUMN unknown_field TEXT');
  await assert.rejects(exportVault(f.store, f.archive), /schema|column/i);
  assert.ok(!readdirSync(f.root).some(name => name === 'memory.fame.gz' || name.startsWith('.fame-export-')));
});

test('index rebuild failures never publish the imported database', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  await exportVault(f.store, f.archive);
  t.mock.method(MemoryStore.prototype, 'rebuildIndex', function () {
    throw new Error('simulated index storage failure');
  });
  await assert.rejects(importVault(f.archive, f.parent), /index storage failure/);
  assert.deepEqual(readdirSync(f.parent), []);
  assert.equal(f.store.stats('tea').events, 2);
});

test('concurrent exports publish exactly one complete destination without leftover snapshots', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  const results = await Promise.allSettled([
    exportVault(f.store, f.archive), exportVault(f.store, f.archive),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await importVault(f.archive, f.parent)).sessions, 2);
  assert.ok(!readdirSync(f.root).some(name => name.startsWith('.fame-export-')));
});

test('a missing archive cleans the provisional vault and leaves existing vaults untouched', async t => {
  const { importVault } = api();
  const f = fixture(t);
  const existing = join(f.parent, 'existing');
  mkdirSync(existing);
  writeFileSync(join(existing, 'keep.txt'), 'keep');
  await assert.rejects(importVault(join(f.root, 'missing.fame.gz'), f.parent), /ENOENT/);
  assert.deepEqual(readdirSync(f.parent), ['existing']);
  assert.equal(readFileSync(join(existing, 'keep.txt'), 'utf8'), 'keep');
});

test('default restore preserves adapter ownership and safe nested agent options', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  const options = {
    owner: 'fame-dsh-memory/v1', cwd: 'Z:\\private-machine\\workspace',
    apiKey: 'OWNER-TEST-SECRET',
    agentOptions: {
      provider: 'deepseek-official', model: 'deepseek-flash',
      maxTokens: 4096, reasoningEffort: 'high',
      apiKey: 'AGENT-TEST-SECRET', baseURL: 'http://private-machine', cwd: 'Z:\\machine',
    },
  };
  f.store.createSession('owned', '可继续的对话', options);
  await exportVault(f.store, f.archive);
  const result = await importVault(f.archive, f.parent);
  const restored = new MemoryStore(result.path);
  try {
    assert.deepEqual(restored.getSession('owned').options, {
      owner: 'fame-dsh-memory/v1',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096, reasoningEffort: 'high' },
    });
    restored.appendEvent('owned', 0, { seq: 0, type: 'test', data: { value: 'continued' } });
    assert.equal(restored.stats('owned').events, 1);
  } finally { restored.close(); }
  const plain = gunzipSync(readFileSync(f.archive)).toString('utf8');
  for (const value of ['OWNER-TEST-SECRET', 'AGENT-TEST-SECRET', 'private-machine']) {
    assert.ok(!plain.includes(value));
  }
});

test('checkpoint runtime options are sanitized and rehashed without changing memory or the source', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  f.store.createSession('owned', 'Checkpoint', { owner: 'fame-dsh-memory/v1' });
  const snapshot = {
    summary: '保留中文摘要', recent: [], fame: {},
    runtime: {
      format: 'test-format', parentGeneration: 0, origins: {}, seed: [{ seq: 0, type: 'test' }],
      options: {
        owner: 'fame-dsh-memory/v1', cwd: 'Z:\\CHECKPOINT-MACHINE',
        agentOptions: { model: 'deepseek-flash', maxTokens: 4096, apiKey: 'CHECKPOINT-TEST-SECRET' },
      },
    },
  };
  f.store.checkpoint('owned', snapshot);
  await exportVault(f.store, f.archive);
  const plain = gunzipSync(readFileSync(f.archive)).toString('utf8');
  assert.ok(!plain.includes('CHECKPOINT-MACHINE'));
  assert.ok(!plain.includes('CHECKPOINT-TEST-SECRET'));
  const result = await importVault(f.archive, f.parent);
  const restored = new MemoryStore(result.path);
  try {
    const actual = restored.snapshot('owned');
    assert.deepEqual(actual.runtime.options, {
      owner: 'fame-dsh-memory/v1', agentOptions: { model: 'deepseek-flash', maxTokens: 4096 },
    });
    assert.deepEqual(actual.runtime.seed, snapshot.runtime.seed);
    assert.equal(actual.summary, snapshot.summary);
    assert.deepEqual(f.store.snapshot('owned'), snapshot);
  } finally { restored.close(); }
});

test('import sanitizes correctly hashed checkpoint configuration from an external backup', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  await exportVault(f.store, f.archive);
  const data = records(f.archive);
  const row = data.find(record => record.table === 'checkpoints').row;
  const snapshot = JSON.parse(row.json);
  snapshot.runtime.options = {
    owner: 'unrecognized-owner', cwd: 'Z:\\injected', apiKey: 'INJECTED-CHECKPOINT-TEST-SECRET',
    agentOptions: { model: 'deepseek-chat', maxTokens: -1, reasoningEffort: 'Z:\\machine', cwd: 'Z:\\machine' },
  };
  row.json = JSON.stringify(snapshot);
  row.sha = createHash('sha256').update(row.json).digest('hex');
  writeRecords(f.archive, data);
  const result = await importVault(f.archive, f.parent);
  const restored = new MemoryStore(result.path);
  try {
    assert.deepEqual(restored.snapshot('tea').runtime.options, { agentOptions: { model: 'deepseek-chat' } });
  } finally { restored.close(); }
});

test('derived session totals are rebuilt by insert triggers and never exported', async t => {
  const { exportVault, importVault } = api();
  const f = fixture(t);
  populate(f.store);
  const expectedBytes = f.store.stats('tea').archiveBytes;
  f.store.db.exec("UPDATE session_totals SET events=900,memories=900,archive_bytes=900 WHERE session_id='tea'");
  await exportVault(f.store, f.archive);
  assert.ok(records(f.archive).every(record => record.table !== 'session_totals'));
  const result = await importVault(f.archive, f.parent);
  const restored = new MemoryStore(result.path);
  try {
    const stats = restored.stats('tea');
    assert.equal(stats.events, 2);
    assert.equal(stats.memories, 3);
    assert.equal(stats.archiveBytes, expectedBytes);
  } finally { restored.close(); }
});
