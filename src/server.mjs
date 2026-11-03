import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, basename, dirname, isAbsolute } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { MemoryStore } from './memory-store.mjs';
import { exportVault, importVault } from './backup.mjs';
import { createOverlay } from './knowledge-overlay.mjs';
import { createPortable, chooseStorage, revealFile } from './portable.mjs';
import { createMaintenance } from './maintenance.mjs';

const publicRoot = resolve(import.meta.dirname, '../public');
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
function same(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
async function body(req, max = 256 * 1024) {
  const chunks = []; let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > max) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function createMemoryServer({ root, port = 5196, adapterFactory, store: suppliedStore, maxUploadBytes = Infinity,
  storageConfigPath = resolve(import.meta.dirname, '../runtime/storage.json'), portableFactory = createPortable, folderPicker = chooseStorage, reveal = revealFile,
} = {}) {
  root = resolve(root ?? process.env.FAME_MEMORY_HOME ?? 'E:/FAME-DSH-Memory/data');
  mkdirSync(root, { recursive: true });
  let backupRoot = join(root, 'backups');
  let uploadRoot = join(root, 'uploads');
  let vaultRoot = join(root, 'vaults');
  for (const p of [backupRoot, uploadRoot, vaultRoot]) mkdirSync(p, { recursive: true });
  let pointerPath = join(root, 'active-vault.json');
  let vaultName = existsSync(pointerPath) ? JSON.parse(readFileSync(pointerPath, 'utf8')).name : 'primary';
  if (!/^[a-zA-Z0-9_-]+$/.test(vaultName)) throw new Error('Invalid active vault pointer');
  let store = suppliedStore ?? new MemoryStore(join(vaultRoot, vaultName, 'memory.sqlite'));
  let adapter = adapterFactory ? await adapterFactory(store) : null;
  let maintenance = createMaintenance(store, adapter);
  let switching = false;
  let activeRequests = 0;
  const token = randomBytes(32).toString('hex');
  const cookie = randomBytes(32).toString('hex');
  let url;
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    let tracked = false;
    try {
      if (req.headers.host !== new URL(url).host) return json(res, 403, { error: 'Invalid host' });
      if (req.headers.origin && req.headers.origin !== url) return json(res, 403, { error: 'Invalid origin' });
      const u = new URL(req.url, url);
      if (u.pathname === '/api/bootstrap' && req.method === 'GET') {
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Invalid site' });
        res.setHeader('set-cookie', `fame_session=${cookie}; HttpOnly; SameSite=Strict; Path=/`);
        return json(res, 200, { token, connected: !!adapter, vault: vaultName, root, backend: 'DSH 0.2.1-rc.2', product: 'BigFish Eternal Memory & Emotion', project: resolve(import.meta.dirname, '..') });
      }
      if (!u.pathname.startsWith('/api/')) {
        const routes = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/icon.svg': 'icon.svg', '/bigfish.webp': 'bigfish.webp' };
        const file = routes[u.pathname];
        if (!file || req.method !== 'GET') return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.webp') ? 'image/webp' : 'text/javascript' });
        return createReadStream(join(publicRoot, file)).pipe(res);
      }
      const suppliedCookie = /(?:^|;\s*)fame_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (!same(suppliedCookie, cookie)) return json(res, 403, { error: 'Open the local memory panel first' });
      if (req.method !== 'GET' && !same(req.headers['x-fame-token'], token)) return json(res, 403, { error: 'Invalid request token' });
      if (switching) return json(res, 409, { error: 'Vault switch in progress' });
      activeRequests++; tracked = true;
      if (u.pathname === '/api/sessions' && req.method === 'GET') return json(res, 200, store.listSessions());
      if (u.pathname === '/api/sessions' && req.method === 'POST') {
        const input = await body(req);
        return json(res, 200, adapter ? await adapter.create(input.title || '新对话') : store.createSession(undefined, input.title || '新对话'));
      }
      if (u.pathname === '/api/session' && req.method === 'GET') {
        const id = u.searchParams.get('id');
        return json(res, 200, {
          session: store.getSession(id), stats: store.stats(id), fame: store.currentFame(id),
          transcript: store.transcript(id, Number(u.searchParams.get('before')) || Number.MAX_SAFE_INTEGER),
          snapshot: store.snapshot(id), maintaining: maintenance.pending(id),
        });
      }
      if (u.pathname === '/api/send' && req.method === 'POST') {
        if (!adapter) return json(res, 503, { error: 'DSH 未连接。请使用 DSH 记忆插件启动器。' });
        const input = await body(req);
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32000) throw new Error('消息须为 1–32000 字符');
        await maintenance.ensure(input.id);
        try {
          const reply = await adapter.send(input.id, input.text);
          return json(res, 200, { reply });
        } catch (error) {
          if (!error.saved || !['ANNOTATION_FAILED', 'COMPACTION_FAILED'].includes(error.code)) throw error;
          console.error('BigFish deferred maintenance:', error.code, error.cause?.message ?? '');
          maintenance.schedule(input.id, error);
          return json(res, 200, { reply: error.assistantText, maintaining: true });
        }
      }
      if (u.pathname === '/api/compact' && req.method === 'POST') {
        if (!adapter) return json(res, 503, { error: 'DSH 未连接' });
        const input = await body(req);
        return json(res, 200, await adapter.compact(input.id));
      }
      if (u.pathname === '/api/retry-annotation' && req.method === 'POST') {
        if (!adapter) return json(res, 503, { error: 'DSH 未连接' });
        const input = await body(req);
        return json(res, 200, await adapter.retryAnnotation(input.id));
      }
      if (u.pathname === '/api/recall' && req.method === 'POST') {
        const input = await body(req);
        return json(res, 200, store.recall(input.id, input.query));
      }
      if (['/api/graph', '/api/graph-export'].includes(u.pathname) && req.method === 'GET') {
        const overlay = createOverlay(store, u.searchParams.get('id'), {
          after: Number(u.searchParams.get('after') || 0), limit: 200,
          ...(u.searchParams.has('route') ? { route: u.searchParams.get('route') } : {}),
        });
        if (u.pathname === '/api/graph-export') res.setHeader('content-disposition', `attachment; filename="${overlay.manifest.project_id}-${overlay.pagination.after}.json"`);
        return json(res, 200, overlay);
      }
      if (u.pathname === '/api/fame' && req.method === 'POST') {
        const input = await body(req);
        return json(res, 200, store.recordFame(input.id, input.actor, input.vector, {
          method: 'user-defined', evidence: ['manual panel correction'], confidence: 1, xi: 0, dt: 1, tau: 0.001,
        }));
      }
      if (u.pathname === '/api/backups' && req.method === 'GET') {
        return json(res, 200, readdirSync(backupRoot).filter(x => x.endsWith('.fame.gz')).map(name => {
          const s = statSync(join(backupRoot, name));
          return { name, size: s.size, createdAt: s.mtime.toISOString() };
        }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      }
      if (u.pathname === '/api/backup' && req.method === 'POST') {
        const name = `fame-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.fame.gz`;
        await exportVault(store, join(backupRoot, name));
        return json(res, 200, { name });
      }
      if (u.pathname === '/api/portable' && req.method === 'POST') {
        if (activeRequests !== 1) return json(res, 409, { error: '请等待当前对话完成' });
        switching = true;
        try {
          for (const session of store.listSessions()) await maintenance.ensure(session.id);
          await maintenance.pause();
          const bundle = await portableFactory(store, join(root, 'transfers'));
          reveal?.(bundle.path);
          return json(res, 200, bundle);
        } finally { maintenance.resume(); switching = false; }
      }
      if (u.pathname === '/api/storage' && req.method === 'POST') {
        if (activeRequests !== 1) return json(res, 409, { error: '请等待当前对话完成' });
        switching = true;
        let nextStore, nextAdapter, previousClosed = false;
        try {
          const input = await body(req);
          const chosen = input.root ?? await folderPicker(root);
          if (!chosen) return json(res, 200, { cancelled: true });
          if (!isAbsolute(chosen)) throw new Error('请选择完整的保存位置');
          const target = resolve(chosen);
          if (target.toLowerCase() === root.toLowerCase()) return json(res, 200, { root, unchanged: true });
          if (existsSync(target) && readdirSync(target).length) throw new Error('请选择空文件夹，已有记忆会保留');
          for (const session of store.listSessions()) await maintenance.ensure(session.id);
          await maintenance.pause();
          mkdirSync(target, { recursive: true });
          const pack = join(target, 'memory-transfer.fame.gz');
          await exportVault(store, pack);
          const imported = await importVault(pack, join(target, 'vaults'));
          nextStore = new MemoryStore(imported.path);
          const nextName = basename(imported.root);
          for (const folder of ['backups', 'uploads']) mkdirSync(join(target, folder), { recursive: true });
          writeFileSync(join(target, 'active-vault.json'), JSON.stringify({ name: nextName }), { flush: true });
          previousClosed = true;
          await adapter?.close();
          nextAdapter = adapterFactory ? await adapterFactory(nextStore) : null;
          mkdirSync(dirname(storageConfigPath), { recursive: true });
          writeFileSync(storageConfigPath + '.tmp', JSON.stringify({ root: target }), { flush: true });
          renameSync(storageConfigPath + '.tmp', storageConfigPath);
          await maintenance.close();
          const previous = store;
          store = nextStore; adapter = nextAdapter;
          nextStore = null; nextAdapter = null; previousClosed = false;
          root = target; vaultName = nextName;
          backupRoot = join(root, 'backups'); uploadRoot = join(root, 'uploads');
          vaultRoot = join(root, 'vaults'); pointerPath = join(root, 'active-vault.json');
          maintenance = createMaintenance(store, adapter);
          previous.close();
          return json(res, 200, { root, sessions: imported.sessions, pack });
        } catch (error) {
          const failures = [error];
          try { await nextAdapter?.close(); } catch (cleanupError) { failures.push(cleanupError); }
          try { nextStore?.close(); } catch (cleanupError) { failures.push(cleanupError); }
          if (previousClosed) {
            adapter = null;
            try { adapter = adapterFactory ? await adapterFactory(store) : null; }
            catch (recoveryError) { failures.push(recoveryError); }
            await maintenance.close();
            maintenance = createMaintenance(store, adapter);
          }
          throw failures.length > 1 ? new Error(failures.map(failure => failure.message).join('; ')) : error;
        } finally { maintenance.resume(); switching = false; }
      }
      if (u.pathname === '/api/download' && req.method === 'GET') {
        const name = u.searchParams.get('name') ?? '';
        if (basename(name) !== name || !/^[a-zA-Z0-9._-]+\.fame\.gz$/.test(name)) return json(res, 400, { error: 'Invalid backup name' });
        const path = join(backupRoot, name);
        if (!existsSync(path)) return json(res, 404, { error: 'Backup not found' });
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${name}"` });
        return await pipeline(createReadStream(path), res);
      }
      if (u.pathname === '/api/import' && req.method === 'POST') {
        if (activeRequests !== 1) return json(res, 409, { error: '请等待聊天或其他操作完成后导入' });
        switching = true;
        const upload = join(uploadRoot, `${randomUUID()}.fame.gz`);
        let total = 0;
        try {
          await maintenance.pause();
          await pipeline(req, new Transform({ transform(chunk, encoding, done) {
            total += chunk.length;
            done(total > maxUploadBytes ? new Error('Backup exceeds configured upload limit') : null, chunk);
          } }), createWriteStream(upload, { flags: 'wx' }));
          const imported = await importVault(upload, vaultRoot);
          const nextName = basename(imported.root);
          if (!/^[a-zA-Z0-9_-]+$/.test(nextName)) throw new Error('Invalid imported vault name');
          const nextStore = new MemoryStore(imported.path);
          let nextAdapter = null, oldClosed = false;
          try {
            oldClosed = true;
            await adapter?.close();
            nextAdapter = adapterFactory ? await adapterFactory(nextStore) : null;
            writeFileSync(`${pointerPath}.tmp`, JSON.stringify({ name: nextName }), { flush: true });
            renameSync(`${pointerPath}.tmp`, pointerPath);
          } catch (error) {
            const failures = [error];
            try { await nextAdapter?.close(); } catch (cleanupError) { failures.push(cleanupError); }
            try { nextStore.close(); } catch (cleanupError) { failures.push(cleanupError); }
            if (oldClosed) {
              adapter = null;
              try { adapter = adapterFactory ? await adapterFactory(store) : null; }
              catch (recoveryError) { failures.push(recoveryError); }
            }
            throw failures.length > 1 ? new Error(failures.map(failure => failure.message).join('; ')) : error;
          }
          const previousStore = store;
          await maintenance.close();
          store = nextStore; adapter = nextAdapter; vaultName = nextName;
          maintenance = createMaintenance(store, adapter);
          previousStore.close();
          return json(res, 200, { vault: vaultName, sessions: imported.sessions });
        } finally {
          await maintenance.close();
          maintenance = createMaintenance(store, adapter);
          switching = false; rmSync(upload, { force: true });
        }
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message, code: error.code, saved: !!error.saved });
      else res.destroy(error);
    } finally { if (tracked) activeRequests--; }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    server, url,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await maintenance.close();
      await adapter?.close();
      store.close();
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const app = await createMemoryServer({ port: Number(process.env.PORT || 5196) });
  console.log(`FAME memory: ${app.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
