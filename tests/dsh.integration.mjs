import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { Session } from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, createUserMessage, expandAssistantStream } from '@deepseek-ai/dsh-llm';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import { MemoryStore } from '../src/memory-store.mjs';
import { exportVault, importVault } from '../src/backup.mjs';
import { createDshAdapter } from '../src/dsh-adapter.mjs';
import { validateSeed, assertClosed, MEMORY_SOURCE } from '../src/dsh-bridge.mjs';

// Real Cordis, SessionStore, AgentLoop, tool pipeline and LlmRuntime. The only
// model backend is this in-process adapter: no credentials, HTTP or paid API.
class MockLlm extends LlmAdapter {
  calls = 0;
  active = 0;
  peak = 0;
  before;
  output;
  constructor({ before, output } = {}) {
    super();
    this.before = before;
    this.output = output;
  }
  async *stream(options) {
    this.calls++;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      options.signal?.throwIfAborted();
      await this.before?.(options);
      options.signal?.throwIfAborted();
      const user = options.messages.findLast(m => m.source?.kind === 'user');
      const prompt = user?.content.find(b => b.type === 'text')?.text ?? '';
      if (prompt === 'model-error') throw new Error('Deliberate mock LLM failure');
      const last = options.messages.at(-1);
      if (prompt === 'use-memory-tool' && last?.role !== 'tool') {
        const id = randomUUID();
        const block = { type: 'tool-call', id, name: 'memory_echo', arguments: '{"text":"tool evidence"}' };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      const text = this.output ? await this.output(prompt, options) : `reply:${prompt}`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally { this.active--; }
  }
}

async function core(mockOptions) {
  const ctx = new Context();
  for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime, SessionProjections, AgentLoop]) {
    await ctx.plugin(plugin, {});
  }
  const mock = new MockLlm(mockOptions);
  ctx.llm.registerAdapter(['test'], mock);
  return { ctx, mock };
}

async function fixture(t, config = {}, mockOptions, store = new MemoryStore(':memory:')) {
  const { ctx, mock } = await core(mockOptions);
  const adapter = createDshAdapter(ctx, store, { provider: 'test', model: 'mock', recallChars: 300, ...config });
  t.after(async () => {
    await adapter.close().catch(() => {});
    await ctx.fiber.dispose();
    store.close();
  });
  return { ctx, mock, adapter, store };
}

function temporaryStore() {
  const parent = resolve(tmpdir());
  const root = mkdtempSync(join(parent, 'fame-dsh-integration-'));
  const cleanup = () => {
    const rel = relative(parent, resolve(root));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(root, { recursive: true, force: true });
  };
  return { path: join(root, 'memory.sqlite'), cleanup };
}

function memoryTool(ctx, execute = async args => ({ text: args.text })) {
  return ctx.tools.register(defineTool({
    name: 'memory_echo', description: 'Integration-test memory tool',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute,
  }));
}

async function collect() {
  assert.equal(typeof global.gc, 'function', 'Run with --expose-gc');
  for (let i = 0; i < 5; i++) {
    await tick();
    global.gc();
  }
  await tick();
}

async function crashWorker(phase, path) {
  const store = new MemoryStore(path);
  const { ctx } = await core();
  memoryTool(ctx, async args => {
    if (phase === 'tool') process.exit(76);
    return { text: args.text };
  });
  const adapter = createDshAdapter(ctx, store, {
    provider: 'test', model: 'mock', recallChars: 0, recentChars: 4000,
    toolAllowlist: ['memory_echo'], summarize: async () => 'Durable checkpoint summary',
  });
  const session = await adapter.create('Crash fixture', { id: 'crash-owned' });
  await adapter.send(session.id, 'before-checkpoint');
  if (phase === 'tool') {
    await adapter.send(session.id, 'use-memory-tool');
    throw new Error('Tool crash point not reached');
  }
  const checkpoint = store.checkpoint.bind(store);
  store.checkpoint = (...args) => {
    const generation = checkpoint(...args);
    if (phase === 'checkpoint') process.exit(73);
    return generation;
  };
  const append = store.appendEvent.bind(store);
  store.appendEvent = (id, generation, event) => {
    const result = append(id, generation, event);
    if (phase === 'seed' && generation === 1 && event.seq === 2) process.exit(74);
    return result;
  };
  await adapter.compact(session.id);
  await adapter.send(session.id, 'after-checkpoint');
  process.exit(75);
}

if (process.argv.includes('--crash-worker')) {
  const index = process.argv.indexOf('--crash-worker');
  await crashWorker(process.argv[index + 1], process.argv[index + 2]);
} else {
  test('real core: archive all events, preserve identity/streams/FAME and recreate the same ID', async t => {
    const { ctx, store, adapter } = await fixture(t, { recentChars: 5000, summarize: async () => 'A short, explicit summary.' });
    const session = await adapter.create('Owned', { id: 'same-id' });
    store.recordFame(session.id, 'user', { mu: 0.6, chi: null }, { evidence: ['explicit fixture'], method: 'test' });
    for (let i = 0; i < 6; i++) assert.equal(await adapter.send(session.id, `message-${i}`), `reply:message-${i}`);
    const before = store.activeEvents(session.id);
    const last = before.findLast(e => e.type === 'assistant/message');
    const fame = store.currentFame(session.id);
    const oldAgent = new WeakRef(ctx.agents.get(session.id));
    const oldSession = new WeakRef(ctx.sessions.get(session.id));
    assert.equal(before.length, ctx.sessions.get(session.id).seq);
    const stats = await adapter.compact(session.id);
    assert.equal(ctx.agents.get(session.id).id, session.id);
    assert.equal(stats.generation, 1);
    assert.ok(stats.after.events < stats.before.events);
    const snapshot = store.snapshot(session.id);
    assert.deepEqual(snapshot.fame, fame);
    const retained = snapshot.runtime.seed.find(e => e.type === 'assistant/message' && e.data.message.id === last.data.message.id);
    assert.ok(retained);
    assert.deepEqual(retained.data.stream, last.data.stream);
    assert.deepEqual(expandAssistantStream(retained.data.stream), expandAssistantStream(last.data.stream));
    assert.deepEqual(snapshot.runtime.origins[retained.seq].original, { generation: 0, seq: last.seq });
    validateSeed(session.id, store.activeEvents(session.id), ctx.sessions.messageProjections);
    assert.ok(store.stats(session.id).events > before.length);
    assert.equal(await adapter.send(session.id, 'after-switch'), 'reply:after-switch');
    await collect();
    assert.equal(Boolean(oldAgent.deref()), false, 'Old Agent must be collectible');
    assert.equal(Boolean(oldSession.deref()), false, 'Old Session must be collectible');
  });

  test('default tools are restricted to memory sessions and stock agents remain untouched', async t => {
    const { ctx, adapter, store } = await fixture(t, { toolAllowlist: ['memory_echo'] });
    memoryTool(ctx);
    ctx.tools.register(defineTool({
      name: 'dangerous_tool', description: 'Must not be visible to owned agents', parameters: {},
      output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
      execute: async () => 'forbidden',
    }));
    const stock = await ctx.agents.create({ sessionId: 'stock-web', agentOptions: { provider: 'test', model: 'mock' } });
    const own = await adapter.create('Owned');
    assert.equal(ctx.tools.schemas(ctx.agents.get(own.id)).some(s => s.name === 'dangerous_tool'), false);
    assert.equal(ctx.tools.schemas(stock.agent).some(s => s.name === 'dangerous_tool'), true);
    assert.equal(await adapter.send(own.id, 'use-memory-tool'), 'reply:use-memory-tool');
    assertClosed(store.activeEvents(own.id));
    assert.ok(store.activeEvents(own.id).some(e => e.type === 'tool/result'));
    await adapter.compact(own.id);
    assertClosed(store.activeEvents(own.id));
    await adapter.close();
    assert.equal(ctx.agents.get('stock-web'), stock.agent);
    await stock.dispose();
  });

  test('bounded FIFO sends serialize one session; busy compaction/unload are refused', async t => {
    const gate = Promise.withResolvers();
    let first = true;
    const { adapter, mock } = await fixture(t, { maxQueuedSends: 2 }, {
      before: async () => { if (first) { first = false; await gate.promise; } },
    });
    const { id } = await adapter.create('Queue');
    const a = adapter.send(id, 'one');
    const b = adapter.send(id, 'two');
    await assert.rejects(adapter.send(id, 'three'), { code: 'QUEUE_FULL' });
    await assert.rejects(adapter.compact(id), { code: 'BUSY' });
    await assert.rejects(adapter.unload(id), { code: 'BUSY' });
    gate.resolve();
    assert.deepEqual(await Promise.all([a, b]), ['reply:one', 'reply:two']);
    assert.equal(mock.peak, 1);
  });

  test('global send concurrency is bounded across owned sessions', async t => {
    const { adapter, mock } = await fixture(t, { maxConcurrentSends: 2 }, { before: () => delay(10) });
    const sessions = [];
    for (let i = 0; i < 5; i++) sessions.push(await adapter.create(`Session ${i}`));
    const replies = await Promise.all(sessions.map((s, i) => adapter.send(s.id, `text-${i}`)));
    assert.equal(replies.length, 5);
    assert.equal(mock.peak, 2);
  });

  test('early session/created events archive the constructor prefix after adapter re-registration', async t => {
    const { ctx, adapter, store } = await fixture(t, { recallChars: 0 });
    const titled = [];
    // Initially later than the adapter; after replacement this listener runs
    // first, as stock profile listeners do after an imported vault is activated.
    ctx.on('session/created', session => {
      if (session.snapshotEvents().some(event => event.type === 'session/title')) return;
      const event = session.append('session/title', {
        title: 'Creation listener title', messageSeqs: [], source: { kind: 'user' },
      });
      titled.push({ id: session.id, seq: event.seq });
    });
    const original = await adapter.create('Before replacement');
    assert.equal(await adapter.send(original.id, 'before replacement'), 'reply:before replacement');
    await adapter.close();
    const replacement = createDshAdapter(ctx, store, {
      provider: 'test', model: 'mock', recallChars: 0, recentChars: 3000,
      summarize: async () => 'A short summary.',
    });
    try {
      const created = await replacement.create('After replacement');
      assert.equal(titled.find(event => event.id === created.id).seq, 1);
      let events = store.activeEvents(created.id);
      assert.deepEqual(events.map(event => [event.seq, event.type]), [[0, 'session/end-seed'], [1, 'session/title']]);
      assert.equal(events.length, ctx.sessions.get(created.id).seq);
      assert.equal(await replacement.send(created.id, 'new session works'), 'reply:new session works');
      const stats = await replacement.compact(created.id);
      assert.equal(stats.generation, 1);
      events = store.activeEvents(created.id);
      assert.equal(events.length, ctx.sessions.get(created.id).seq);
      validateSeed(created.id, events, ctx.sessions.messageProjections);
      assert.equal(await replacement.send(created.id, 'same ID after compact'), 'reply:same ID after compact');
      assert.equal(await replacement.send(original.id, 'existing session works'), 'reply:existing session works');
    } finally { await replacement.close(); }
  });

  test('bootstrap prefix write failures latch before the first live event can be archived', async t => {
    const { ctx, adapter, store } = await fixture(t);
    ctx.on('session/created', session => {
      session.append('session/title', { title: 'Early title', messageSeqs: [], source: { kind: 'user' } });
    });
    await adapter.close();
    const append = store.appendEvent.bind(store);
    store.appendEvent = (id, generation, event) => {
      if (event.seq === 0) throw new Error('Constructor prefix disk failure');
      return append(id, generation, event);
    };
    const replacement = createDshAdapter(ctx, store, { provider: 'test', model: 'mock' });
    try {
      await assert.rejects(replacement.create('Prefix failure', { id: 'prefix-failure' }), error =>
        error.code === 'ARCHIVE_FAILED' && error.cause.message === 'Constructor prefix disk failure');
      assert.equal(store.stats('prefix-failure').events, 0);
      await assert.rejects(replacement.send('prefix-failure', 'must not run'), { code: 'ARCHIVE_FAILED' });
      assert.equal(ctx.sessions.get('prefix-failure'), undefined);
    } finally { await assert.rejects(replacement.close(), AggregateError); }
  });

  test('a real sequence gap after bootstrap is never repaired from the session snapshot', async t => {
    const { ctx, adapter, store, mock } = await fixture(t);
    const { id } = await adapter.create('Real gap');
    const session = ctx.sessions.get(id);
    const before = store.stats(id).events;
    const event = {
      seq: session.seq + 1, time: Date.now(), type: 'session/title',
      data: { title: 'Gap fixture', messageSeqs: [], source: { kind: 'user' } },
    };
    // Session dispatch contains each observer's error independently; projections
    // also reject this gap and must not prevent the archive observer seeing it.
    const observerErrors = [];
    for (const listener of ctx.events.dispatch('emit', ['session/event', session, event])) {
      try { await listener(session, event); }
      catch (error) { observerErrors.push(error); }
    }
    assert.ok(observerErrors.some(error => /missing seq/.test(error.message)));
    await assert.rejects(adapter.send(id, 'blocked'), error =>
      error.code === 'ARCHIVE_FAILED' && error.cause.code === 'ARCHIVE_GAP');
    await assert.rejects(adapter.compact(id), { code: 'ARCHIVE_FAILED' });
    assert.equal(store.stats(id).events, before);
    assert.equal(mock.calls, 0);
  });

  test('archive observer failures latch: current send, later input and switches fail closed', async t => {
    const { adapter, store, ctx } = await fixture(t);
    const { id } = await adapter.create('Archive failure');
    const append = store.appendEvent.bind(store);
    store.appendEvent = (sessionId, generation, event) => {
      if (event.type === 'user/message') throw new Error('Disk full fixture');
      return append(sessionId, generation, event);
    };
    await assert.rejects(adapter.send(id, 'must not report success'), { code: 'ARCHIVE_FAILED' });
    const generation = store.getSession(id).generation;
    await assert.rejects(adapter.send(id, 'retry'), { code: 'ARCHIVE_FAILED' });
    await assert.rejects(adapter.compact(id), { code: 'ARCHIVE_FAILED' });
    await assert.rejects(adapter.unload(id), { code: 'ARCHIVE_FAILED' });
    assert.equal(store.getSession(id).generation, generation);
    assert.ok(ctx.agents.get(id));
    await assert.rejects(adapter.close(), AggregateError);
  });

  test('checkpoint failure keeps the old handle; invalid summaries never switch', async t => {
    let invalid = true;
    const { adapter, store, ctx } = await fixture(t, { summarize: async () => invalid ? '' : 'Valid summary' });
    const { id } = await adapter.create('Atomic switch');
    await adapter.send(id, 'saved');
    const original = ctx.agents.get(id);
    await assert.rejects(adapter.compact(id), { code: 'INVALID_SUMMARY' });
    assert.equal(ctx.agents.get(id), original);
    assert.equal(store.getSession(id).generation, 0);
    invalid = false;
    store.checkpoint = () => { throw new Error('Transaction rollback fixture'); };
    await assert.rejects(adapter.compact(id), { code: 'ARCHIVE_FAILED' });
    assert.equal(ctx.agents.get(id), original);
    assert.equal(store.getSession(id).generation, 0);
    assert.equal(await adapter.close().then(() => false, () => true), true);
  });

  test('model failure is reported and never passed to afterTurn; annotation failure is retryable', async t => {
    let fail = true;
    let annotations = 0;
    const received = [];
    const { adapter, store, mock } = await fixture(t, {
      afterTurn: async (sessionId, userText, assistantText) => {
        received.push([sessionId, userText, assistantText]);
        annotations++;
        if (fail) throw new Error('Annotation model unavailable');
      },
    });
    const { id } = await adapter.create('Annotations');
    await assert.rejects(adapter.send(id, 'model-error'), { code: 'LLM_FAILED' });
    assert.equal(annotations, 0);
    let annotationError;
    await assert.rejects(adapter.send(id, 'record this'), error => {
      annotationError = error;
      return error.code === 'ANNOTATION_FAILED' && error.saved && error.assistantText === 'reply:record this';
    });
    assert.ok(store.transcript(id).some(e => e.text === 'reply:record this'));
    const original = store.activeEvents(id).findLast(event => event.type === 'assistant/message');
    assert.deepEqual(annotationError.annotation.reference, {
      generation: 0, seq: original.seq, messageId: original.data.message.id,
    });
    const calls = mock.calls;
    fail = false;
    assert.deepEqual(await adapter.retryAnnotation(id, annotationError.annotation), { updated: true });
    assert.equal(mock.calls, calls);
    assert.deepEqual(received, Array.from({ length: 2 }, () => [id, 'record this', 'reply:record this']),
      'A three-argument afterTurn callback remains compatible');
  });

  test('recall is bounded and identified; auto-compaction and unload recovery remain bounded', async t => {
    const { adapter, store, ctx } = await fixture(t, {
      maxActiveEvents: 50, maxActiveChars: 14000, recentChars: 2500,
      recallChars: 200, summaryChars: 600,
    });
    const recalls = [];
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'user/message' && event.data.source?.kind === MEMORY_SOURCE && event.data.source.purpose === 'recall') {
        recalls.push({ id: event.data.id, role: event.data.role, chars: event.data.content[0].text.length });
      }
    });
    const { id } = await adapter.create('Auto');
    store.addMemory(id, { text: 'recalled fixture '.repeat(100) });
    for (let i = 0; i < 12; i++) await adapter.send(id, `recalled fixture ${i}`);
    assert.ok(store.getSession(id).generation > 0);
    assert.ok(store.stats(id).activeEvents <= 50);
    await adapter.unload(id);
    assert.equal(ctx.agents.get(id), undefined);
    assert.equal(await adapter.send(id, 'recalled fixture after unload'), 'reply:recalled fixture after unload');
    validateSeed(id, store.activeEvents(id), ctx.sessions.messageProjections);
    assert.ok(recalls.length);
    assert.ok(recalls.every(e => e.id && e.role === 'user' && e.chars <= 200));
  });

  test('repeated annotation failures still compact and never grow the working epoch indefinitely', async t => {
    let annotations = 0;
    const { adapter, store } = await fixture(t, {
      maxActiveEvents: 8, maxActiveChars: 6000, recentChars: 1, recallChars: 0,
      summarize: async () => 'Previous turns are durably archived.',
      afterTurn: async () => { annotations++; throw new Error('Annotation unavailable'); },
    });
    const { id } = await adapter.create('Repeated annotation failure');
    for (let i = 0; i < 12; i++) {
      await assert.rejects(adapter.send(id, `saved-${i}`), error =>
        error.code === 'ANNOTATION_FAILED' && error.saved === true && error.assistantText === `reply:saved-${i}`);
      assert.ok(store.activeEvents(id).length <= 8);
    }
    assert.equal(annotations, 12);
    assert.equal(store.getSession(id).generation, 12);
    assert.equal(store.transcript(id, Number.MAX_SAFE_INTEGER, 100).length, 24);
  });

  test('summary failure reports saved; the next inputs cannot add events until reduction succeeds', async t => {
    let fail = true;
    const { adapter, store, mock } = await fixture(t, {
      maxActiveEvents: 8, recentChars: 1, recallChars: 0,
      summarize: async () => { if (fail) throw new Error('Summary unavailable'); return 'Recovered summary'; },
    });
    const { id } = await adapter.create('Hard limit');
    await assert.rejects(adapter.send(id, 'already saved'), error =>
      error.code === 'COMPACTION_FAILED' && error.saved === true && error.assistantText === 'reply:already saved');
    const before = store.activeEvents(id);
    const calls = mock.calls;
    for (let i = 0; i < 3; i++) {
      await assert.rejects(adapter.send(id, 'must not be accepted'), error =>
        error.message === 'Summary unavailable' && !error.saved);
    }
    const queued = await Promise.allSettled([adapter.send(id, 'queued-one'), adapter.send(id, 'queued-two')]);
    assert.ok(queued.every(result => result.status === 'rejected' && !result.reason.saved));
    assert.deepEqual(store.activeEvents(id), before);
    assert.equal(mock.calls, calls);
    fail = false;
    assert.equal(await adapter.send(id, 'resume after repair'), 'reply:resume after repair');
    assert.ok(store.activeEvents(id).length <= 8);
  });

  test('annotation and compaction failures both remain visible on a saved turn', async t => {
    const { adapter, store } = await fixture(t, {
      maxActiveEvents: 8, recentChars: 1, recallChars: 0,
      summarize: async () => { throw new Error('Summary service unavailable'); },
      afterTurn: async () => { throw new Error('Annotation service unavailable'); },
    });
    const { id } = await adapter.create('Two warnings');
    await assert.rejects(adapter.send(id, 'save once'), error =>
      error.code === 'ANNOTATION_FAILED' && error.saved === true &&
      error.compactionError.message === 'Summary service unavailable');
    const before = store.stats(id).events;
    await assert.rejects(adapter.send(id, 'blocked'), /Summary service unavailable/);
    assert.equal(store.stats(id).events, before);
  });

  test('post-turn archive failures report saved without marking subsequent rejected inputs as saved', async t => {
    let ctx;
    const f = await fixture(t, {
      afterTurn: async id => { ctx.sessions.get(id).append('test/post-turn', {}); },
    });
    ctx = f.ctx;
    const { id } = await f.adapter.create('Post-turn latch');
    const append = f.store.appendEvent.bind(f.store);
    f.store.appendEvent = (sessionId, generation, event) => {
      if (event.type === 'test/post-turn') throw new Error('Post-turn disk failure');
      return append(sessionId, generation, event);
    };
    await assert.rejects(f.adapter.send(id, 'reply is saved'), error =>
      error.code === 'ARCHIVE_FAILED' && error.saved === true && error.assistantText === 'reply:reply is saved');
    assert.ok(f.store.transcript(id).some(event => event.text === 'reply:reply is saved'));
    await assert.rejects(f.adapter.send(id, 'not saved'), error => error.code === 'ARCHIVE_FAILED' && !error.saved);
    await assert.rejects(f.adapter.close(), AggregateError);
  });

  test('an observer failure after the completed turn was archived still reports saved', async t => {
    const { adapter, ctx, store } = await fixture(t);
    const { id } = await adapter.create('Completed before late failure');
    const append = store.appendEvent.bind(store);
    store.appendEvent = (sessionId, generation, event) => {
      if (event.type === 'test/late-event') throw new Error('Late lifecycle archive failure');
      return append(sessionId, generation, event);
    };
    ctx.on('agent/status', ({ agent, status }) => {
      if (agent.id === id && status === 'idle') agent.session.append('test/late-event', {});
    });
    await assert.rejects(adapter.send(id, 'completed'), error =>
      error.code === 'ARCHIVE_FAILED' && error.saved === true && error.assistantText === 'reply:completed');
    assert.ok(store.activeEvents(id).some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'));
    await assert.rejects(adapter.send(id, 'new input'), error => error.code === 'ARCHIVE_FAILED' && !error.saved);
  });

  test('annotation retry after restart derives the archived pair even when compaction retained no turns', async t => {
    const { adapter, store, ctx, mock } = await fixture(t, {
      maxActiveEvents: 8, recentChars: 1, recallChars: 0,
      summarize: async () => 'Archived conversation.',
      afterTurn: async () => { throw new Error('Annotation unavailable'); },
    });
    const { id } = await adapter.create('Retry on restart');
    let reference;
    await assert.rejects(adapter.send(id, 'pending annotation'), error => {
      reference = error.annotation.reference;
      return error.code === 'ANNOTATION_FAILED' && error.saved === true;
    });
    assert.equal(store.snapshot(id).recent.length, 0);
    await adapter.close();
    const calls = mock.calls;
    const extracted = [];
    const restarted = createDshAdapter(ctx, store, {
      provider: 'test', model: 'mock', afterTurn: async (...args) => { extracted.push(args); },
    });
    try {
      assert.deepEqual(await restarted.retryAnnotation(id), { updated: true });
      assert.equal(extracted.length, 1);
      assert.equal(extracted[0].length, 4);
      assert.deepEqual(extracted[0].slice(0, 3), [id, 'pending annotation', 'reply:pending annotation']);
      assert.equal(extracted[0][3].generation, reference.generation);
      assert.equal(extracted[0][3].seq, reference.seq);
      assert.equal(ctx.agents.get(id), undefined, 'Annotation recovery does not load an Agent');
      assert.equal(mock.calls, calls, 'Annotation retry must not resend chat');
      assert.equal(await restarted.send(id, 'continue'), 'reply:continue');
    } finally { await restarted.close(); }
  });

  test('annotation references survive compaction, duplicate replies, callback mutation and restart', async t => {
    let fail = true;
    const calls = [];
    const { adapter, store, ctx, mock } = await fixture(t, {
      maxActiveEvents: 8, recentChars: 1, recallChars: 0,
      summarize: async () => 'Conversation retained in the archive.',
      afterTurn: async (id, userText, assistantText, reference) => {
        calls.push({ id, userText, assistantText, reference: { ...reference } });
        if (fail) {
          reference.seq = 999999;
          throw new Error('Annotation unavailable');
        }
      },
    }, { output: () => 'same reply' });
    const { id } = await adapter.create('Stable references');
    let saved;
    await assert.rejects(adapter.send(id, 'original user'), error => {
      saved = JSON.parse(JSON.stringify(error.annotation));
      return error.code === 'ANNOTATION_FAILED';
    });
    assert.equal(store.getSession(id).generation, 1);
    assert.equal(store.snapshot(id).recent.length, 0);
    const original = JSON.parse(store.db.prepare('SELECT json FROM events WHERE session_id=? AND generation=? AND seq=?')
      .get(id, saved.reference.generation, saved.reference.seq).json);
    assert.equal(original.type, 'assistant/message');
    assert.equal(original.data.message.id, saved.reference.messageId);
    assert.deepEqual(saved.reference, calls[0].reference, 'Callback mutation must not alter the retained reference');
    await assert.rejects(adapter.retryAnnotation(id), error =>
      error.code === 'ANNOTATION_FAILED' && error.annotation.reference.seq === saved.reference.seq);
    assert.deepEqual(calls[1].reference, saved.reference, 'The in-memory pending annotation keeps its original epoch');
    fail = false;
    assert.equal(await adapter.send(id, 'newer user'), 'same reply');
    const newer = calls.at(-1).reference;
    assert.equal(newer.generation, 1);
    assert.notEqual(newer.messageId, saved.reference.messageId);
    assert.equal(store.getSession(id).generation, 2);
    await adapter.close();
    const modelCalls = mock.calls;
    const retried = [];
    const restarted = createDshAdapter(ctx, store, {
      provider: 'test', model: 'mock',
      afterTurn: async (...args) => { retried.push(args); },
    });
    try {
      assert.deepEqual(await restarted.retryAnnotation(id, saved), { updated: true });
      assert.deepEqual(retried[0], [id, 'original user', 'same reply', saved.reference]);
      assert.deepEqual(await restarted.retryAnnotation(id), { updated: true });
      assert.deepEqual(retried[1].slice(0, 3), [id, 'newer user', 'same reply']);
      assert.equal(retried[1][3].generation, newer.generation);
      assert.equal(retried[1][3].seq, newer.seq);
      assert.equal(mock.calls, modelCalls, 'Reference-based retries never regenerate chat replies');
    } finally { await restarted.close(); }
  });

  test('legacy annotation retries match both texts uniquely and reject ambiguous or malformed references', async t => {
    const annotated = [];
    const { adapter, store, mock } = await fixture(t, {
      recentChars: 12000,
      afterTurn: async (...args) => { annotated.push(args); },
    }, { output: () => 'same reply' });
    const { id } = await adapter.create('Legacy retries');
    for (const text of ['repeat user', 'unique user', 'repeat user']) await adapter.send(id, text);
    const expected = annotated[1][3];
    await adapter.compact(id);
    const calls = mock.calls;
    const before = annotated.length;
    await assert.rejects(adapter.retryAnnotation(id, { userText: 'repeat user', assistantText: 'same reply' }),
      { code: 'ANNOTATION_AMBIGUOUS' });
    await assert.rejects(adapter.retryAnnotation(id, { userText: 'absent user', assistantText: 'same reply' }),
      { code: 'ANNOTATION_REFERENCE_REQUIRED' });
    await assert.rejects(adapter.retryAnnotation(id, {
      userText: 'unique user', assistantText: 'same reply', reference: { generation: -1, seq: 1 },
    }), { code: 'INVALID_ANNOTATION_REFERENCE' });
    assert.equal(annotated.length, before);
    assert.deepEqual(await adapter.retryAnnotation(id, { userText: 'unique user', assistantText: 'same reply' }), { updated: true });
    assert.deepEqual(annotated.at(-1).slice(0, 3), [id, 'unique user', 'same reply']);
    assert.equal(annotated.at(-1)[3].generation, expected.generation);
    assert.equal(annotated.at(-1)[3].seq, expected.seq);
    assert.ok(store.getSession(id).generation > expected.generation, 'Legacy resolution uses the original, not copied, event position');
    assert.equal(mock.calls, calls);
  });

  test('legacy resolution is bounded while an explicit reference can retry an older archived pair', async t => {
    let first;
    let count = 0;
    const { adapter, store, mock } = await fixture(t, {
      maxActiveEvents: 10000, maxActiveChars: 10000000, recallChars: 0,
      afterTurn: async (_id, userText, assistantText, reference) => {
        count++;
        first ??= { userText, assistantText, reference };
      },
    });
    const { id } = await adapter.create('Bounded retry lookup');
    for (let i = 0; i < 52; i++) await adapter.send(id, `bounded-pair-${i}`);
    const transcript = store.transcript.bind(store);
    let limit;
    store.transcript = (sessionId, before, requested) => {
      limit = requested;
      return transcript(sessionId, before, requested);
    };
    await assert.rejects(adapter.retryAnnotation(id, { userText: first.userText, assistantText: first.assistantText }),
      { code: 'ANNOTATION_REFERENCE_REQUIRED' });
    assert.equal(limit, 100);
    assert.equal(count, 52);
    const calls = mock.calls;
    assert.deepEqual(await adapter.retryAnnotation(id, first), { updated: true });
    assert.equal(count, 53);
    assert.equal(mock.calls, calls);
  });

  test('idle LRU limits live handles, releases objects and rehydrates the least recently used session', async t => {
    const { adapter, store, ctx } = await fixture(t, { maxLoadedSessions: 2, recallChars: 0 });
    const sessions = [];
    const weak = [];
    const live = new Set();
    let peak = 0;
    ctx.on('session/created', session => { live.add(session.id); peak = Math.max(peak, live.size); });
    ctx.on('session/disposed', session => { live.delete(session.id); });
    await collect();
    const beforeHeap = process.memoryUsage().heapUsed;
    for (let i = 0; i < 24; i++) {
      const session = await adapter.create(`Idle ${i}`);
      sessions.push(session);
      await adapter.send(session.id, `idle-${i}: ${randomBytes(1000).toString('hex')}`);
      weak.push(new WeakRef(ctx.agents.get(session.id)));
      assert.ok(live.size <= 2);
    }
    await collect();
    const afterHeap = process.memoryUsage().heapUsed;
    assert.equal(weak.filter(ref => Boolean(ref.deref())).length, 2);
    assert.equal(peak, 2);
    assert.ok(afterHeap - beforeHeap < 2000000, 'Unloaded histories must not remain in the adapter rows map');
    const first = sessions[0].id;
    const events = store.stats(first).events;
    assert.equal(await adapter.send(first, 'after LRU'), 'reply:after LRU');
    assert.ok(store.stats(first).events > events);
    assert.ok(live.size <= 2);
    await adapter.unload(first);
    assert.equal(ctx.agents.get(first), undefined);
    assert.equal(await adapter.send(first, 'after explicit unload'), 'reply:after explicit unload');
    t.diagnostic(JSON.stringify({ lruSessions: sessions.length, peakLoaded: peak, beforeHeap, afterHeap, collectedAgents: 22 }));
  });

  test('busy handles cannot be evicted to admit another session', async t => {
    const entered = Promise.withResolvers();
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    const { adapter, ctx } = await fixture(t, { maxLoadedSessions: 1 }, {
      before: async () => { entered.resolve(); await gate.promise; },
    });
    const first = await adapter.create('Busy');
    const reply = adapter.send(first.id, 'working');
    await entered.promise;
    await assert.rejects(adapter.create('Must wait', { id: 'capacity-waiting' }), { code: 'CAPACITY' });
    assert.ok(ctx.agents.get(first.id));
    gate.resolve();
    assert.equal(await reply, 'reply:working');
    assert.equal(await adapter.send('capacity-waiting', 'now idle'), 'reply:now idle');
    assert.equal(ctx.agents.get(first.id), undefined);
  });

  test('same-ID replacement reserves its loaded slot while another creation is waiting', async t => {
    const entered = Promise.withResolvers();
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    let creates = 0;
    const { adapter, ctx } = await fixture(t, {
      maxLoadedSessions: 1,
      setup: async (_ctx, agent) => {
        if (agent.id === 'reserved' && ++creates === 2) { entered.resolve(); await gate.promise; }
      },
    });
    await adapter.create('Reserve', { id: 'reserved' });
    await adapter.send('reserved', 'before replacement');
    const live = new Set(['reserved']);
    let peak = 1;
    ctx.on('session/created', session => { live.add(session.id); peak = Math.max(peak, live.size); });
    ctx.on('session/disposed', session => { live.delete(session.id); });
    const switching = adapter.compact('reserved');
    await entered.promise;
    const creation = adapter.create('Concurrent load', { id: 'other-load' }).then(value => ({ value }), error => ({ error }));
    await tick();
    assert.equal(ctx.agents.get('other-load'), undefined);
    gate.resolve();
    await switching;
    const result = await creation;
    if (result.error) assert.equal(result.error.code, 'CAPACITY');
    assert.equal(peak, 1);
    assert.equal(await adapter.send('other-load', 'eventual load'), 'reply:eventual load');
    assert.equal(peak, 1);
  });

  test('close aborts an in-progress summary and waits for owned handles to be released', async t => {
    const entered = Promise.withResolvers();
    const { adapter, ctx, store } = await fixture(t, {
      summarize: async ({ signal }) => {
        entered.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const { id } = await adapter.create('Shutdown');
    await adapter.send(id, 'before shutdown');
    const pending = adapter.compact(id);
    const rejected = assert.rejects(pending, { code: 'CLOSED' });
    await entered.promise;
    await adapter.close();
    await rejected;
    assert.equal(store.getSession(id).generation, 0);
    assert.equal(ctx.agents.get(id), undefined);
    assert.equal(ctx.sessions.get(id), undefined);
  });

  test('backup restores ownership, epochs and FAME and then continues a real AgentLoop conversation', async t => {
    const { path, cleanup } = temporaryStore();
    const original = await fixture(t, { summarize: async () => 'Portable conversation summary', recentChars: 3000 }, undefined, new MemoryStore(path));
    let restored;
    try {
      const { id } = await original.adapter.create('Portable', { id: 'backup-owned' });
      original.store.recordFame(id, 'agent', { rho: 0.7 }, { method: 'test', evidence: ['portable fixture'] });
      await original.adapter.send(id, 'before backup');
      await original.adapter.compact(id);
      await original.adapter.send(id, 'active epoch before export');
      const stats = original.store.stats(id);
      const fame = original.store.currentFame(id);
      const archive = join(resolve(path, '..'), 'test.fame.gz');
      await exportVault(original.store, archive);
      const imported = await importVault(archive, join(resolve(path, '..'), 'vaults'));
      restored = await fixture(t, {}, undefined, new MemoryStore(imported.path));
      assert.equal(restored.store.getSession(id).options.owner, 'fame-dsh-memory/v1');
      assert.equal(restored.store.getSession(id).options.agentOptions.provider, 'test');
      assert.equal(restored.store.stats(id).events, stats.events);
      assert.deepEqual(restored.store.currentFame(id), fame);
      assert.equal(await restored.adapter.send(id, 'continue after import'), 'reply:continue after import');
      assert.ok(restored.store.stats(id).events > stats.events);
      assert.equal(restored.ctx.agents.get(id).id, id);
      validateSeed(id, restored.store.activeEvents(id), restored.ctx.sessions.messageProjections);
      assert.ok(restored.store.transcript(id).some(event => event.text === 'before backup'));
      assert.ok(restored.store.transcript(id).some(event => event.text === 'reply:continue after import'));
      assert.equal(original.store.stats(id).events, stats.events, 'The source vault is independent of the restored conversation');
    } finally { t.after(cleanup); }
  });

  for (const phase of ['checkpoint', 'seed', 'active', 'tool']) {
    test(`actual crash recovery at ${phase}: snapshot plus immutable active events`, async t => {
      const { path, cleanup } = temporaryStore();
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--crash-worker', phase, path], {
        encoding: 'utf8', timeout: 30000, windowsHide: true,
      });
      assert.equal(child.status, { checkpoint: 73, seed: 74, active: 75, tool: 76 }[phase], child.stderr);
      const store = new MemoryStore(path);
      const { adapter, ctx } = await fixture(t, { toolAllowlist: ['memory_echo'] }, undefined, store);
      t.after(cleanup);
      let dispatched = 0;
      memoryTool(ctx, async args => { dispatched++; return { text: args.text }; });
      const before = store.stats('crash-owned');
      assert.equal(await adapter.send('crash-owned', 'recovered'), 'reply:recovered');
      assert.equal(dispatched, 0, 'An interrupted tool must never be silently executed again');
      const active = store.activeEvents('crash-owned');
      validateSeed('crash-owned', active, ctx.sessions.messageProjections);
      assertClosed(active);
      assert.ok(store.stats('crash-owned').events > before.events);
      assert.equal(ctx.agents.get('crash-owned').id, 'crash-owned');
      if (phase !== 'tool') {
        assert.equal(store.snapshot('crash-owned').summary, 'Durable checkpoint summary');
        assert.ok(active.length < 80, 'Recovery must load only the active epoch');
      } else {
        assert.ok(active.some(e => e.type === 'tool/result' && e.data.message.isError));
      }
    });
  }

  test('real heap measurement: a long working log is released after same-ID replacement', async t => {
    const { adapter, store, ctx } = await fixture(t, {
      maxActiveEvents: 100000, maxActiveChars: 100000000, recentChars: 3000,
      recallChars: 0, summarize: async () => 'Large fixture archived; keep the most recent complete turn.',
    }, { output: prompt => prompt === 'small tail' ? 'small response' : randomBytes(12000).toString('hex') });
    const { id } = await adapter.create('Heap');
    for (let i = 0; i < 70; i++) await adapter.send(id, `large-${i}: ${randomBytes(4000).toString('hex')}`);
    await adapter.send(id, 'small tail');
    const old = {
      agent: new WeakRef(ctx.agents.get(id)),
      session: new WeakRef(ctx.sessions.get(id)),
    };
    await collect();
    const beforeHeap = process.memoryUsage().heapUsed;
    const beforeArchive = store.stats(id);
    const result = await adapter.compact(id);
    await collect();
    const afterHeap = process.memoryUsage().heapUsed;
    assert.equal(Boolean(old.agent.deref()), false);
    assert.equal(Boolean(old.session.deref()), false);
    assert.ok(result.after.events < 25);
    assert.ok(store.stats(id).events >= beforeArchive.events);
    assert.ok(afterHeap < beforeHeap - 1000000, `Expected >1 MB reclaimed: before=${beforeHeap}, after=${afterHeap}`);
    t.diagnostic(JSON.stringify({
      beforeHeap, afterHeap, reclaimedBytes: beforeHeap - afterHeap,
      beforeEvents: result.before.events, afterEvents: result.after.events,
      archiveBytes: store.stats(id).archiveBytes,
      oldAgentCollected: true, oldSessionCollected: true,
    }));
    await adapter.unload(id);
    await adapter.send(id, 'bounded recovery');
    assert.ok(store.activeEvents(id).length < 50);
    assert.ok(ctx.sessions.get(id) instanceof Session);
  });
}
