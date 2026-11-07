import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MemoryStore } from '../src/memory-store.mjs';
import { MediaStore } from '../src/media-store.mjs';
import { exportVault, importVault } from '../src/backup.mjs';
import { createWorkBuddyRuntime } from '../src/workbuddy/runtime.mjs';

const projectRoot = resolve(import.meta.dirname, '..');

function fixture(t) {
  const root = mkdtempSync(join(import.meta.dirname, '.workbuddy-'));
  const dataDir = join(root, 'data');
  const projects = join(root, 'projects');
  mkdirSync(projects, { recursive: true });
  const runtime = createWorkBuddyRuntime({ dataDir });
  t.after(() => {
    try { runtime.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, projects, runtime };
}

function transcriptFixture(t, { invalid = false } = {}) {
  const f = fixture(t);
  const sessionId = 'session-workbuddy-1';
  const transcriptPath = join(f.projects, 'project', `${sessionId}.jsonl`);
  mkdirSync(dirname(transcriptPath), { recursive: true });
  const image = Buffer.from('workbuddy-original-image');
  const imageId = createHash('sha256').update(image).digest('hex');
  const imagePath = join(f.root, 'blobs', `${imageId}.png`);
  mkdirSync(dirname(imagePath), { recursive: true });
  writeFileSync(imagePath, image);
  const user = {
    type: 'message', role: 'user', id: 'user-1',
    content: [
      {
        type: 'input_text',
        text: '<system-reminder>NEVER RECALL THIS INTERNAL TEXT</system-reminder>' +
          '<user_query>我记得茉莉花茶不加糖，也记得那天的图片。</user_query>',
      },
      {
        type: 'image_blob_ref', blob_id: imageId, blob_path: imagePath,
        mime: 'image/png', size: image.length, original_filename: 'tea.png',
      },
    ],
  };
  const assistant = {
    type: 'message', role: 'assistant', id: 'assistant-1',
    content: [{ type: 'output_text', text: '我会把这份偏好和图片一起保存。' }],
  };
  const title = { type: 'ai-title', aiTitle: '茉莉花茶与图片' };
  const lines = [user, assistant, title];
  if (invalid) lines.push('{broken-json');
  writeFileSync(transcriptPath, `${lines.map(value =>
    typeof value === 'string' ? value : JSON.stringify(value)).join('\n')}\n`);
  return { ...f, sessionId, transcriptPath, image, imageId, imagePath, user, assistant };
}

test('WorkBuddy JSONL archive preserves raw lines, user query, title, media and idempotence', async t => {
  const f = transcriptFixture(t, { invalid: true });
  const result = await f.runtime.archive({
    sessionId: f.sessionId,
    transcriptPath: f.transcriptPath,
    allowOutside: true,
  });
  assert.equal(result.records, 4);
  assert.equal(result.events, 4);
  assert.equal(result.media_objects, 1);
  assert.equal(result.media_errors, 0);
  assert.equal(f.runtime.store.getSession(f.sessionId).title, '茉莉花茶与图片');
  assert.equal(f.runtime.store.stats(f.sessionId).events, 4);

  const recalled = f.runtime.store.recall(f.sessionId, '茉莉花茶');
  assert.ok(recalled.some(row => row.text.includes('不加糖')));
  assert.ok(recalled.every(row => !row.text.includes('NEVER RECALL')));
  assert.ok(recalled.some(row => row.text.includes('[image: tea.png')));
  assert.equal(f.runtime.store.transcript(f.sessionId).length, 2);

  const original = f.runtime.original(f.sessionId, { line: 0 });
  assert.equal(original.raw, JSON.stringify(f.user));
  assert.equal(original.workbuddy.lineSha256,
    createHash('sha256').update(JSON.stringify(f.user)).digest('hex'));
  assert.equal(original.media[0].id, f.imageId);
  assert.equal(original.media[0].kind, 'image');
  assert.equal(original.media[0].bytes, f.image.length);
  await f.runtime.mediaStore.verify(original.media[0]);

  const invalid = f.runtime.original(f.sessionId, { line: 3 });
  assert.equal(invalid.type, 'workbuddy/invalid');
  assert.equal(invalid.raw, '{broken-json');
  assert.equal(invalid.data.parseError.length > 0, true);

  const repeated = await f.runtime.archive({
    sessionId: f.sessionId,
    transcriptPath: f.transcriptPath,
    allowOutside: true,
  });
  assert.equal(repeated.records, 0);
  assert.equal(f.runtime.store.stats(f.sessionId).events, 4);

  appendFileSync(f.transcriptPath, `${JSON.stringify({
    type: 'message', role: 'user', content: [{ type: 'input_text', text: '后来我又加了一片柠檬。' }],
  })}\n`);
  const appended = await f.runtime.archive({
    sessionId: f.sessionId,
    transcriptPath: f.transcriptPath,
    allowOutside: true,
  });
  assert.equal(appended.records, 1);
  assert.ok(f.runtime.store.recall(f.sessionId, '柠檬').some(row => row.text.includes('柠檬')));
});

test('WorkBuddy media backup roundtrip keeps original event bytes and SHA-256 objects', async t => {
  const f = transcriptFixture(t);
  await f.runtime.archive({
    sessionId: f.sessionId,
    transcriptPath: f.transcriptPath,
    allowOutside: true,
  });
  const archive = join(f.root, 'workbuddy.fame.gz');
  await exportVault(f.runtime.store, archive, { mediaStore: f.runtime.mediaStore });
  const imported = await importVault(archive, join(f.root, 'restored'));
  const restored = new MemoryStore(imported.path);
  const mediaStore = new MediaStore(dirname(restored.path));
  try {
    assert.equal(restored.stats(f.sessionId).events, 3);
    const original = restored.db.prepare(`SELECT json,sha FROM events
      WHERE session_id=? AND json_extract(json,'$.workbuddy.line')=0`).get(f.sessionId);
    assert.equal(createHash('sha256').update(original.json).digest('hex'), original.sha);
    const event = JSON.parse(original.json);
    assert.equal(event.raw, JSON.stringify(f.user));
    assert.equal(event.workbuddyMedia[0].id, f.imageId);
    await mediaStore.verify(event.workbuddyMedia[0]);
  } finally {
    restored.close();
  }
});

function runHook(dataDir, payload) {
  return spawnSync(process.execPath, [join(projectRoot, 'hooks', 'workbuddy-hook.mjs')], {
    cwd: projectRoot,
    env: { ...process.env, BIGFISH_DATA_DIR: dataDir, CODEBUDDY_PLUGIN_DATA: dataDir },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('WorkBuddy hooks archive JSONL and inject bounded evidence recall', t => {
  const f = transcriptFixture(t);
  const started = runHook(f.dataDir, {
    hook_event_name: 'SessionStart', session_id: f.sessionId, transcript_path: f.transcriptPath,
  });
  assert.equal(started.status, 0, started.stderr);
  const startOutput = JSON.parse(started.stdout);
  assert.match(startOutput.hookSpecificOutput.additionalContext, /BigFish permanent memory is active/);

  const prompted = runHook(f.dataDir, {
    hook_event_name: 'UserPromptSubmit', session_id: f.sessionId,
    transcript_path: f.transcriptPath, prompt: '你还记得茉莉花茶不加糖吗？',
  });
  assert.equal(prompted.status, 0, prompted.stderr);
  const promptOutput = JSON.parse(prompted.stdout);
  assert.match(promptOutput.hookSpecificOutput.additionalContext, /quoted memory data/);
  assert.match(promptOutput.hookSpecificOutput.additionalContext, /茉莉花茶/);

  const store = new MemoryStore(join(f.dataDir, 'vault', 'primary', 'memory.sqlite'));
  try { assert.equal(store.stats(f.sessionId).events, 3); }
  finally { store.close(); }
});

test('WorkBuddy MCP exposes search, original evidence, media and health tools', async t => {
  const f = transcriptFixture(t);
  await f.runtime.archive({
    sessionId: f.sessionId,
    transcriptPath: f.transcriptPath,
    allowOutside: true,
  });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'search_memory', arguments: { query: '茉莉花茶', session_id: f.sessionId },
    } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'read_original', arguments: { session_id: f.sessionId, line: 0 },
    } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
      name: 'open_media', arguments: { media_id: f.imageId },
    } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
      name: 'memory_health', arguments: {},
    } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
      name: 'backup_memory', arguments: { name: 'roundtrip-check' },
    } },
  ];
  const child = spawnSync(process.execPath, [join(projectRoot, 'mcp', 'server.mjs')], {
    cwd: projectRoot,
    env: { ...process.env, BIGFISH_DATA_DIR: f.dataDir, CODEBUDDY_PLUGIN_DATA: f.dataDir },
    input: `${requests.map(request => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(replies.find(reply => reply.id === 1).result.serverInfo.name, 'bigfish-memory');
  const names = replies.find(reply => reply.id === 2).result.tools.map(tool => tool.name);
  for (const name of ['search_memory', 'read_original', 'open_media', 'add_memory',
    'archive_session', 'memory_health', 'backup_memory', 'record_emotion']) assert.ok(names.includes(name));
  const search = JSON.parse(replies.find(reply => reply.id === 3).result.content[0].text);
  assert.ok(search.results.some(row => row.text.includes('茉莉花茶')));
  const original = JSON.parse(replies.find(reply => reply.id === 4).result.content[0].text);
  assert.equal(original.raw, JSON.stringify(f.user));
  const media = JSON.parse(replies.find(reply => reply.id === 5).result.content[0].text);
  assert.equal(media.id, f.imageId);
  assert.equal(resolve(media.path), resolve(f.runtime.mediaStore.path(f.imageId)));
  const health = JSON.parse(replies.find(reply => reply.id === 6).result.content[0].text);
  assert.equal(health.events, 3);
  assert.equal(health.media_objects, 1);
  const backup = JSON.parse(replies.find(reply => reply.id === 7).result.content[0].text);
  assert.equal(backup.name, 'roundtrip-check.fame.gz');
  assert.equal(backup.verified, true);
  assert.equal(existsSync(backup.path), true);
  const imported = await importVault(backup.path, join(f.root, 'backup-restored'));
  const restored = new MemoryStore(imported.path);
  try {
    assert.equal(restored.stats(f.sessionId).events, 3);
  } finally {
    restored.close();
  }
});

test('WorkBuddy plugin manifests reference existing Skill, hooks and MCP files', () => {
  for (const directory of ['.workbuddy-plugin', '.codebuddy-plugin']) {
    const manifestPath = join(projectRoot, directory, 'plugin.json');
    assert.ok(existsSync(manifestPath));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'bigfish-eternal-memory');
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.license, 'MIT');
    for (const skill of manifest.skills) {
      assert.ok(existsSync(join(projectRoot, skill, 'SKILL.md')));
    }
    assert.ok(existsSync(join(projectRoot, manifest.hooks)));
    const hooks = JSON.parse(readFileSync(join(projectRoot, manifest.hooks), 'utf8'));
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd',
      'PreCompact', 'PostCompact']) assert.ok(hooks.hooks[name]);
    const mcp = manifest.mcpServers['bigfish-memory'];
    assert.equal(mcp.type, 'stdio');
    assert.ok(existsSync(resolve(mcp.args[0].replace('${CODEBUDDY_PLUGIN_ROOT}', projectRoot))));
  }
  const marketplace = JSON.parse(readFileSync(join(projectRoot, '.codebuddy-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(marketplace.plugins[0].name, 'bigfish-eternal-memory');
  assert.match(readFileSync(join(projectRoot, 'LICENSE'), 'utf8'), /^MIT License/u);
});
