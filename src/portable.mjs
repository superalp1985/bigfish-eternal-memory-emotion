import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm, rename, stat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { exportVault } from './backup.mjs';

const project = resolve(import.meta.dirname, '..');
export function runPowerShell(script, args = []) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-16000); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-16000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun(output.trim()) : reject(new Error(errors || output || `Operation exited ${code}`)));
  });
}

export async function createPortable(store, directory, options = {}) {
  const dsh = options.dshRoot ?? process.env.BIGFISH_DSH_ROOT ?? join(project, 'runtime');
  await mkdir(directory, { recursive: true });
  const stage = await mkdtemp(join(directory, '.packing-'));
  const name = `BigFish-Memory-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  const destination = join(directory, name);
  try {
    await exportVault(store, join(stage, 'memory.fame.gz'), { mediaStore: options.mediaStore });
    const entries = [
      ...['src', 'public', 'scripts', 'config', 'docs', 'start.ps1', 'start-background.ps1', 'background-runner.ps1',
        'install.ps1', 'Install.cmd', 'README.md', 'FAME_REFERENCE.md', 'package.json']
        .map(file => ({ source: join(project, file), target: file })),
      { source: join(stage, 'memory.fame.gz'), target: 'transfer/memory.fame.gz' },
      { source: join(dsh, 'node/node.exe'), target: 'runtime/node/node.exe' },
      { source: join(dsh, 'node/LICENSE'), target: 'runtime/node/LICENSE' },
      { source: join(dsh, 'app/node_modules'), target: 'runtime/app/node_modules' },
      { source: join(project, 'runtime/dsh/profiles/fame-memory/package.json'), target: 'runtime/dsh/profiles/fame-memory/package.json' },
      { source: join(project, 'runtime/dsh/profiles/fame-memory/cordis.patch.yml'), target: 'runtime/dsh/profiles/fame-memory/cordis.patch.yml' },
      { source: await realpath(join(project, 'runtime/dsh/profiles/fame-memory/node_modules/dsh-dafeiyu')),
        target: 'runtime/dsh/profiles/fame-memory/node_modules/dsh-dafeiyu' },
    ];
    await writeFile(join(stage, 'entries.json'), JSON.stringify(entries), 'utf8');
    await runPowerShell(join(project, 'scripts/pack.ps1'), ['-Manifest', join(stage, 'entries.json'), '-Destination', destination + '.partial']);
    await rename(destination + '.partial', destination);
    return { name, path: destination, bytes: (await stat(destination)).size };
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(destination + '.partial', { force: true });
  }
}

export async function chooseStorage(current) {
  const answer = await runPowerShell(join(project, 'scripts/choose-folder.ps1'), ['-Current', current]);
  return answer ? Buffer.from(answer, 'base64').toString('utf8') : null;
}

export function revealFile(path) {
  const child = spawn('explorer.exe', ['/select,', path], { windowsHide: true, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
