/* Ajaia Docs frontend — no framework, no build step.
   State: currentUser (localStorage), currentDoc, filter, search.
   Every API call sends x-user-id for the mocked demo login. */
'use strict';

const $ = (s) => document.querySelector(s);
const api = {
  async req(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'x-user-id': state.userId, ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },
};

const state = {
  userId: localStorage.getItem('ajaia-user') || 'usman',
  users: [],
  docs: [],
  filter: 'all',
  currentDoc: null,
  saveTimer: null,
  dirty: false,
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
function setStatus(text) { $('#saveStatus').textContent = text; }
function wordCount() {
  const text = $('#editor').innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  $('#wordCount').textContent = `${words} word${words === 1 ? '' : 's'}`;
}

async function loadUsers() {
  const { users } = await api.req('/api/users');
  state.users = users;
  const sel = $('#userSelect');
  sel.innerHTML = users.map((u) => `<option value="${u.id}">${u.name} — ${u.email}</option>`).join('');
  sel.value = state.userId;
  sel.onchange = () => {
    state.userId = sel.value;
    localStorage.setItem('ajaia-user', state.userId);
    state.currentDoc = null;
    renderEditor();
    loadDocs();
    toast(`Switched to ${users.find((u) => u.id === state.userId)?.name}`);
  };
}

async function loadDocs() {
  const q = $('#searchInput').value.trim();
  const { docs } = await api.req(`/api/docs?filter=${state.filter}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  state.docs = docs;
  const list = $('#docList');
  $('#listEmpty').hidden = docs.length > 0;
  list.innerHTML = docs.map((d) => {
    const badge = d.access === 'owner'
      ? '<span class="badge">Owned</span>'
      : `<span class="badge shared">Shared · ${d.access}</span>`;
    return `<li data-id="${d.id}" class="${state.currentDoc?.id === d.id ? 'active' : ''}">
      <div class="t">${escapeHtml(d.title)}${badge}</div>
      <div class="m">${escapeHtml(d.owner.name)} · ${new Date(d.updatedAt).toLocaleString()}</div>
    </li>`;
  }).join('');
  list.querySelectorAll('li').forEach((li) => {
    li.onclick = () => openDoc(li.dataset.id);
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function openDoc(id) {
  try {
    const { doc } = await api.req(`/api/docs/${id}`);
    state.currentDoc = doc;
    renderEditor();
    loadDocs();
  } catch (e) { toast(e.message); }
}

function renderEditor() {
  const doc = state.currentDoc;
  $('#noDoc').hidden = !!doc;
  $('#editorPane').hidden = !doc;
  if (!doc) return;
  const canEdit = doc.access !== 'viewer';
  $('#viewerBanner').hidden = canEdit;
  $('#titleInput').value = doc.title;
  $('#titleInput').disabled = !canEdit;
  $('#editor').innerHTML = doc.contentHtml || '<p></p>';
  $('#editor').contentEditable = String(canEdit);
  $('#docMeta').textContent = `Owner: ${doc.owner.name} (${doc.owner.email}) · Your access: ${doc.access} · Updated ${new Date(doc.updatedAt).toLocaleString()}`;
  $('#shareBtn').disabled = doc.access !== 'owner';
  $('#deleteBtn').disabled = doc.access !== 'owner';
  $('#versionsPanel').hidden = true;
  setStatus('Saved');
  wordCount();
}

function scheduleSave() {
  if (!state.currentDoc || state.currentDoc.access === 'viewer') return;
  setStatus('Saving…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDoc, 800);
}

async function saveDoc() {
  const doc = state.currentDoc;
  if (!doc) return;
  try {
    const { doc: saved } = await api.req(`/api/docs/${doc.id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: $('#titleInput').value, contentHtml: $('#editor').innerHTML }),
    });
    state.currentDoc = saved;
    setStatus(`Saved ${new Date().toLocaleTimeString()}`);
    loadDocs();
  } catch (e) {
    setStatus('Save failed — retrying');
    toast(e.message);
  }
}

async function createDoc() {
  try {
    const { doc } = await api.req('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'Untitled document' }) });
    state.currentDoc = doc;
    renderEditor();
    loadDocs();
    $('#titleInput').focus();
    $('#titleInput').select();
  } catch (e) { toast(e.message); }
}

async function uploadFile(file) {
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  setStatus('Uploading…');
  try {
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-user-id': state.userId }, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.currentDoc = data.doc;
    renderEditor();
    loadDocs();
    toast(`Created “${data.doc.title}” from ${file.name}`);
  } catch (e) {
    setStatus('Saved');
    toast(e.message);
  }
}

// --- Sharing ---------------------------------------------------------------
async function openShare() {
  const doc = state.currentDoc;
  if (!doc || doc.access !== 'owner') return;
  $('#shareDocTitle').textContent = doc.title;
  const others = state.users.filter((u) => u.id !== doc.owner.id);
  $('#shareUserSelect').innerHTML = others.map((u) => `<option value="${u.id}">${u.name} — ${u.email}</option>`).join('');
  await refreshShares();
  $('#shareError').hidden = true;
  $('#shareDialog').showModal();
}

async function refreshShares() {
  const doc = state.currentDoc;
  const { shares } = await api.req(`/api/docs/${doc.id}/shares`);
  $('#shareList').innerHTML = shares.length ? shares.map((s) => `
    <li><span>${escapeHtml(s.name)} — ${escapeHtml(s.email)} · ${s.role}</span>
    <button type="button" data-user="${s.userId}">Remove</button></li>`).join('')
    : '<li>No one else has access yet.</li>';
  $('#shareList').querySelectorAll('button[data-user]').forEach((b) => {
    b.onclick = async () => {
      await api.req(`/api/docs/${doc.id}/share/${b.dataset.user}`, { method: 'DELETE' });
      refreshShares(); loadDocs();
    };
  });
}

// --- Versions / export -----------------------------------------------------
async function toggleVersions() {
  const panel = $('#versionsPanel');
  if (!panel.hidden) { panel.hidden = true; return; }
  const { versions } = await api.req(`/api/docs/${state.currentDoc.id}/versions`);
  panel.hidden = false;
  panel.innerHTML = versions.length
    ? `<strong>Version history</strong> (a snapshot is saved each time you save a change)<ul>${versions.map((v) => `
        <li>${new Date(v.createdAt).toLocaleString()} — ${escapeHtml(v.title)} — by ${escapeHtml(v.createdByName || v.createdBy)}
        <button data-ver="${v.id}">Restore</button></li>`).join('')}</ul>`
    : '<strong>Version history</strong><p>No earlier versions yet — edit and save, then check back.</p>';
  panel.querySelectorAll('button[data-ver]').forEach((b) => {
    b.onclick = async () => {
      const { doc } = await api.req(`/api/docs/${state.currentDoc.id}/restore/${b.dataset.ver}`, { method: 'POST' });
      state.currentDoc = doc; renderEditor(); toggleVersions(); toast('Version restored');
    };
  });
}

async function exportMarkdown() {
  const doc = state.currentDoc;
  const res = await fetch(`/api/docs/${doc.id}/export`, { headers: { 'x-user-id': state.userId } });
  if (!res.ok) { toast('Export failed'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${doc.title.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 80) || 'document'}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- Wire up ---------------------------------------------------------------
$('#newDocBtn').onclick = createDoc;
$('#uploadInput').onchange = (e) => { uploadFile(e.target.files[0]); e.target.value = ''; };
$('#searchInput').oninput = () => loadDocs();
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    state.filter = t.dataset.filter;
    loadDocs();
  };
});
$('#editor').addEventListener('input', () => { wordCount(); scheduleSave(); });
$('#titleInput').addEventListener('input', scheduleSave);
$('#saveBtn').onclick = saveDoc;
$('#shareBtn').onclick = openShare;
$('#versionsBtn').onclick = toggleVersions;
$('#exportBtn').onclick = exportMarkdown;
$('#deleteBtn').onclick = async () => {
  if (!state.currentDoc || !confirm(`Delete “${state.currentDoc.title}”? This cannot be undone.`)) return;
  await api.req(`/api/docs/${state.currentDoc.id}`, { method: 'DELETE' });
  state.currentDoc = null; renderEditor(); loadDocs(); toast('Document deleted');
};
$('#addShareBtn').onclick = async () => {
  const errEl = $('#shareError');
  try {
    await api.req(`/api/docs/${state.currentDoc.id}/share`, {
      method: 'POST',
      body: JSON.stringify({ userId: $('#shareUserSelect').value, role: $('#shareRoleSelect').value }),
    });
    errEl.hidden = true;
    refreshShares(); loadDocs();
    toast('Shared');
  } catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
};
// --- Clear formatting -----------------------------------------------------
// document.execCommand('removeFormat') alone is not enough: it only strips
// inline formatting (bold/italic/underline) and does nothing to headings or
// lists. It also silently does nothing when clicking the toolbar button has
// already moved focus (and the text selection) out of the editor. So Clear:
//  1. keeps the selection (see the mousedown handler below),
//  2. strips inline formatting,
//  3. turns headings back into normal paragraphs,
//  4. turns list items back into plain paragraphs.
// If nothing is selected, it clears the formatting of the current paragraph.
function clearFormatting() {
  const editor = $('#editor');
  editor.focus();
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  let range = sel.getRangeAt(0);
  if (range.collapsed) {
    const node = sel.anchorNode;
    const block = node && node.nodeType === 3 ? node.parentElement : node;
    const para = block && block.closest ? block.closest('h1,h2,h3,li,p,blockquote') : null;
    if (!para || !editor.contains(para)) return;
    range = document.createRange();
    range.selectNodeContents(para);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  document.execCommand('removeFormat', false, null);
  document.execCommand('formatBlock', false, 'p');
  // Lists survive removeFormat/formatBlock, so convert any list that the
  // selection touches into plain paragraphs, keeping the text.
  editor.querySelectorAll('ul,ol').forEach((list) => {
    if (!sel.rangeCount || !sel.getRangeAt(0).intersectsNode(list)) return;
    const frag = document.createDocumentFragment();
    list.querySelectorAll('li').forEach((li) => {
      const p = document.createElement('p');
      p.textContent = li.textContent;
      frag.appendChild(p);
    });
    list.replaceWith(frag);
  });
  // Strip any inline tags left behind (e.g. spans), keeping their text.
  editor.querySelectorAll('strong,em,u,b,i,span,code,a').forEach((el) => {
    if (!sel.rangeCount || !sel.getRangeAt(0).intersectsNode(el)) return;
    el.replaceWith(document.createTextNode(el.textContent));
  });
  // Normalise: empty blocks left behind become a single empty paragraph.
  if (!editor.textContent.trim()) editor.innerHTML = '<p></p>';
  wordCount();
  scheduleSave();
}

$('#toolbar').addEventListener('mousedown', (e) => {
  // Clicking a toolbar button steals focus (and the text selection) from
  // the editor in Chrome, so formatting commands then run on nothing.
  // Prevent that for buttons; the click handler below still fires.
  if (e.target.closest('button[data-cmd]')) e.preventDefault();
});
$('#toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cmd]');
  if (!btn || state.currentDoc?.access === 'viewer') return;
  if (btn.dataset.cmd === 'removeFormat') { clearFormatting(); return; }
  document.execCommand(btn.dataset.cmd, false, null);
  $('#editor').focus();
  scheduleSave();
});
$('#blockSelect').onchange = (e) => {
  if (state.currentDoc?.access === 'viewer') return;
  document.execCommand('formatBlock', false, e.target.value);
  $('#editor').focus();
  scheduleSave();
};

loadUsers().then(loadDocs).catch((e) => toast(e.message));
