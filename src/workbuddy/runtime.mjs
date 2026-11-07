import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { MemoryStore, hash } from '../memory-store.mjs';
import { MediaStore } from '../media-store.mjs';
import { exportVault } from '../backup.mjs';
import { archiveTranscript } from './archive.mjs';
import { ensureWorkbuddyPaths, workbuddyDataDir, workbuddyPaths } from './paths.mjs';
import { transcriptSessionId } from './paths.mjs';

export function allowedTranscriptPath(path, env = process.env) {
  const target = resolve(path);
  const projects = resolve(env.WORKBUDDY_PROJECTS_DIR || join(homedir(), '.workbuddy', 'projects'));
  const normalized = process.platform === 'win32' ? target.toLowerCase() : target;
  const root = process.platform === 'win32' ? projects.toLowerCase() : projects;
  return normalized === root || normalized.startsWith(`${root}\\`) || normalized.startsWith(`${root}/`);
}

export function createWorkBuddyRuntime({ dataDir, env = process.env } = {}) {
  const paths = ensureWorkbuddyPaths(workbuddyPaths(workbuddyDataDir(dataDir, env)));
  const store = new MemoryStore(paths.database);
  const mediaStore = new MediaStore(paths.primary);
  let closed = false;

  const runtime = {
    paths,
    store,
    mediaStore,

    async archive({ sessionId, transcriptPath, maxRecords = Infinity, allowOutside = false }) {
      if (!allowOutside && !allowedTranscriptPath(transcriptPath, env)) {
        throw new Error('Transcript path is outside the WorkBuddy projects directory');
      }
      const id = String(sessionId || transcriptSessionId(transcriptPath));
      return archiveTranscript({ store, mediaStore, sessionId: id, transcriptPath, maxRecords });
    },

    search(query, { sessionId, limit = 10 } = {}) {
      const bounded = Math.min(50, Math.max(1, Number(limit) || 10));
      const sessions = sessionId ? [store.getSession(sessionId)] :
        store.db.prepare('SELECT id,title FROM sessions ORDER BY updated_at DESC').all();
      const results = [];
      for (const session of sessions) {
        for (const memory of store.recall(session.id, String(query ?? ''), bounded)) {
          results.push({
            ...memory,
            session_title: session.title,
            evidence: {
              session_id: session.id,
              event_ref: memory.source?.kind === 'workbuddy' ? {
                line: memory.source.line,
                sha256: memory.source.line_sha256,
              } : null,
            },
          });
        }
      }
      return results.sort((a, b) =>
        (b.routing_metrics?.retrieval_score ?? 0) - (a.routing_metrics?.retrieval_score ?? 0))
        .slice(0, bounded);
    },

    recent(limit = 10) {
      return store.db.prepare(`SELECT m.id,m.session_id,m.text,m.route,m.importance,m.created_at,s.title
        FROM memories m JOIN sessions s ON s.id=m.session_id
        ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?`).all(Math.min(50, Math.max(1, limit)));
    },

    original(sessionId, { line, seq } = {}) {
      let row;
      if (Number.isSafeInteger(seq)) {
        row = store.db.prepare(`SELECT generation,seq,type,json,sha,text,created_at FROM events
          WHERE session_id=? AND generation=0 AND seq=?`).get(sessionId, seq);
      } else {
        if (!Number.isSafeInteger(line)) throw new Error('line or seq is required');
        row = store.db.prepare(`SELECT generation,seq,type,json,sha,text,created_at FROM events
          WHERE session_id=? AND generation=0
            AND json_extract(json,'$.workbuddy.line')=?
          ORDER BY rowid DESC LIMIT 1`).get(sessionId, line);
      }
      if (!row) return null;
      if (hash(row.json) !== row.sha) throw new Error('Original event checksum mismatch');
      const event = JSON.parse(row.json);
      return {
        session_id: sessionId, generation: row.generation, seq: row.seq,
        type: row.type, created_at: row.created_at, sha256: row.sha,
        workbuddy: event.workbuddy, raw: event.raw, data: event.data,
        media: event.workbuddyMedia ?? [],
      };
    },

    media(mediaId) {
      const path = mediaStore.path(mediaId);
      if (!existsSync(path)) return null;
      const stat = statSync(path);
      return { id: mediaId, bytes: stat.size, path };
    },

    addMemory(sessionId, input) {
      store.getSession(sessionId);
      return store.addMemory(sessionId, input);
    },

    async backup({ name } = {}) {
      const requested = typeof name === 'string' && name.trim()
        ? name.trim().replace(/[^a-zA-Z0-9._-]/gu, '-').slice(0, 120)
        : `bigfish-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
      const filename = requested.endsWith('.fame.gz') ? requested : `${requested}.fame.gz`;
      const path = join(paths.backups, filename);
      const archive = await exportVault(store, path, { mediaStore });
      return {
        ...archive,
        name: filename,
        verified: true,
        contains_credentials: false,
      };
    },

    recordEmotion(sessionId, actor, vector, evidence = []) {
      store.getSession(sessionId);
      return store.recordFame(sessionId, actor, vector, {
        method: 'user-defined', evidence, confidence: 1,
      });
    },

    context(query, { sessionId, maxChars = 8000 } = {}) {
      const results = this.search(query, { sessionId, limit: 16 });
      const bounded = Math.min(16000, Math.max(1000, Number(maxChars) || 8000));
      const lines = results.map(item =>
        `- [${item.session_title}] ${item.text.slice(0, 1600)}` +
        (item.evidence.event_ref?.line === undefined ? '' : ` (session=${item.session_id}, line=${item.evidence.event_ref.line})`));
      return lines.join('\n').slice(0, bounded);
    },

    health() {
      const sessions = store.db.prepare('SELECT count(*) AS n FROM sessions').get().n;
      const events = store.db.prepare('SELECT count(*) AS n FROM events').get().n;
      const memories = store.db.prepare('SELECT count(*) AS n FROM memories').get().n;
      const media = mediaStore.list();
      const backups = existsSync(paths.backups)
        ? readdirSync(paths.backups).filter(name => name.endsWith('.fame.gz')).length : 0;
      return {
        ok: true,
        data_dir: paths.root,
        database: paths.database,
        sessions,
        events,
        memories,
        media_objects: media.length,
        media_bytes: media.reduce((sum, item) => sum + item.bytes, 0),
        backups,
      };
    },

    close() {
      if (closed) return;
      closed = true;
      store.close();
    },
  };
  return runtime;
}
