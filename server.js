/**
 * Ajaia Docs — lightweight collaborative document editor.
 *
 * Stack: Node 24 + Express + SQLite (Node's built-in `node:sqlite`,
 * no native add-on, no paid service). Frontend is plain HTML/CSS/JS
 * with no build step, served from ./public.
 *
 * Auth is deliberately mocked for this assignment: the frontend sends
 * `x-user-id` for a seeded user. See README.md / ARCHITECTURE.md for
 * what this does and does not prove, and what would replace it in prod.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const sanitizeHtml = require('sanitize-html');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'ajaia-docs.db');
const MAX_CONTENT_CHARS = 1_000_000;
const MAX_TITLE_CHARS = 200;

// ---------------------------------------------------------------------------
// Seeded users (mocked auth — see README "Seeded accounts")
// ---------------------------------------------------------------------------
const SEEDED_USERS = [
  { id: 'usman', name: 'Usman Ali', email: 'usman@demo.ajaia', role: 'Owner — demo' },
  { id: 'sara', name: 'Sara Khan', email: 'sara@demo.ajaia', role: 'Teammate — demo' },
  { id: 'alex', name: 'Alex Morgan', email: 'alex@demo.ajaia', role: 'Teammate — demo' },
];

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------
const SANITIZE_OPTS = {
  allowedTags: ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'u', 'b', 'i',
    'br', 'blockquote', 'code', 'pre', 'a', 'span', 'div'],
  allowedAttributes: { a: ['href'], span: ['style'], div: [] },
  allowedSchemes: ['http', 'https', 'mailto'],
};

function sanitizeContent(html) {
  if (typeof html !== 'string') return '';
  return sanitizeHtml(html, SANITIZE_OPTS);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMd(s) {
  let out = escapeHtml(s);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

/** Small, dependency-free Markdown -> HTML converter (upload path only). */
function markdownToHtml(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inlineMd(ul[1])}</li>`); continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inlineMd(ol[1])}</li>`); continue;
    }
    closeList();
    out.push(`<p>${inlineMd(line.trim())}</p>`);
  }
  closeList();
  return out.join('\n') || '<p></p>';
}

/** Small HTML -> Markdown converter (export path only). */
function htmlToMarkdown(html) {
  let s = String(html || '');
  s = s.replace(/<h1[^>]*>(.*?)<\/h1>/gis, (_, t) => `\n# ${stripTags(t)}\n`);
  s = s.replace(/<h2[^>]*>(.*?)<\/h2>/gis, (_, t) => `\n## ${stripTags(t)}\n`);
  s = s.replace(/<h3[^>]*>(.*?)<\/h3>/gis, (_, t) => `\n### ${stripTags(t)}\n`);
  s = s.replace(/<li[^>]*>(.*?)<\/li>/gis, (_, t) => `\n- ${stripTags(t)}`);
  s = s.replace(/<\/(ul|ol)>/gi, '\n');
  s = s.replace(/<strong[^>]*>(.*?)<\/strong>/gis, (_, t) => `**${stripTags(t)}**`);
  s = s.replace(/<b[^>]*>(.*?)<\/b>/gis, (_, t) => `**${stripTags(t)}**`);
  s = s.replace(/<em[^>]*>(.*?)<\/em>/gis, (_, t) => `*${stripTags(t)}*`);
  s = s.replace(/<i[^>]*>(.*?)<\/i>/gis, (_, t) => `*${stripTags(t)}*`);
  s = s.replace(/<u[^>]*>(.*?)<\/u>/gis, (_, t) => stripTags(t));
  s = s.replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = stripTags(s);
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim() + '\n';
  function stripTags(t) { return String(t).replace(/<[^>]+>/g, ''); }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
function initDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content_html TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shares (
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (doc_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      title TEXT NOT NULL, content_html TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
    CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
    CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(doc_id, created_at DESC);
  `);

  const insertUser = db.prepare('INSERT OR IGNORE INTO users (id, name, email, role) VALUES (?, ?, ?, ?)');
  for (const u of SEEDED_USERS) insertUser.run(u.id, u.name, u.email, u.role);

  // Seed content once, so a reviewer opening the app sees a real Owned
  // doc and a real Shared doc instead of an empty state.
  const count = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
  if (count === 0) {
    const now = new Date().toISOString();
    const welcome = `<h1>Welcome to Ajaia Docs</h1><p>This is your first document. Try the toolbar above — <strong>bold</strong>, <em>italic</em>, underline, headings and lists all work. Edits autosave.</p><ul><li>Create a doc from the sidebar</li><li>Upload a .txt, .md or .docx file</li><li>Share a doc with Sara or Alex from the Share button</li></ul>`;
    const shared = `<h1>Q4 launch notes</h1><p>Shared with you by Sara. If you can edit this, you have Editor access — if not, you are a Viewer.</p><h2>Next steps</h2><ol><li>Confirm the launch date</li><li>Draft the announcement</li></ol>`;
    db.prepare('INSERT INTO documents (id, title, content_html, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('doc-welcome', 'Welcome to Ajaia Docs', welcome, 'usman', now, now);
    db.prepare('INSERT INTO documents (id, title, content_html, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('doc-launch-notes', 'Q4 launch notes', shared, 'sara', now, now);
    db.prepare("INSERT OR IGNORE INTO shares (doc_id, user_id, role, created_at) VALUES ('doc-launch-notes', 'usman', 'editor', ?)")
      .run(now);
  }
  return db;
}

const db = initDb(DB_PATH);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function nowIso() { return new Date().toISOString(); }
function newId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function getUser(req) {
  const id = req.header('x-user-id');
  if (!id) return null;
  return db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(id) || null;
}
function requireUser(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Missing or unknown user. Send x-user-id for a seeded user.' });
  req.user = user;
  next();
}
function getDoc(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) || null;
}
/** Returns 'owner' | 'editor' | 'viewer' | null */
function accessLevel(doc, user) {
  if (!doc || !user) return null;
  if (doc.owner_id === user.id) return 'owner';
  const share = db.prepare('SELECT role FROM shares WHERE doc_id = ? AND user_id = ?').get(doc.id, user.id);
  return share ? share.role : null;
}
function docView(doc, user) {
  const level = accessLevel(doc, user);
  const owner = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(doc.owner_id);
  return {
    id: doc.id, title: doc.title, contentHtml: doc.content_html,
    owner, access: level, createdAt: doc.created_at, updatedAt: doc.updated_at,
  };
}
function validateTitle(title) {
  if (typeof title !== 'string' || !title.trim()) return 'Title is required.';
  if (title.trim().length > MAX_TITLE_CHARS) return `Title must be ${MAX_TITLE_CHARS} characters or fewer.`;
  return null;
}

// --- Users ---------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id, name, email, role FROM users ORDER BY name').all();
  res.json({ users });
});

// --- Documents -----------------------------------------------------------
app.get('/api/docs', requireUser, (req, res) => {
  const filter = String(req.query.filter || 'all');
  const q = String(req.query.q || '').trim().toLowerCase();
  let docs = db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all()
    .map((d) => docView(d, req.user));
  if (filter === 'owned') docs = docs.filter((d) => d.access === 'owner');
  if (filter === 'shared') docs = docs.filter((d) => d.access === 'editor' || d.access === 'viewer');
  if (q) docs = docs.filter((d) => d.title.toLowerCase().includes(q));
  // Never leak docs the user cannot access.
  docs = docs.filter((d) => d.access);
  res.json({ docs: docs.map(({ contentHtml, ...rest }) => rest) });
});

app.post('/api/docs', requireUser, (req, res) => {
  const err = validateTitle(req.body?.title || 'Untitled document');
  if (err) return res.status(400).json({ error: err });
  const title = (req.body.title || 'Untitled document').trim();
  const contentHtml = sanitizeContent(req.body?.contentHtml || '<p></p>');
  if (contentHtml.length > MAX_CONTENT_CHARS) return res.status(400).json({ error: 'Document is too large (1,000,000 characters max).' });
  const now = nowIso();
  const id = newId('doc');
  db.prepare('INSERT INTO documents (id, title, content_html, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, title, contentHtml, req.user.id, now, now);
  res.status(201).json({ doc: docView(getDoc(id), req.user) });
});

app.get('/api/docs/:id', requireUser, (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc || !accessLevel(doc, req.user)) return res.status(404).json({ error: 'Document not found.' });
  res.json({ doc: docView(doc, req.user) });
});

app.put('/api/docs/:id', requireUser, (req, res) => {
  const doc = getDoc(req.params.id);
  const level = accessLevel(doc, req.user);
  if (!doc || !level) return res.status(404).json({ error: 'Document not found.' });
  if (level === 'viewer') return res.status(403).json({ error: 'Viewers cannot edit this document.' });

  const title = req.body?.title !== undefined ? req.body.title : doc.title;
  const titleErr = validateTitle(title);
  if (titleErr) return res.status(400).json({ error: titleErr });
  const contentHtml = req.body?.contentHtml !== undefined ? sanitizeContent(req.body.contentHtml) : doc.content_html;
  if (contentHtml.length > MAX_CONTENT_CHARS) return res.status(400).json({ error: 'Document is too large (1,000,000 characters max).' });

  // Version snapshot of the *previous* content, only when it changed.
  if (contentHtml !== doc.content_html || title.trim() !== doc.title) {
    db.prepare('INSERT INTO versions (id, doc_id, title, content_html, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId('ver'), doc.id, doc.title, doc.content_html, req.user.id, nowIso());
    db.prepare(`DELETE FROM versions WHERE id IN (
      SELECT id FROM versions WHERE doc_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 20
    )`).run(doc.id);
  }
  db.prepare('UPDATE documents SET title = ?, content_html = ?, updated_at = ? WHERE id = ?')
    .run(title.trim(), contentHtml, nowIso(), doc.id);
  res.json({ doc: docView(getDoc(doc.id), req.user) });
});

app.delete('/api/docs/:id', requireUser, (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc || accessLevel(doc, req.user) !== 'owner') return res.status(404).json({ error: 'Document not found.' });
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  res.json({ ok: true });
});

// --- Sharing -------------------------------------------------------------
app.get('/api/docs/:id/shares', requireUser, (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc || !accessLevel(doc, req.user)) return res.status(404).json({ error: 'Document not found.' });
  const shares = db.prepare(`
    SELECT s.user_id AS userId, s.role, u.name, u.email, s.created_at AS createdAt
    FROM shares s JOIN users u ON u.id = s.user_id WHERE s.doc_id = ? ORDER BY u.name
  `).all(doc.id);
  res.json({ ownerId: doc.owner_id, shares });
});

app.post('/api/docs/:id/share', requireUser, (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc || accessLevel(doc, req.user) !== 'owner') return res.status(404).json({ error: 'Document not found.' });
  const { userId, role } = req.body || {};
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: "Role must be 'editor' or 'viewer'." });
  if (userId === doc.owner_id) return res.status(400).json({ error: 'The owner already has access.' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(400).json({ error: 'Unknown user.' });
  db.prepare(`INSERT INTO shares (doc_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(doc_id, user_id) DO UPDATE SET role = excluded.role`)
    .run(doc.id, userId, role, nowIso());
  res.status(201).json({ ok: true });
});

app.delete('/api/docs/:id/share/:userId', requireUser, (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc || accessLevel(doc, req.user) !== 'owner') return res.status(404).json({ error: 'Document not found.' });
  db.prepare('DELETE FROM shares WHERE doc_id = ? AND user_id = ?').run(doc.id, req.params.userId);
  res.json({ ok: true });
});

// --- Versions & export ---------------------------------------------------
app.get('/api/docs/:id/versions', requireUser, (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc || !accessLevel(doc, req.user)) return res.status(404).json({ error: 'Document not found.' });
  const versions = db.prepare(`
    SELECT v.id, v.title, v.created_by AS createdBy, u.name AS createdByName, v.created_at AS createdAt
    FROM versions v LEFT JOIN users u ON u.id = v.created_by
    WHERE v.doc_id = ? ORDER BY v.created_at DESC LIMIT 20
  `).all(doc.id);
  res.json({ versions });
});

app.post('/api/docs/:id/restore/:versionId', requireUser, (req, res) => {
  const doc = getDoc(req.params.id);
  const level = accessLevel(doc, req.user);
  if (!doc || !level) return res.status(404).json({ error: 'Document not found.' });
  if (level === 'viewer') return res.status(403).json({ error: 'Viewers cannot restore versions.' });
  const ver = db.prepare('SELECT * FROM versions WHERE id = ? AND doc_id = ?').get(req.params.versionId, doc.id);
  if (!ver) return res.status(404).json({ error: 'Version not found.' });
  db.prepare('INSERT INTO versions (id, doc_id, title, content_html, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newId('ver'), doc.id, doc.title, doc.content_html, req.user.id, nowIso());
  db.prepare('UPDATE documents SET title = ?, content_html = ?, updated_at = ? WHERE id = ?')
    .run(ver.title, ver.content_html, nowIso(), doc.id);
  res.json({ doc: docView(getDoc(doc.id), req.user) });
});

app.get('/api/docs/:id/export', requireUser, (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc || !accessLevel(doc, req.user)) return res.status(404).json({ error: 'Document not found.' });
  const bodyMd = htmlToMarkdown(doc.content_html);
  // Don't duplicate the title when the content itself already starts with it.
  const md = bodyMd.startsWith(`# ${doc.title}\n`) ? bodyMd : `# ${doc.title}\n\n${bodyMd}`;
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.title.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 80) || 'document'}.md"`);
  res.send(md);
});

// --- Upload --------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(txt|md|markdown|docx)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Only .txt, .md and .docx files are supported.'), ok);
  },
});

app.post('/api/upload', requireUser, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const name = req.file.originalname || 'Uploaded document';
    const ext = path.extname(name).toLowerCase();
    const baseTitle = path.basename(name, path.extname(name)).replace(/[-_]+/g, ' ').trim() || 'Uploaded document';
    let contentHtml;
    if (ext === '.docx') {
      const result = await mammoth.convertToHtml({ buffer: req.file.buffer });
      contentHtml = sanitizeContent(result.value || '<p></p>');
      if (result.messages?.length) console.warn('docx warnings:', result.messages.map((m) => m.message));
    } else if (ext === '.md' || ext === '.markdown') {
      contentHtml = sanitizeContent(markdownToHtml(req.file.buffer.toString('utf8')));
    } else {
      // .txt — preserve line breaks, no formatting invented.
      const text = req.file.buffer.toString('utf8');
      contentHtml = text.split(/\n\s*\n/).map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('\n') || '<p></p>';
    }
    if (contentHtml.length > MAX_CONTENT_CHARS) return res.status(400).json({ error: 'File is too large after conversion.' });
    const now = nowIso();
    const id = newId('doc');
    db.prepare('INSERT INTO documents (id, title, content_html, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, baseTitle.slice(0, MAX_TITLE_CHARS), contentHtml, req.user.id, now, now);
    res.status(201).json({ doc: docView(getDoc(id), req.user) });
  } catch (err) {
    console.error('upload failed:', err);
    res.status(400).json({ error: 'Could not read that file. Try a .txt, .md or .docx file under 5 MB.' });
  }
});

// --- Errors & SPA fallback -------------------------------------------------
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large (5 MB max).' });
  if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
  next();
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Ajaia Docs running at http://localhost:${PORT}`));
}

module.exports = { app, db, initDb, markdownToHtml, htmlToMarkdown, sanitizeContent };
