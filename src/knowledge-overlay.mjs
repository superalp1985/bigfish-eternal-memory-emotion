import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { FAME_KEYS, FAME_SCHEMA, FAME_DEFINITIONS, FAME_MEANINGS, validateFame } from './fame.mjs';
import { hash } from './memory-store.mjs';

const unknown = () => validateFame({});
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const parse = value => { try { return object(JSON.parse(value)); } catch { return {}; } };
const key = (sessionId, type, id) => `fame:${hash(`${sessionId}:${type}:${id}`).slice(0, 32)}`;

function mean(vectors) {
  return Object.fromEntries(FAME_KEYS.map(dimension => {
    const values = vectors.map(vector => vector?.[dimension]).filter(Number.isFinite);
    return [dimension, values.length ? values.reduce((a, b) => a + b, 0) / values.length : null];
  }));
}

function emotion(source) {
  const participants = {};
  for (const actor of ['user', 'agent']) {
    const state = source?.fame_schema === FAME_SCHEMA ? source?.fame?.[actor] : null;
    participants[actor] = state ? {
      vector: validateFame(state.vector),
      confidence: state.confidence ?? null, method: state.method ?? 'unknown',
      state_id: state.state_id ?? state.id ?? null,
    } : { vector: unknown(), confidence: null, method: 'unknown', state_id: null };
  }
  return {
    fame_schema: FAME_SCHEMA,
    fame: mean(Object.values(participants).map(state => state.vector)),
    fame_participants: participants,
    fame_aggregation: 'mean-of-observed-participant-coordinates',
  };
}

function historicalEmotion(store, sessionId, source) {
  if (source.fame_schema !== FAME_SCHEMA) return emotion({});
  const fame = {};
  for (const actor of ['user', 'agent']) {
    const id = source.fame?.[actor]?.state_id;
    if (typeof id !== 'string') continue;
    const state = store.db.prepare('SELECT * FROM fame_states WHERE id=? AND session_id=? AND actor=?').get(id, sessionId, actor);
    if (state) fame[actor] = { ...state, vector: parse(state.vector) };
  }
  return emotion({ fame_schema: FAME_SCHEMA, fame });
}

function sources(sessionId, source) {
  const references = Array.isArray(source.refs) ? source.refs :
    (Array.isArray(source.seqs) ? source.seqs : source.seq == null ? [] : [source.seq]).map(seq => ({ generation: source.generation, seq }));
  return references.slice(0, 12).filter(ref => ref &&
    Number.isSafeInteger(ref.generation) && ref.generation >= 0 && Number.isSafeInteger(ref.seq) && ref.seq >= 0)
    .map(ref => ({ type: 'conversation_event', session_id: sessionId, generation: ref.generation, seq: ref.seq }));
}

export function createOverlay(store, sessionId, { after = 0, limit = 200, route } = {}) {
  const session = store.getSession(sessionId);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid graph page');
  if (route !== undefined && (typeof route !== 'string' || route.length > 200)) throw new Error('Invalid route');
  const rows = route === undefined
    ? store.db.prepare('SELECT rowid AS cursor,* FROM memories WHERE session_id=? AND rowid>? ORDER BY rowid LIMIT ?').all(sessionId, after, limit + 1)
    : store.db.prepare('SELECT rowid AS cursor,* FROM memories WHERE session_id=? AND route=? AND rowid>? ORDER BY rowid LIMIT ?').all(sessionId, route, after, limit + 1);
  const hasMore = rows.length > limit;
  rows.length = Math.min(rows.length, limit);
  const participantStates = store.currentFame(sessionId);
  const current = emotion({ fame_schema: FAME_SCHEMA, fame: participantStates });
  const rootId = key(sessionId, 'session', sessionId);
  const nodes = [{ id: rootId, type: 'ConversationSession', title: session.title, session_id: sessionId, ...current }];
  const edges = [];
  const routes = new Map();
  const byMemory = new Map();
  for (const row of rows) {
    const source = parse(row.source);
    const state = historicalEmotion(store, sessionId, source);
    const id = key(sessionId, 'memory', row.id);
    byMemory.set(row.id, id);
    const routeId = key(sessionId, 'route', row.route);
    if (!routes.has(row.route)) routes.set(row.route, { routeId, states: [], members: [] });
    const group = routes.get(row.route);
    group.states.push(state);
    group.members.push(id);
    nodes.push({
      id, memory_id: row.id, type: 'ConversationMemory', session_id: sessionId, route_id: routeId,
      title: row.text.slice(0, 120), text: row.text.slice(0, 6000),
      text_truncated: row.text.length > 6000, source_refs: sources(sessionId, source),
      created_at: row.created_at, ...state, routing_metrics: { importance: row.importance },
    });
    edges.push({
      id: key(sessionId, 'membership', row.id), source: routeId, target: id,
      relation: 'contains_memory', session_id: sessionId, ...state,
      source_refs: sources(sessionId, source), routing_metrics: { importance: row.importance },
    });
  }
  const routeRecords = [...routes.entries()].map(([name, group]) => {
    const fame = mean(group.states.map(state => state.fame));
    const fame_participants = Object.fromEntries(['user', 'agent'].map(actor => [actor, {
      vector: mean(group.states.map(state => state.fame_participants[actor].vector)),
      method: 'page-coordinate-mean', confidence: null,
    }]));
    const entry = {
      id: group.routeId, route_id: group.routeId, type: 'ConversationRoute', name,
      session_id: sessionId, member_ids: group.members,
      fame_schema: FAME_SCHEMA, fame, fame_participants,
      fame_aggregation: 'page-mean-of-observed-coordinates',
      routing_metrics: { page_memory_count: group.members.length, aggregate_scope: 'page' },
    };
    nodes.push(entry);
    edges.push({
      id: key(sessionId, 'route-membership', name), source: rootId, target: group.routeId,
      relation: 'contains_route', session_id: sessionId, fame_schema: FAME_SCHEMA, fame,
      fame_participants, fame_aggregation: entry.fame_aggregation, routing_metrics: entry.routing_metrics,
    });
    return entry;
  });
  // Explicit relation records are projected only when both ends are on this page.
  if (byMemory.size) {
    const ids = [...byMemory.keys()];
    const marks = ids.map(() => '?').join(',');
    const related = store.db.prepare(`SELECT * FROM edges WHERE session_id=? AND source IN (${marks}) LIMIT 200`)
      .all(sessionId, ...ids);
    for (const row of related) {
      if (!byMemory.has(row.target)) continue;
      const source = nodes.find(node => node.id === byMemory.get(row.source));
      edges.push({
        id: key(sessionId, 'relation', row.id), session_id: sessionId,
        source: byMemory.get(row.source), target: byMemory.get(row.target), relation: row.relation,
        fame_schema: FAME_SCHEMA, fame: source.fame, fame_participants: source.fame_participants,
        fame_aggregation: 'source-memory-coordinates', routing_metrics: {},
      });
    }
  }
  return {
    format: 'fame-conversation-overlay/v1',
    manifest: {
      project_id: `fame-session-${hash(sessionId).slice(0, 24)}`, project_name: session.title,
      session_id: sessionId, visibility: 'private', fame_schema: FAME_SCHEMA,
      fame_definitions: FAME_DEFINITIONS, fame_meanings: FAME_MEANINGS,
      memory_policy: { core_write_allowed: false, canonical_store: 'sqlite', recovery: 'bounded-working-generation' },
      legacy_fame_compatible: false,
      paper_revision: '2140f0cfed04041cd4f1e18eff511493d2fc2adb',
    },
    nodes, edges, routes: routeRecords,
    completeness: { full_archive: false, raw_events_included: false, relation_edges: 'bounded-page-local' },
    pagination: { after, next: hasMore ? rows.at(-1).cursor : null, has_more: hasMore, limit, memory_count: rows.length },
  };
}

export function writeOverlay(store, sessionId, destination, options = {}) {
  const overlay = createOverlay(store, sessionId, options);
  mkdirSync(destination);
  const files = {
    'project_manifest.json': JSON.stringify({ ...overlay.manifest, pagination: overlay.pagination }, null, 2),
    'project_graph.jsonl': overlay.nodes.map(x => JSON.stringify(x)).join('\n') + '\n',
    'project_edges.jsonl': overlay.edges.map(x => JSON.stringify(x)).join('\n') + '\n',
    'route_memory.jsonl': overlay.routes.map(x => JSON.stringify(x)).join('\n') + '\n',
    'fame_overlay.jsonl': overlay.edges.map(x => JSON.stringify({
      edge_id: x.id, fame_schema: x.fame_schema, fame: x.fame,
      fame_participants: x.fame_participants, routing_metrics: x.routing_metrics,
    })).join('\n') + '\n',
  };
  for (const [name, text] of Object.entries(files)) {
    const path = join(destination, name);
    writeFileSync(`${path}.tmp`, text, { flush: true });
    renameSync(`${path}.tmp`, path);
  }
  return { path: destination, ...overlay.pagination };
}
