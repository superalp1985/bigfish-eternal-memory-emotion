import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { importVault } from '../src/backup.mjs';

const project = resolve(import.meta.dirname, '..');
const target = resolve(process.argv[2] ?? join(project, 'data'));
const priorConfig = join(project, 'runtime/storage.json');
if (existsSync(priorConfig)) {
  const prior = JSON.parse(readFileSync(priorConfig, 'utf8')).root;
  if (prior && resolve(prior).toLowerCase() !== target.toLowerCase()) {
    const portFile = join(project, 'runtime/launch.json');
    const port = existsSync(portFile) ? JSON.parse(readFileSync(portFile, 'utf8')).port : 5196;
    let bootstrap;
    try { bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(2000) }); } catch {}
    if (bootstrap?.ok) {
      const state = await bootstrap.json();
      if (resolve(state.project ?? '').toLowerCase() !== project.toLowerCase() || resolve(state.root).toLowerCase() !== resolve(prior).toLowerCase()) throw new Error('Another installation owns the selected port');
      const response = await fetch(`http://127.0.0.1:${port}/api/storage`, {
        method: 'POST', headers: { cookie: bootstrap.headers.get('set-cookie').split(';')[0], 'x-fame-token': state.token, 'content-type': 'application/json' },
        body: JSON.stringify({ root: target }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      console.log(JSON.stringify(result));
      process.exit(0);
    }
    // An existing installation must migrate its saved vault, never start empty.
    if (!existsSync(prior)) throw new Error('The previous memory drive is unavailable');
    const serviceLock = openSync(join(project, 'runtime/service.lock'), 'a+');
    let manager;
    try {
      const { createMemoryServer } = await import('../src/server.mjs');
      manager = await createMemoryServer({ root: prior, port: 0, storageConfigPath: priorConfig });
      const response = await fetch(manager.url + '/api/bootstrap');
      const { token } = await response.json();
      const changed = await fetch(manager.url + '/api/storage', {
        method: 'POST', headers: { cookie: response.headers.get('set-cookie').split(';')[0], 'x-fame-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ root: target }),
      });
      const result = await changed.json();
      if (!changed.ok) throw new Error(result.error);
      console.log(JSON.stringify(result));
    } finally { await manager?.close(); closeSync(serviceLock); }
    process.exit(0);
  }
}
mkdirSync(target, { recursive: true });
const archive = join(project, 'transfer/memory.fame.gz');
const pointer = join(target, 'active-vault.json');
if (existsSync(archive) && !existsSync(pointer)) {
  // A repeated installation must not replace an already active memory vault.
  if (existsSync(join(target, 'vaults/primary/memory.sqlite'))) throw new Error('Target contains an existing memory vault');
  const imported = await importVault(archive, join(target, 'vaults'));
  writeFileSync(pointer + '.tmp', JSON.stringify({ name: basename(imported.root) }), { flush: true });
  renameSync(pointer + '.tmp', pointer);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  writeFileSync(join(target, 'transfer-receipt.json'), JSON.stringify({ sha256: digest.digest('hex'), sessions: imported.sessions }));
}
const configPath = join(project, 'runtime/storage.json');
mkdirSync(join(project, 'runtime'), { recursive: true });
writeFileSync(configPath + '.tmp', JSON.stringify({ root: target }), { flush: true });
renameSync(configPath + '.tmp', configPath);
console.log(JSON.stringify({ root: target, restored: existsSync(pointer) }));
