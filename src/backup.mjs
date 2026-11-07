import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  createReadStream, createWriteStream, mkdirSync, mkdtempSync, existsSync,
  linkSync, renameSync, rmSync, openSync, fsyncSync, closeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { MemoryStore, TABLES, hash } from './memory-store.mjs';
import { FAME_KEYS, FAME_VERSION, validateFame } from './fame.mjs';
import { MEDIA_KINDS, MediaStore } from './media-store.mjs';

export const BACKUP_VERSION = 2;
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MEDIA_CHUNK_BYTES = 384 * 1024;
const SCHEMA_VERSION = 1;
const FORMAT = 'fame-vault';
const ADAPTER_OWNER = 'fame-dsh-memory/v1';
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const SCHEMA = Object.freeze({
  sessions: [
    ['id', 'TEXT', 1], ['title', 'TEXT', 0], ['generation', 'INTEGER', 0],
    ['created_at', 'TEXT', 0], ['updated_at', 'TEXT', 0], ['options', 'TEXT', 0],
  ],
  events: [
    ['session_id', 'TEXT', 1], ['generation', 'INTEGER', 2], ['seq', 'INTEGER', 3],
    ['type', 'TEXT', 0], ['json', 'TEXT', 0], ['sha', 'TEXT', 0],
    ['text', 'TEXT', 0], ['created_at', 'TEXT', 0],
  ],
  memories: [
    ['id', 'TEXT', 1], ['session_id', 'TEXT', 0], ['route', 'TEXT', 0],
    ['text', 'TEXT', 0], ['source', 'TEXT', 0], ['importance', 'REAL', 0], ['created_at', 'TEXT', 0],
  ],
  edges: [
    ['id', 'TEXT', 1], ['session_id', 'TEXT', 0], ['source', 'TEXT', 0],
    ['target', 'TEXT', 0], ['relation', 'TEXT', 0],
  ],
  fame_states: [
    ['id', 'TEXT', 1], ['session_id', 'TEXT', 0], ['actor', 'TEXT', 0],
    ['vector', 'TEXT', 0], ['evidence', 'TEXT', 0], ['method', 'TEXT', 0],
    ['confidence', 'REAL', 0], ['parameters', 'TEXT', 0], ['created_at', 'TEXT', 0],
  ],
  checkpoints: [
    ['session_id', 'TEXT', 1], ['generation', 'INTEGER', 2],
    ['json', 'TEXT', 0], ['sha', 'TEXT', 0], ['created_at', 'TEXT', 0],
  ],
});
const TABLE_NAMES = Object.freeze(Object.keys(SCHEMA));
const columns = table => SCHEMA[table].map(([name]) => name);
const emptyCounts = () => Object.fromEntries(TABLE_NAMES.map(table => [table, 0]));
const fail = message => { throw new Error(`FAME backup: ${message}`); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, keys, label) {
  if (!isObject(value) || Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key))) fail(`invalid ${label} schema`);
}

function jsonValue(value, label, object = false) {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { fail(`invalid JSON in ${label}`); }
  if (object && !isObject(parsed)) fail(`invalid ${label} schema`);
  return parsed;
}

function modelIdentifiers(source) {
  const result = {};
  for (const key of ['provider', 'model']) {
    const name = source[key];
    if (typeof name === 'string' && name.length <= 200 &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(name)) result[key] = name;
  }
  return result;
}

function portableOptions(value, preserveModel) {
  const source = jsonValue(value, 'session options', true);
  const result = preserveModel ? modelIdentifiers(source) : {};
  if (source.owner === ADAPTER_OWNER) result.owner = ADAPTER_OWNER;
  if (isObject(source.agentOptions)) {
    const agent = source.agentOptions;
    const safe = modelIdentifiers(agent);
    if (Number.isSafeInteger(agent.maxTokens) && agent.maxTokens > 0) safe.maxTokens = agent.maxTokens;
    if (REASONING_EFFORTS.has(agent.reasoningEffort)) safe.reasoningEffort = agent.reasoningEffort;
    if (Object.keys(safe).length) result.agentOptions = safe;
  }
  return JSON.stringify(result);
}

function portableRow(table, row, preserveModel) {
  if (table === 'sessions') return { ...row, options: portableOptions(row.options, preserveModel) };
  if (table === 'checkpoints') {
    const snapshot = jsonValue(row.json, 'checkpoint', true);
    if (isObject(snapshot.runtime) && Object.hasOwn(snapshot.runtime, 'options')) {
      snapshot.runtime.options = JSON.parse(portableOptions(JSON.stringify(snapshot.runtime.options), preserveModel));
      const json = JSON.stringify(snapshot);
      return { ...row, json, sha: hash(json) };
    }
  }
  return row;
}

function validateRow(table, row) {
  if (!Object.hasOwn(SCHEMA, table)) fail('illegal table');
  exactKeys(row, columns(table), `${table} row`);
  for (const [name, type] of SCHEMA[table]) {
    const value = row[name];
    if (type === 'TEXT' ? typeof value !== 'string' :
      type === 'INTEGER' ? !Number.isSafeInteger(value) || value < 0 : !Number.isFinite(value)) {
      fail(`invalid ${table}.${name} type`);
    }
    if (['id', 'session_id'].includes(name) && (value.length < 1 || value.length > 200)) {
      fail(`invalid ${table}.${name}`);
    }
  }
  if (table === 'sessions') {
    if (row.title.length > 200) fail('invalid session title');
    jsonValue(row.options, 'session options', true);
  } else if (table === 'events' || table === 'checkpoints') {
    if (!/^[0-9a-f]{64}$/.test(row.sha) || hash(row.json) !== row.sha) fail(`${table} checksum mismatch`);
    const value = jsonValue(row.json, table, true);
    if (table === 'events' && (value.seq !== row.seq || value.type !== row.type)) {
      fail('event schema position/type mismatch');
    }
    if (table === 'checkpoints' && row.generation < 1) fail('invalid checkpoint generation');
  } else if (table === 'memories') {
    jsonValue(row.source, 'memory source');
    if (row.importance < 0 || row.importance > 1) fail('invalid memory importance');
  } else if (table === 'fame_states') {
    if (!['user', 'agent'].includes(row.actor) || row.confidence < 0 || row.confidence > 1) {
      fail('invalid FAME actor/confidence');
    }
    const vector = jsonValue(row.vector, 'FAME vector', true);
    exactKeys(vector, FAME_KEYS, 'FAME vector');
    validateFame(vector);
    if (!Array.isArray(jsonValue(row.evidence, 'FAME evidence'))) fail('invalid FAME evidence');
    const parameters = jsonValue(row.parameters, 'FAME parameters', true);
    exactKeys(parameters, ['dt', 'tau', 'xi', 'version'], 'FAME parameters');
    if (![parameters.dt, parameters.tau, parameters.xi].every(Number.isFinite) ||
        parameters.dt < 0 || parameters.tau <= 0 || parameters.xi < 0 || parameters.xi > 1 ||
        parameters.version !== FAME_VERSION) fail('invalid FAME parameters/version');
  }
}

function validateSchema(db) {
  if (JSON.stringify(TABLES) !== JSON.stringify(TABLE_NAMES) ||
      db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) {
    fail('unsupported database schema version');
  }
  for (const table of TABLE_NAMES) {
    if (db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(table)?.type !== 'table') {
      fail(`invalid ${table} schema`);
    }
    const fields = db.prepare(`PRAGMA table_xinfo("${table}")`).all();
    if (fields.length !== SCHEMA[table].length || fields.some((field, index) => {
      const [name, type, pk] = SCHEMA[table][index];
      return field.name !== name || field.type !== type || field.pk !== pk || field.hidden !== 0;
    })) fail(`incompatible ${table} column schema`);
    const references = db.prepare(`PRAGMA foreign_key_list("${table}")`).all();
    if (table === 'sessions' ? references.length !== 0 :
      references.length !== 1 || references[0].table !== 'sessions' ||
      references[0].from !== 'session_id' || references[0].to !== 'id') {
      fail(`invalid ${table} schema reference`);
    }
  }
}

function validateReferences(db) {
  for (const table of TABLE_NAMES) {
    if (db.prepare(`PRAGMA foreign_key_check("${table}")`).get()) fail(`invalid ${table} foreign key reference`);
  }
  if (db.prepare(`SELECT 1 FROM sessions s WHERE s.generation > 0 AND NOT EXISTS (
    SELECT 1 FROM checkpoints c WHERE c.session_id=s.id AND c.generation=s.generation) LIMIT 1`).get()) {
    fail('active generation references a missing checkpoint');
  }
  for (const table of ['events', 'checkpoints']) {
    if (db.prepare(`SELECT 1 FROM "${table}" r JOIN sessions s ON s.id=r.session_id
      WHERE r.generation > s.generation LIMIT 1`).get()) fail(`invalid ${table} generation reference`);
  }
}

async function validateMediaReferences(db, mediaStore) {
  const checked = new Map();
  const verify = async ref => {
    const known = checked.get(ref.id);
    if (known !== undefined) {
      if (known !== ref.bytes) fail('media reference size mismatch');
      return;
    }
    try { await mediaStore.verify(ref); }
    catch (cause) { throw new Error(`FAME backup: media verification failed: ${ref.id}`, { cause }); }
    checked.set(ref.id, ref.bytes);
  };
  for (const row of db.prepare('SELECT json FROM events').iterate()) {
    const event = jsonValue(row.json, 'event', true);
    const message = event.data?.message ?? event.data;
    const refs = message?.source?.fameMedia ?? [];
    if (!Array.isArray(refs)) fail('invalid media reference list');
    for (const ref of refs) {
      if (!isObject(ref) || Object.keys(ref).length !== 5 || !/^[a-f0-9]{64}$/.test(ref.id) ||
          !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || typeof ref.name !== 'string' || ref.name.length > 240 ||
          typeof ref.mediaType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(ref.mediaType) ||
          !['image', 'file'].includes(ref.kind)) fail('invalid media reference');
      if (ref.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)) {
        fail('invalid archived image type');
      }
      await verify(ref);
    }
    const workbuddyRefs = event.workbuddyMedia ?? [];
    if (!Array.isArray(workbuddyRefs)) fail('invalid WorkBuddy media reference list');
    for (const ref of workbuddyRefs) {
      if (!isObject(ref) || !/^[a-f0-9]{64}$/.test(String(ref.id)) ||
          !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 ||
          typeof ref.name !== 'string' || ref.name.length < 1 || ref.name.length > 240 ||
          typeof ref.mediaType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(ref.mediaType) ||
          !MEDIA_KINDS.includes(ref.kind)) fail('invalid WorkBuddy media reference');
      await verify(ref);
    }
  }
}

function removeTemporary(path, parent, prefix) {
  const target = resolve(path);
  if (dirname(target) !== resolve(parent) || !basename(target).startsWith(prefix)) {
    fail('refusing cleanup outside temporary workspace');
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function syncFile(path) {
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function encode(record) {
  const line = Buffer.from(`${JSON.stringify(record)}\n`);
  if (line.length - 1 > MAX_RECORD_BYTES) fail('record exceeds size limit');
  return line;
}

async function* archiveRecords(db, preserveModel, result, mediaStore) {
  const digest = createHash('sha256');
  const counts = emptyCounts();
  let records = 0;
  const header = encode({
    type: 'header', format: FORMAT, version: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION, tables: TABLE_NAMES,
  });
  digest.update(header);
  yield header;
  for (const table of TABLE_NAMES) {
    // Reject huge SQLite values before materializing them as JavaScript strings.
    const byteSize = SCHEMA[table].filter(([, type]) => type === 'TEXT')
      .map(([name]) => `coalesce(length(CAST("${name}" AS BLOB)),0)`).join('+');
    if (db.prepare(`SELECT 1 FROM "${table}" WHERE (${byteSize}) > ? LIMIT 1`).get(MAX_RECORD_BYTES)) {
      fail(`${table} record exceeds size limit`);
    }
    for (const original of db.prepare(`SELECT ${columns(table).map(name => `"${name}"`).join(',')} FROM "${table}" ORDER BY rowid`).iterate()) {
      validateRow(table, original);
      const row = portableRow(table, original, preserveModel);
      const line = encode({ type: 'row', table, row });
      digest.update(line);
      counts[table]++;
      records++;
      yield line;
      if (records % 128 === 0) await yieldTurn();
    }
  }
  let mediaObjects = 0;
  let mediaBytes = 0;
  for (const media of mediaStore.list()) {
    const objectHash = createHash('sha256');
    let offset = 0;
    for await (const chunk of createReadStream(media.path, { highWaterMark: MEDIA_CHUNK_BYTES })) {
      objectHash.update(chunk);
      for (let start = 0; start < chunk.length; start += MEDIA_CHUNK_BYTES) {
        const part = chunk.subarray(start, Math.min(start + MEDIA_CHUNK_BYTES, chunk.length));
        const line = encode({ type: 'media', id: media.id, bytes: media.bytes, offset,
          data: part.toString('base64'), final: offset + part.length === media.bytes });
        digest.update(line);
        yield line;
        offset += part.length;
        records++;
      }
    }
    if (offset === 0) {
      const line = encode({ type: 'media', id: media.id, bytes: 0, offset: 0, data: '', final: true });
      digest.update(line);
      yield line;
      records++;
    }
    if (offset !== media.bytes || objectHash.digest('hex') !== media.id) fail(`media checksum mismatch: ${media.id}`);
    mediaObjects++;
    mediaBytes += media.bytes;
    if (!Number.isSafeInteger(mediaBytes)) fail('media archive exceeds the supported byte count');
  }
  const sha256 = digest.digest('hex');
  Object.assign(result, { version: BACKUP_VERSION, sessions: counts.sessions, records, counts, mediaObjects, mediaBytes, sha256 });
  yield encode({ type: 'footer', algorithm: 'sha256', sha256, records, counts, mediaObjects, mediaBytes });
}

/**
 * Export a versioned, streaming memory archive. Adapter ownership and safe
 * agentOptions survive; preserveModel also retains top-level provider/model.
 * Session and checkpoint runtime options lose all connection/machine settings.
 * The destination must be new, end in .fame.gz, and support hard-link publication.
 */
export async function exportVault(store, destination, { preserveModel = false, mediaStore } = {}) {
  if (typeof destination !== 'string' || !destination.toLowerCase().endsWith('.fame.gz')) {
    fail('destination must end in .fame.gz');
  }
  if (typeof store?.path !== 'string' || store.path === ':memory:' || !store.db?.isOpen) {
    fail('export requires an open file-backed MemoryStore');
  }
  if (typeof preserveModel !== 'boolean') fail('invalid preserveModel option');
  mediaStore ??= new MediaStore(dirname(resolve(store.path)));
  const target = resolve(destination);
  const parent = dirname(target);
  if (existsSync(target)) fail('destination already exists');
  mkdirSync(parent, { recursive: true });
  let reader;
  let snapshot;
  let temporary;
  try {
    // Pin on a dedicated connection before the first await. Live-store writes
    // never share this transaction; WAL keeps the reader's snapshot consistent.
    reader = new DatabaseSync(resolve(store.path), { readOnly: true });
    reader.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    reader.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
    temporary = mkdtempSync(join(parent, '.fame-export-'));
    const snapshotPath = join(temporary, 'snapshot.sqlite');
    await sqliteBackup(reader, snapshotPath, { rate: 128 });
    reader.close();
    reader = undefined;
    snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    snapshot.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
    validateSchema(snapshot);
    validateReferences(snapshot);
    await validateMediaReferences(snapshot, mediaStore);
    const staged = join(temporary, 'archive.fame.gz');
    const result = { path: target };
    await pipeline(
      archiveRecords(snapshot, preserveModel, result, mediaStore),
      createGzip(),
      createWriteStream(staged, { flags: 'wx', mode: 0o600 }),
    );
    snapshot.close();
    snapshot = undefined;
    syncFile(staged);
    // Unlike rename/copy, this publishes a complete file and fails if occupied.
    linkSync(staged, target);
    return result;
  } finally {
    try { snapshot?.close(); }
    finally {
      try { reader?.close(); }
      finally { if (temporary) removeTemporary(temporary, parent, '.fame-export-'); }
    }
  }
}

async function* boundedLines(source) {
  let parts = [];
  let size = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      size += part.length;
      if (size > MAX_RECORD_BYTES) fail('record exceeds size limit');
      parts.push(part);
      if (newline === -1) break;
      yield Buffer.concat([...parts, Buffer.from('\n')], size + 1);
      parts = [];
      size = 0;
      offset = end + 1;
    }
  }
  if (size !== 0) fail('truncated record: missing final newline');
}

async function loadArchive(path, store, mediaStore) {
  const digest = createHash('sha256');
  const counts = emptyCounts();
  const statements = Object.fromEntries(TABLE_NAMES.map(table => [
    table, store.db.prepare(`INSERT INTO "${table}" (${columns(table).map(name => `"${name}"`).join(',')})
      VALUES (${columns(table).map(() => '?').join(',')})`),
  ]));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let header;
  let footer;
  let records = 0;
  let tableIndex = -1;
  let mediaStarted = false;
  let mediaObjects = 0;
  let mediaBytes = 0;
  const mediaIds = new Set();
  await pipeline(createReadStream(path), createGunzip(), async source => {
    const lines = boundedLines(source)[Symbol.asyncIterator]();
    const read = async () => {
      const next = await lines.next();
      if (next.done) return null;
      try { return { line: next.value, record: JSON.parse(decoder.decode(next.value)) }; }
      catch { fail('invalid UTF-8 or JSON record'); }
    };
    const account = line => { digest.update(line); records++; };
    for (let item = await read(); item; item = await read()) {
      const { line, record } = item;
      if (footer) fail('trailing data after footer');
      if (header === undefined) {
        exactKeys(record, ['type', 'format', 'version', 'schemaVersion', 'tables'], 'header');
        if (record.type !== 'header' || record.format !== FORMAT || ![1, BACKUP_VERSION].includes(record.version) ||
            record.schemaVersion !== SCHEMA_VERSION || JSON.stringify(record.tables) !== JSON.stringify(TABLE_NAMES)) {
          fail('unsupported format/version/schema tables');
        }
        header = record.version;
        digest.update(line);
        continue;
      }
      if (record?.type === 'footer') {
        exactKeys(record, header === 1
          ? ['type', 'algorithm', 'sha256', 'records', 'counts']
          : ['type', 'algorithm', 'sha256', 'records', 'counts', 'mediaObjects', 'mediaBytes'], 'footer');
        exactKeys(record.counts, TABLE_NAMES, 'footer counts');
        if (record.algorithm !== 'sha256' || typeof record.sha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(record.sha256) || record.sha256 !== digest.digest('hex')) {
          fail('archive integrity hash mismatch');
        }
        if (record.records !== records || TABLE_NAMES.some(table => record.counts[table] !== counts[table])) {
          fail('footer count mismatch');
        }
        if (header === 2 && (record.mediaObjects !== mediaObjects || record.mediaBytes !== mediaBytes)) fail('media count mismatch');
        footer = record;
        continue;
      }
      if (record?.type === 'media') {
        if (header !== 2 || typeof record.id !== 'string' || !/^[a-f0-9]{64}$/.test(record.id) ||
            mediaIds.has(record.id) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 ||
            !Number.isSafeInteger(record.offset) || record.offset !== 0 ||
            typeof record.data !== 'string' || typeof record.final !== 'boolean') fail('invalid media object record');
        mediaStarted = true;
        mediaIds.add(record.id);
        const id = record.id;
        const total = record.bytes;
        let offset = 0;
        const chunks = async function* () {
          let current = item;
          for (;;) {
            exactKeys(current.record, ['type', 'id', 'bytes', 'offset', 'data', 'final'], 'media chunk');
            const part = current.record;
            if (part.type !== 'media' || part.id !== id || part.bytes !== total || part.offset !== offset ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data)) {
              fail('invalid media chunk sequence');
            }
            const bytes = Buffer.from(part.data, 'base64');
            if (bytes.toString('base64') !== part.data || offset + bytes.length > total ||
                part.final !== (offset + bytes.length === total) || bytes.length > MEDIA_CHUNK_BYTES) fail('invalid media chunk length');
            account(current.line);
            offset += bytes.length;
            yield bytes;
            if (part.final) break;
            const next = await read();
            if (!next || next.record.type !== 'media') fail('truncated media object');
            current = next;
          }
        };
        await mediaStore.importStream(chunks(), { id, bytes: total });
        if (offset !== total) fail('media object length mismatch');
        mediaObjects++;
        mediaBytes += total;
        if (!Number.isSafeInteger(mediaBytes)) fail('media archive exceeds the supported byte count');
        continue;
      }
      if (mediaStarted) fail('database rows cannot follow media objects');
      exactKeys(record, ['type', 'table', 'row'], 'record');
      if (record.type !== 'row' || typeof record.table !== 'string' || !Object.hasOwn(SCHEMA, record.table)) {
        fail('illegal record/table');
      }
      const nextIndex = TABLE_NAMES.indexOf(record.table);
      if (nextIndex < tableIndex) fail('invalid table ordering');
      tableIndex = nextIndex;
      validateRow(record.table, record.row);
      digest.update(line);
      const row = portableRow(record.table, record.row, true);
      statements[record.table].run(...columns(record.table).map(name => row[name]));
      counts[record.table]++;
      records++;
      if (records % 128 === 0) await yieldTurn();
    }
  });
  if (header === undefined || !footer) fail('incomplete archive: missing header/footer');
  return counts;
}

/** Import into a new isolated vault; no existing MemoryStore is opened or changed. */
export async function importVault(sourcePath, vaultParent) {
  if (typeof sourcePath !== 'string' || !sourcePath || typeof vaultParent !== 'string' || !vaultParent) {
    fail('source and vault parent paths are required');
  }
  const parent = resolve(vaultParent);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, '.fame-import-'));
  const databasePath = join(temporary, 'memory.sqlite');
  const mediaStore = new MediaStore(temporary);
  let store;
  try {
    store = new MemoryStore(databasePath);
    validateSchema(store.db);
    store.db.exec('BEGIN IMMEDIATE');
    const counts = await loadArchive(resolve(sourcePath), store, mediaStore);
    validateReferences(store.db);
    await validateMediaReferences(store.db, mediaStore);
    store.db.exec('COMMIT');
    store.rebuildIndex();
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    store.close();
    store = undefined;
    syncFile(databasePath);
    const root = join(parent, `vault-${basename(temporary).slice('.fame-import-'.length)}`);
    if (existsSync(root)) fail('new vault path already exists');
    renameSync(temporary, root);
    return { path: join(root, 'memory.sqlite'), root, sessions: counts.sessions };
  } finally {
    try {
      if (store) {
        try { if (store.db.isTransaction) store.db.exec('ROLLBACK'); }
        finally { store.close(); }
      }
    } finally { removeTemporary(temporary, parent, '.fame-import-'); }
  }
}
