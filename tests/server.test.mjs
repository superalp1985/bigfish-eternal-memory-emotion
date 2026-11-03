import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryServer } from '../src/server.mjs';
import { MemoryStore } from '../src/memory-store.mjs';

async function authenticated(app) {
  const bootstrap = await fetch(app.url + '/api/bootstrap');
  const { token } = await bootstrap.json();
  const headers = { cookie: bootstrap.headers.get('set-cookie').split(';')[0], 'x-fame-token': token, 'content-type': 'application/json' };
  return async (path, data) => {
    const response = await fetch(app.url + '/api/' + path, { headers, method: data === undefined ? 'GET' : 'POST', body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, value: await response.json() };
  };
}

test('changing storage packs and restores the same session and emotions, leaving the source intact', async t => {
  const root = mkdtempSync(join(import.meta.dirname, '.move-'));
  const source = join(root, 'old'), target = join(root, 'new'), config = join(root, 'storage.json');
  const store = new MemoryStore(join(source, 'vaults/primary/memory.sqlite'));
  store.createSession('same-session', 'remember');
  store.addMemory('same-session', { text: '无糖桂花乌龙', route: 'conversation/preferences' });
  store.recordFame('same-session', 'user', { mu: 0.8 });
  store.recordFame('same-session', 'agent', { epsilon: 0.7 });
  const app = await createMemoryServer({ root: source, store, port: 0, storageConfigPath: config });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const api = await authenticated(app);
  const before = (await api('session?id=same-session')).value;
  const moved = await api('storage', { root: target });
  assert.equal(moved.status, 200);
  assert.ok(existsSync(join(target, 'memory-transfer.fame.gz')));
  assert.ok(existsSync(join(source, 'vaults/primary/memory.sqlite')));
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).root, target);
  const after = (await api('session?id=same-session')).value;
  assert.equal(after.session.id, before.session.id);
  assert.deepEqual(after.fame, before.fame);
  assert.equal(after.stats.memories, before.stats.memories);
  assert.ok((await api('recall', { id: 'same-session', query: '桂花' })).value.length);
  const occupied = join(root, 'occupied');
  mkdirSync(occupied); writeFileSync(join(occupied, 'keep.txt'), 'keep');
  assert.equal((await api('storage', { root: occupied })).status, 400);
  assert.equal(readFileSync(join(occupied, 'keep.txt'), 'utf8'), 'keep');
});

test('portable pack is a single action and receives the active memory store', async t => {
  const root = mkdtempSync(join(import.meta.dirname, '.portable-api-'));
  let revealed;
  const app = await createMemoryServer({ root, port: 0, portableFactory: async (store, folder) => {
    assert.equal(store.listSessions().length, 1);
    return { name: 'BigFish.zip', path: join(folder, 'BigFish.zip'), bytes: 123 };
  }, reveal: path => { revealed = path; } });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const api = await authenticated(app);
  await api('sessions', { title: 'one' });
  const packed = await api('portable', {});
  assert.equal(packed.status, 200);
  assert.equal(revealed, packed.value.path);
});

test('storage switch restores the original connection even when destination cleanup fails', async t => {
  const root = mkdtempSync(join(import.meta.dirname, '.move-rollback-'));
  let factories = 0;
  const config = join(root, 'config-as-directory');
  mkdirSync(config);
  const app = await createMemoryServer({
    root: join(root, 'old'), port: 0, storageConfigPath: config,
    adapterFactory: store => {
      const version = ++factories;
      return {
        create: title => store.createSession(undefined, title),
        async close() { if (version === 2) throw new Error('destination cleanup failure'); },
      };
    },
  });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const api = await authenticated(app);
  const original = (await api('sessions', { title: 'original' })).value;
  const moved = await api('storage', { root: join(root, 'new') });
  assert.equal(moved.status, 400);
  assert.match(moved.value.error, /destination cleanup failure/);
  assert.equal(factories, 3);
  assert.equal((await api('session?id=' + original.id)).status, 200);
  assert.equal((await api('sessions', { title: 'still connected' })).status, 200);
  assert.equal((await api('bootstrap')).value.root, join(root, 'old'));
});

test('local management API rejects untrusted origins and unsafe paths', async t => {
  const root = mkdtempSync(join(import.meta.dirname, '.server-'));
  const app = await createMemoryServer({ root, port: 0 });
  t.after(async () => { await app.close(); rmSync(root, { force: true, recursive: true }); });
  const base = app.url;
  const bootstrap = await fetch(base + '/api/bootstrap');
  const auth = await bootstrap.json();
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  let r = await fetch(base + '/api/sessions', { method: 'POST', headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: '{"title":"bad"}' });
  assert.equal(r.status, 403);
  r = await fetch(base + '/api/sessions', { method: 'POST', headers: { cookie, 'x-fame-token': auth.token, 'content-type': 'application/json' }, body: '{"title":"测试"}' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).title, '测试');
  r = await fetch(base + '/api/download?name=../../secret', { headers: { cookie } });
  assert.notEqual(r.status, 200);
});

test('rollback still restores the old adapter when new-adapter cleanup also throws', async t => {
  const root = mkdtempSync(join(import.meta.dirname, '.server-'));
  let factories = 0;
  const app = await createMemoryServer({ root, port: 0, adapterFactory: store => {
    const generation = ++factories;
    return {
      create: title => store.createSession(undefined, title),
      close: async () => { if (generation === 2) throw new Error('cleanup failure'); },
    };
  } });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const bootstrap = await fetch(app.url + '/api/bootstrap');
  const { token } = await bootstrap.json();
  const headers = { cookie: bootstrap.headers.get('set-cookie').split(';')[0], 'x-fame-token': token, 'content-type': 'application/json' };
  await fetch(app.url + '/api/sessions', { method: 'POST', headers, body: '{"title":"original"}' });
  const exported = await (await fetch(app.url + '/api/backup', { method: 'POST', headers, body: '{}' })).json();
  const bytes = await (await fetch(app.url + '/api/download?name=' + exported.name, { headers })).arrayBuffer();
  mkdirSync(join(root, 'active-vault.json.tmp'));
  const response = await fetch(app.url + '/api/import', { method: 'POST', headers, body: bytes });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cleanup failure/);
  assert.equal(factories, 3);
  const state = await (await fetch(app.url + '/api/bootstrap')).json();
  assert.equal(state.vault, 'primary');
  assert.equal(state.connected, true);
  assert.equal((await fetch(app.url + '/api/sessions', { method: 'POST', headers, body: '{"title":"recovered"}' })).status, 200);
});

test('failed imported adapter activation restores the original vault and connection', async t => {
  const root = mkdtempSync(join(import.meta.dirname, '.server-'));
  let factories = 0, disposed = 0;
  const app = await createMemoryServer({
    root, port: 0,
    adapterFactory: store => {
      if (++factories === 2) throw new Error('Simulated imported backend failure');
      return {
        create: title => store.createSession(undefined, title),
        close: async () => { disposed++; },
      };
    },
  });
  t.after(async () => { await app.close(); rmSync(root, { force: true, recursive: true }); });
  const bootstrap = await fetch(app.url + '/api/bootstrap');
  const { token } = await bootstrap.json();
  const headers = { cookie: bootstrap.headers.get('set-cookie').split(';')[0], 'x-fame-token': token, 'content-type': 'application/json' };
  const created = await (await fetch(app.url + '/api/sessions', { method: 'POST', headers, body: '{"title":"original"}' })).json();
  const exported = await (await fetch(app.url + '/api/backup', { method: 'POST', headers, body: '{}' })).json();
  const bytes = await (await fetch(app.url + '/api/download?name=' + exported.name, { headers })).arrayBuffer();
  const failed = await fetch(app.url + '/api/import', { method: 'POST', headers, body: bytes });
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /Simulated imported backend failure/);
  assert.equal(factories, 3);
  assert.equal(disposed, 1);
  const state = await (await fetch(app.url + '/api/bootstrap')).json();
  assert.equal(state.vault, 'primary');
  assert.equal(state.connected, true);
  const sessions = await (await fetch(app.url + '/api/sessions', { headers })).json();
  assert.equal(sessions[0].id, created.id);
  assert.equal((await fetch(app.url + '/api/sessions', { method: 'POST', headers, body: '{"title":"after rollback"}' })).status, 200);
});
