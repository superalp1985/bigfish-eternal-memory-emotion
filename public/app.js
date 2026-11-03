const $ = id => document.getElementById(id);
const dimensions = [['mu','满足'],['chi','好奇'],['epsilon','共情'],['kappa','自信'],['nu','焦虑'],['delta','冲突'],['rho','疲劳'],['lambda','失落']];
let token, connected = false, selected = null, current = null, busy = false, earliest = null, loadingHistory = false, hasOlder = false;
let draftMedia = [];
let noticeTimer, initialized = false;
function notice(text) {
  $('toast').textContent = text; $('toast').hidden = false; clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('toast').hidden = true; }, 9000);
}
async function api(path, data) {
  const response = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'x-fame-token': token ?? '', ...(data === undefined ? {} : { 'content-type':'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || '暂时无法完成'), { code: value.code, saved: value.saved });
  return value;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function setBusy(value, text = '') {
  busy = value; $('activity').textContent = text;
  $('send').disabled = value || !connected || !selected;
  $('attach').disabled = value || !connected || !selected;
  $('pack').disabled = value; $('storage').disabled = value;
}
function fame() {
  for (const actor of ['user','agent']) {
    const target = $(actor + '-fame'); target.replaceChildren(); target.className = actor;
    const state = current?.fame?.[actor];
    $(actor + '-method').textContent = state ? '已保存' : '待续';
    for (const [key, label] of dimensions) {
      const value = state?.vector[key], row = element('div', undefined, 'fame-row');
      const track = element('div', undefined, 'track'), fill = element('div', undefined, 'fill');
      fill.style.width = `${(value ?? 0) * 100}%`; track.append(fill);
      row.append(element('span', label), track, element('span', value == null ? '—' : Math.round(value * 100), 'value'));
      target.append(row);
    }
  }
}
function transcript(rows, prepend = false) {
  const target = $('transcript'), height = target.scrollHeight;
  if (!prepend) target.replaceChildren();
  const nodes = rows.map(row => {
    const actor = row.type === 'assistant/message' ? 'assistant' : 'user';
    const node = element('article', undefined, 'message ' + actor);
    node.append(element('div', actor === 'assistant' ? '大肥鱼' : '你', 'who'));
    const attachments = row.attachments ?? [];
    const onlyPlaceholder = attachments.length && /^\[(?:image|file): .+, \d+ bytes\](?:\n\[(?:image|file): .+, \d+ bytes\])*$/.test(row.text);
    if (row.text && !onlyPlaceholder) node.append(element('p', row.text));
    if (attachments.length) {
      const media = element('div', undefined, 'message-media');
      for (const ref of attachments) {
        const href = '/api/media?' + new URLSearchParams({ id: ref.id, bytes: String(ref.bytes), type: ref.mediaType, name: ref.name });
        if (ref.kind === 'image') {
          const link = document.createElement('a'); link.href = href; link.target = '_blank';
          const image = document.createElement('img'); image.src = href; image.alt = ref.name; image.loading = 'lazy';
          link.append(image); media.append(link);
        } else {
          const link = element('a', ref.name, 'file-link'); link.href = href; link.setAttribute('download', ref.name); media.append(link);
        }
      }
      node.append(media);
    }
    return node;
  });
  if (prepend) target.prepend(...nodes); else target.append(...nodes);
  if (!rows.length && !prepend) target.append(element('div', '我们接着聊。', 'empty'));
  while (target.querySelectorAll('.message').length > 150) target.querySelector('.message:last-of-type').remove();
  earliest = rows[0]?.cursor; hasOlder = rows.length === 50;
  target.scrollTop = prepend ? Math.max(1, target.scrollHeight - height) : target.scrollHeight;
}
function renderDraftMedia() {
  const target = $('draft-media'); target.replaceChildren();
  for (const [index, ref] of draftMedia.entries()) {
    const item = element('div', undefined, 'draft-item');
    item.append(element('span', `${ref.name} · ${Math.max(1, Math.ceil(ref.bytes / 1024))} KB`));
    const remove = element('button', '×', 'remove-media'); remove.type = 'button'; remove.title = '从本条消息移除';
    remove.onclick = () => { draftMedia.splice(index, 1); renderDraftMedia(); };
    item.append(remove); target.append(item);
  }
}
async function uploadMedia(file) {
  const response = await fetch('/api/media?name=' + encodeURIComponent(file.name), {
    method: 'POST', headers: { 'x-fame-token': token, 'content-type': file.type || 'application/octet-stream' }, body: file,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '素材保存失败');
  return value;
}
async function refresh(id, messages = true) {
  current = await api('session?id=' + encodeURIComponent(id));
  selected = id;
  localStorage.setItem('bigfish-session', id);
  $('title').textContent = current.session.title;
  $('stats').textContent = current.maintaining ? '记忆已保存，正在整理' : '记忆和情感已保存';
  $('memory-count').textContent = current.stats.memories;
  $('emotion-status').textContent = current.fame.user && current.fame.agent ? '已保存' : '待续';
  fame();
  if (messages) transcript(current.transcript);
  document.querySelectorAll('.session').forEach(button => button.classList.toggle('active', button.dataset.session === id));
  setBusy(busy);
}
async function connect() {
  const state = await api('bootstrap');
  token = state.token; connected = state.connected;
  $('connection').textContent = connected ? '陪你聊天' : '记忆已保存';
  $('indicator').classList.toggle('ready', connected);
  $('data-path').textContent = state.root;
  const rows = await api('sessions');
  if (!rows.length && connected) rows.push(await api('sessions', { title: '和大肥鱼的对话' }));
  $('sessions').replaceChildren();
  for (const row of rows) {
    const button = element('button', row.title, 'session');
    button.dataset.session = row.id;
    button.onclick = async () => { if (!busy) { try { await refresh(row.id); } catch (error) { notice(error.message); } } };
    $('sessions').append(button);
  }
  const prior = selected ?? localStorage.getItem('bigfish-session');
  const row = rows.find(value => value.id === prior) ?? rows[0];
  if (row) await refresh(row.id);
  initialized = true;
  setBusy(false);
}
$('composer').onsubmit = async event => {
  event.preventDefault();
  const text = $('message').value.trim();
  if ((!text && !draftMedia.length) || busy || !selected) return;
  setBusy(true, '正在回复');
  try {
    for (;;) {
      try { await api('send', { id: selected, text, attachments: draftMedia }); break; }
      catch (error) {
        if (error.code !== 'MAINTENANCE_PENDING') throw error;
        $('activity').textContent = '正在接续记忆';
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    $('message').value = '';
    draftMedia = []; renderDraftMedia();
    await refresh(selected);
  } catch (error) {
    if (error.saved) { $('message').value = ''; draftMedia = []; renderDraftMedia(); }
    notice(error.saved ? '对话已保存' : error.message);
  } finally { setBusy(false); }
};
$('attach').onclick = () => $('media-picker').click();
$('media-picker').onchange = async () => {
  const files = [...$('media-picker').files]; $('media-picker').value = '';
  if (!files.length) return;
  if (draftMedia.length + files.length > 20) return notice('每条消息最多 20 个素材');
  setBusy(true, '正在永久保存素材');
  try {
    for (const file of files) {
      draftMedia.push(await uploadMedia(file));
      renderDraftMedia();
    }
  } catch (error) { notice(error.message); }
  finally { setBusy(false); }
};
$('transcript').onscroll = async () => {
  if (!selected || busy || loadingHistory || !hasOlder || $('transcript').scrollTop > 40) return;
  loadingHistory = true;
  try {
    const older = await api(`session?id=${encodeURIComponent(selected)}&before=${earliest}`);
    transcript(older.transcript, true);
  } catch (error) { notice(error.message); }
  finally { loadingHistory = false; }
};
$('pack').onclick = async () => {
  setBusy(true, '正在打包记忆和情感');
  try {
    const result = await api('portable', {});
    notice('打包完成：' + result.path);
  } catch (error) { notice(error.message); }
  finally { setBusy(false); }
};
$('storage').onclick = async () => {
  setBusy(true, '选择保存位置');
  try {
    const result = await api('storage', {});
    if (!result.cancelled) { await connect(); notice('记忆和情感已保存到：' + result.root); }
  } catch (error) { notice(error.message); }
  finally { setBusy(false); }
};
fame();
async function monitor() {
  try {
    if (!initialized) await connect();
    else if (!busy && selected && current?.maintaining) await refresh(selected, false);
  } catch {
    connected = false; initialized = false;
    $('connection').textContent = '正在重连'; $('indicator').classList.remove('ready'); setBusy(busy);
  } finally { setTimeout(monitor, 5000); }
}
await monitor();
