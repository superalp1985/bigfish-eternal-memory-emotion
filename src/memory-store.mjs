import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { evolveFame, validateFame, fameAffinity, FAME_VERSION, FAME_SCHEMA } from './fame.mjs';
import { ByteCache } from './cache.mjs';

const parse = value => value ? JSON.parse(value) : null;
const now = () => new Date().toISOString();
export const hash = text => createHash('sha256').update(text).digest('hex');
export const TABLES = ['sessions', 'events', 'memories', 'edges', 'fame_states', 'checkpoints'];

export function eventText(event) {
  const data = event.data ?? {};
  const blocks = data.content ?? data.message?.content ?? [];
  return blocks.filter(x => x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n');
}

function terms(query) {
  const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const result = new Set(words.slice(0, 64));
  const chinese = words.filter(word => /\p{Script=Han}/u.test(word)).map(word => [...word]);
  // Share the bounded query budget across clauses so later questions participate.
  for (let i = 0; result.size < 128; i++) {
    let remaining = false;
    for (const chars of chinese) {
      if (i >= chars.length - 1) continue;
      remaining = true;
      result.add(chars.slice(i, i + 2).join(''));
      if (result.size === 128) break;
    }
    if (!remaining) break;
  }
  return [...result];
}

export class MemoryStore {
  constructor(path) {
    this.path = path;
    this.cache = new ByteCache();
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      PRAGMA cache_size=-8192; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL REFERENCES sessions(id), generation INTEGER NOT NULL,
        seq INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL, sha TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(session_id,generation,seq));
      CREATE INDEX IF NOT EXISTS event_recent ON events(session_id,created_at);
      CREATE INDEX IF NOT EXISTS event_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS event_message_id ON events(
        session_id,coalesce(json_extract(json,'$.data.id'),json_extract(json,'$.data.message.id')));
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), route TEXT NOT NULL,
        text TEXT NOT NULL, source TEXT NOT NULL, importance REAL NOT NULL,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_route ON memories(session_id,route);
      CREATE INDEX IF NOT EXISTS memory_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS memory_importance ON memories(session_id,importance DESC,created_at DESC);
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS edge_source ON edges(session_id,source);
      CREATE TABLE IF NOT EXISTS fame_states (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), actor TEXT NOT NULL,
        vector TEXT NOT NULL, evidence TEXT NOT NULL, method TEXT NOT NULL,
        confidence REAL NOT NULL, parameters TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS fame_recent ON fame_states(session_id,actor,created_at);
      CREATE INDEX IF NOT EXISTS fame_actor ON fame_states(session_id,actor);
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT NOT NULL REFERENCES sessions(id), generation INTEGER NOT NULL,
        json TEXT NOT NULL, sha TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(session_id,generation));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        session_id UNINDEXED, memory_id UNINDEXED, tokens, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS session_totals (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id),
        events INTEGER NOT NULL DEFAULT 0, memories INTEGER NOT NULL DEFAULT 0,
        archive_bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS derived_meta (name TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO session_totals
        SELECT s.id,
          (SELECT count(*) FROM events e WHERE e.session_id=s.id),
          (SELECT count(*) FROM memories m WHERE m.session_id=s.id),
          (SELECT coalesce(sum(length(CAST(json AS BLOB))),0) FROM events e WHERE e.session_id=s.id)
        FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM session_totals t WHERE t.session_id=s.id);
      CREATE TRIGGER IF NOT EXISTS session_total_insert AFTER INSERT ON sessions BEGIN
        INSERT INTO session_totals(session_id) VALUES(new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS event_total_insert AFTER INSERT ON events BEGIN
        UPDATE session_totals SET events=events+1,archive_bytes=archive_bytes+length(CAST(new.json AS BLOB))
          WHERE session_id=new.session_id;
      END;
      CREATE TRIGGER IF NOT EXISTS memory_total_insert AFTER INSERT ON memories BEGIN
        UPDATE session_totals SET memories=memories+1 WHERE session_id=new.session_id;
      END;
      PRAGMA user_version=1;
    `);
    if (!this.db.prepare("SELECT 1 FROM derived_meta WHERE name='byte-counter-v2'").get()) {
      this.transaction(() => this.db.exec(`
        DROP TRIGGER event_total_insert;
        CREATE TRIGGER event_total_insert AFTER INSERT ON events BEGIN
          UPDATE session_totals SET events=events+1,archive_bytes=archive_bytes+length(CAST(new.json AS BLOB))
            WHERE session_id=new.session_id;
        END;
        UPDATE session_totals SET archive_bytes=(SELECT coalesce(sum(length(CAST(json AS BLOB))),0)
          FROM events WHERE events.session_id=session_totals.session_id);
        INSERT INTO derived_meta(name,value) VALUES('byte-counter-v2','1');
      `));
    }
  }

  transaction(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); this.cache.clear(); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createSession(id = randomUUID(), title = 'New conversation', options = {}) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 200) throw new Error('Invalid session ID');
    this.db.prepare('INSERT INTO sessions(id,title,created_at,updated_at,options) VALUES(?,?,?,?,?)')
      .run(id, String(title).slice(0, 200), now(), now(), JSON.stringify(options));
    return this.getSession(id);
  }

  getSession(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!row) throw new Error('Session not found');
    return { ...row, options: parse(row.options) };
  }

  listSessions() {
    return this.db.prepare('SELECT id,title,generation,created_at,updated_at FROM sessions ORDER BY updated_at DESC LIMIT 200').all();
  }

  appendEvent(id, generation, event) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid event position');
    const json = JSON.stringify(event);
    const sha = hash(json);
    const existing = this.db.prepare('SELECT sha FROM events WHERE session_id=? AND generation=? AND seq=?').get(id, generation, event.seq);
    if (existing) {
      if (existing.sha !== sha) throw new Error('Archive event conflict');
      return false;
    }
    const text = eventText(event);
    this.transaction(() => {
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)')
        .run(id, generation, event.seq, event.type, json, sha, text, now());
      this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now(), id);
      const message = event.data?.message ?? event.data;
      const sourceKind = message?.source?.kind;
      const genuine = event.type === 'assistant/message' || event.type === 'user/message' && (!sourceKind || sourceKind === 'user');
      if (text && genuine) {
        const mid = hash(`${id}:${message?.id ?? `${generation}:${event.seq}`}`);
        if (!this.db.prepare('SELECT 1 FROM memories WHERE id=?').get(mid)) this.insertMemory({
          id: mid, session_id: id, route: 'conversation/history', text,
          source: JSON.stringify({ generation, seq: event.seq }), importance: 0.5, created_at: now(),
        });
      }
    });
    return true;
  }

  insertMemory(row) {
    this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?)')
      .run(row.id, row.session_id, row.route, row.text, row.source, row.importance, row.created_at);
    this.db.prepare('INSERT INTO memory_fts(session_id,memory_id,tokens) VALUES(?,?,?)')
      .run(row.session_id, row.id, termsForIndex(row.text));
  }

  addMemory(id, { text, route = 'conversation/facts', source = {}, importance = 0.7 }) {
    if (!text?.trim() || text.length > 100000) throw new Error('Invalid memory text');
    const fame = Object.fromEntries(Object.entries(this.currentFame(id)).map(([actor, state]) => [actor,
      state ? { vector: state.vector, confidence: state.confidence, method: state.method, state_id: state.id } : null]));
    const row = { id: randomUUID(), session_id: id, route, text,
      source: JSON.stringify({ ...source, fame_schema: FAME_SCHEMA, fame }), importance, created_at: now() };
    this.transaction(() => this.insertMemory(row));
    return row;
  }

  recall(id, query, limit = 8) {
    this.getSession(id);
    query = String(query).slice(0, 2000);
    const cacheKey = JSON.stringify([id, query, limit]);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const tokens = terms(query);
    if (!tokens.length) return [];
    const match = tokens.map(x => `"${x.replaceAll('"', '""')}"`).join(' OR ');
    const rows = this.db.prepare(`SELECT m.*, bm25(memory_fts) AS rank
      FROM memory_fts JOIN memories m ON m.id=memory_fts.memory_id
      WHERE memory_fts MATCH ? AND m.session_id=?
      ORDER BY rank,m.importance DESC LIMIT 32`).all(match, id);
    const fame = this.currentFame(id);
    const result = rows.map((row, index) => {
      const source = parse(row.source);
      const affinity = source?.fame_schema === FAME_SCHEMA ? fameAffinity(source.fame, fame) : null;
      const routing_metrics = {
        lexical_rank: index + 1, importance: row.importance, emotion_affinity: affinity,
        retrieval_score: 0.8 / (index + 1) + 0.15 * row.importance + 0.05 * (affinity ?? 0),
      };
      return { ...row, source, text: row.text.slice(0, 6000), routing_metrics };
    }).sort((a, b) => b.routing_metrics.retrieval_score - a.routing_metrics.retrieval_score)
      .slice(0, Math.min(30, Math.max(1, limit)));
    this.cache.set(cacheKey, result);
    return result;
  }

  context(id, query, maxChars = 12000) {
    const snapshot = this.snapshot(id);
    const fame = Object.fromEntries(Object.entries(this.currentFame(id)).filter(([, state]) => state).map(([actor, state]) =>
      [actor, state.vector]));
    const memories = this.recall(id, query);
    const known = new Set(memories.map(row => row.id));
    const important = this.db.prepare('SELECT id,text,route,source FROM memories WHERE session_id=? AND importance>=0.85 ORDER BY importance DESC,created_at DESC LIMIT 4').all(id);
    for (const row of important) if (!known.has(row.id)) memories.push({ ...row, source: parse(row.source) });
    const parts = [];
    if (Object.keys(fame).length) parts.push(`Saved emotional states: ${JSON.stringify(fame)}`);
    if (snapshot?.summary) parts.push(`Summary: ${snapshot.summary.slice(0, Math.min(3000, Math.floor(maxChars * 0.35)))}`);
    for (const memory of memories) parts.push(`Memory ${memory.id} (${memory.route}): ${memory.text.slice(0, 1800)}`);
    return parts.join('\n\n').slice(0, Math.max(0, maxChars));
  }

  recordFame(id, actor, target, { evidence = [], method = 'user-defined', confidence = 1, dt = 1, tau = 1, xi = 0.7, observationId } = {}) {
    if (!['user', 'agent'].includes(actor) || confidence < 0 || confidence > 1) throw new Error('Invalid FAME observation');
    const previous = this.currentFame(id)[actor]?.vector ?? {};
    const vector = method === 'user-defined' ? validateFame(target) : evolveFame(previous, validateFame(target), { dt, tau, xi });
    const row = { id: observationId ?? randomUUID(), vector, evidence, method, confidence, parameters: { dt, tau, xi, version: FAME_VERSION } };
    this.db.prepare('INSERT INTO fame_states VALUES(?,?,?,?,?,?,?,?,?)')
      .run(row.id, id, actor, JSON.stringify(vector), JSON.stringify(evidence), method, confidence, JSON.stringify(row.parameters), now());
    this.cache.clear();
    return row;
  }

  currentFame(id) {
    return Object.fromEntries(['user', 'agent'].map(actor => {
      const row = this.db.prepare('SELECT * FROM fame_states WHERE session_id=? AND actor=? ORDER BY rowid DESC LIMIT 1').get(id, actor);
      return [actor, row ? { ...row, vector: parse(row.vector), evidence: parse(row.evidence), parameters: parse(row.parameters) } : null];
    }));
  }

  checkpoint(id, snapshot) {
    const generation = this.getSession(id).generation + 1;
    const json = JSON.stringify(snapshot);
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error('Working snapshot too large');
    this.transaction(() => {
      this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?,?)').run(id, generation, json, hash(json), now());
      this.db.prepare('UPDATE sessions SET generation=?,updated_at=? WHERE id=?').run(generation, now(), id);
    });
    return generation;
  }

  snapshot(id) {
    const row = this.db.prepare('SELECT c.json,c.sha FROM checkpoints c JOIN sessions s ON s.id=c.session_id AND s.generation=c.generation WHERE s.id=?').get(id);
    if (!row) return null;
    if (hash(row.json) !== row.sha) throw new Error('Checkpoint checksum mismatch');
    return parse(row.json);
  }

  activeEvents(id) {
    const { generation } = this.getSession(id);
    return this.db.prepare('SELECT json,sha FROM events WHERE session_id=? AND generation=? ORDER BY seq').all(id, generation).map(x => {
      if (hash(x.json) !== x.sha) throw new Error('Active event checksum mismatch');
      return parse(x.json);
    });
  }

  transcript(id, before = Number.MAX_SAFE_INTEGER, limit = 50) {
    return this.db.prepare(`SELECT e.rowid AS cursor,e.generation,e.seq,e.type,e.text,e.created_at FROM events e
      WHERE e.session_id=? AND e.rowid<? AND e.type IN ('user/message','assistant/message') AND e.text!=''
      AND (e.type='assistant/message' OR coalesce(json_extract(e.json,'$.data.source.kind'),'user')='user')
      AND NOT EXISTS (SELECT 1 FROM events prior WHERE prior.session_id=e.session_id AND prior.rowid<e.rowid
        AND coalesce(json_extract(prior.json,'$.data.id'),json_extract(prior.json,'$.data.message.id')) =
            coalesce(json_extract(e.json,'$.data.id'),json_extract(e.json,'$.data.message.id')))
      ORDER BY e.rowid DESC LIMIT ?`).all(id, before, Math.min(100, limit)).reverse();
  }

  stats(id) {
    const session = this.getSession(id);
    const totals = this.db.prepare('SELECT * FROM session_totals WHERE session_id=?').get(id);
    return {
      ...session,
      events: totals.events,
      memories: totals.memories,
      archiveBytes: totals.archive_bytes,
      activeEvents: this.db.prepare('SELECT count(*) AS n FROM events WHERE session_id=? AND generation=?').get(id, session.generation).n,
    };
  }

  rebuildIndex() {
    this.transaction(() => {
      this.db.exec('DELETE FROM memory_fts');
      for (const row of this.db.prepare('SELECT * FROM memories').iterate()) {
        this.db.prepare('INSERT INTO memory_fts(session_id,memory_id,tokens) VALUES(?,?,?)').run(row.session_id, row.id, termsForIndex(row.text));
      }
    });
  }

  close() { this.cache.clear(); this.db.close(); }
}

function termsForIndex(text) {
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const output = [];
  for (const word of words) {
    output.push(word);
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      for (let i = 0; i < chars.length - 1; i++) output.push(chars.slice(i, i + 2).join(''));
    }
  }
  return output.join(' ');
}
