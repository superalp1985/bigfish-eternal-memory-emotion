import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export function workbuddyDataDir(explicit, env = process.env) {
  const supplied = explicit || env.BIGFISH_DATA_DIR || env.CODEBUDDY_PLUGIN_DATA ||
    env.WORKBUDDY_PLUGIN_DATA || env.BIGFISH_HOME;
  if (supplied && !/[$%]\{?[A-Z_]+\}?/u.test(supplied)) return resolve(supplied);
  return join(homedir(), '.bigfish-eternal-memory');
}

export function workbuddyPaths(dataDir) {
  const root = resolve(dataDir);
  const vault = join(root, 'vault');
  const primary = join(vault, 'primary');
  return {
    root,
    vault,
    primary,
    database: join(primary, 'memory.sqlite'),
    media: join(primary, 'media'),
    backups: join(root, 'backups'),
    manifests: join(root, 'manifests'),
    locks: join(root, 'locks'),
    outbox: join(root, 'outbox'),
    rawTranscripts: join(root, 'raw-transcripts'),
  };
}

export function ensureWorkbuddyPaths(paths) {
  for (const path of [paths.root, paths.vault, paths.primary, paths.backups,
    paths.manifests, paths.locks, paths.outbox, paths.rawTranscripts]) {
    mkdirSync(path, { recursive: true });
  }
  return paths;
}

export function transcriptSessionId(path) {
  return dirname(path) && String(path).replaceAll('\\', '/').split('/').at(-1)
    .replace(/\.jsonl$/iu, '');
}
