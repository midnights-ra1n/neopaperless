import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { db, openDb, closeDb, ftsQuery, DATA_DIR, FILES_DIR, DB_PATH } from './db.js';
import { autoAssign } from './matching.js';
import { extractText } from './extract.js';
import { paperlessApi } from './paperless.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const UPDATE_URL = process.env.UPDATE_URL || 'https://api.github.com/repos/midnights-ra1n/neopaperless/releases/latest';
const SESSION_DAYS = 30;
// Types the browser may render inline; anything else (html, svg...) is forced to download to avoid stored XSS.
const INLINE_TYPES = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/;

const execFileP = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, (err) => (err ? reject(err) : resolve())));

// ---------- auth ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

function readCookie(req, name) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1];
}

function createSession(userId, days, name = null) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, name) VALUES (?, ?, ?, ?)').run(token, userId, Date.now() + days * 864e5, name);
  return token;
}

function startSession(req, res, userId) {
  const token = createSession(userId, SESSION_DAYS);
  res.cookie('np_session', token, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: '/',
  });
}

function currentUser(req) {
  // Browser sessions use the cookie; Paperless-ngx clients send "Authorization: Token <token>".
  const token = readCookie(req, 'np_session') || req.headers.authorization?.match(/^Token (\S+)$/i)?.[1];
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now()) || null;
}

function requireAuth(req, res, next) {
  req.user = currentUser(req);
  if (!req.user) return res.status(401).json({ error: 'Non authentifié' });
  next();
}

function validCredentials(body) {
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  if (username.length < 3) return { error: "Le nom d'utilisateur doit faire au moins 3 caractères" };
  if (password.length < 8) return { error: 'Le mot de passe doit faire au moins 8 caractères' };
  return { username, password };
}

// Login throttling: 10 failures per IP per 15 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const entry = failures.get(ip);
  if (!entry || entry.until < Date.now()) return false;
  return entry.count >= 10;
}
function recordFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || entry.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
  else entry.count++;
}

// ---------- documents ----------
const DOC_COLUMNS = `d.id, d.title, d.filename, d.mime, d.size, d.doc_date, d.added_at, d.notes, d.folder_id, d.correspondent_id, d.document_type_id, d.asn, d.modified,
  (SELECT json_group_array(tag_id) FROM document_tags WHERE document_id = d.id) AS tags`;

function rowToDoc(row) {
  if (!row) return row;
  const { stored_name, ...doc } = row; // internal file name stays server-side
  return { ...doc, tags: JSON.parse(doc.tags) };
}

function getDoc(id) {
  return db.prepare(`SELECT ${DOC_COLUMNS}, d.stored_name FROM documents d WHERE d.id = ?`).get(id);
}

function setTags(docId, tagIds) {
  db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(docId);
  const insert = db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) SELECT ?, id FROM tags WHERE id = ?');
  for (const tagId of tagIds) insert.run(docId, Number(tagId));
}

// Returns the id if that folder exists, else null (no folder).
function folderId(value) {
  return db.prepare('SELECT id FROM folders WHERE id = ?').get(Number(value) || 0)?.id ?? null;
}

function sendFile(res, doc, download) {
  const inline = !download && INLINE_TYPES.test(doc.mime);
  res.setHeader('Content-Type', inline ? doc.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.join(FILES_DIR, doc.stored_name));
}

async function makeThumbnail(filePath, mime) {
  if (mime !== 'application/pdf') return;
  // pdftoppm appends ".png" to the output prefix.
  await execFileP('pdftoppm', ['-png', '-singlefile', '-f', '1', '-l', '1', '-scale-to', '480', filePath, `${filePath}.thumb`])
    .catch(() => {});
}

function sendThumb(res, doc) {
  const thumb = path.join(FILES_DIR, `${doc.stored_name}.thumb.png`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (fs.existsSync(thumb)) return res.sendFile(thumb);
  if (/^image\/(png|jpeg|gif|webp)$/.test(doc.mime)) return sendFile(res, doc, false);
  res.status(404).end();
}

async function removeDoc(doc) {
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  const file = path.join(FILES_DIR, doc.stored_name);
  await Promise.all([fsp.rm(file, { force: true }), fsp.rm(`${file}.thumb.png`, { force: true })]);
}

// Streams a file into storage and indexes it. Returns { id } or, for a known file, { duplicate: id }.
const existingId = (table, v) => db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(Number(v) || 0)?.id ?? null;

async function ingest(stream, { filename, mime, folder, tags = [], title, docDate = null, correspondent, documentType, asn, customFields = [] }) {
  const ext = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const storedName = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(FILES_DIR, storedName);
  const hash = crypto.createHash('sha256');
  let size = 0;
  stream.on('data', (chunk) => { hash.update(chunk); size += chunk.length; });
  await pipeline(stream, fs.createWriteStream(filePath));
  const sha256 = hash.digest('hex');

  const existing = db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha256);
  if (existing) {
    await fsp.rm(filePath);
    return { duplicate: existing.id };
  }
  const [content] = await Promise.all([extractText(filePath, mime), makeThumbnail(filePath, mime)]);
  const name = title || path.basename(filename, path.extname(filename)).replace(/[_-]+/g, ' ').trim() || filename;
  const [corr, type, fid] = [existingId('correspondents', correspondent), existingId('document_types', documentType), folderId(folder)];
  const takenAsn = !asn || db.prepare('SELECT 1 FROM documents WHERE asn = ?').get(Number(asn)); // a taken ASN is dropped, the file is kept
  const { lastInsertRowid } = db.prepare(`INSERT INTO documents (title, filename, stored_name, mime, size, sha256, content, folder_id, doc_date,
      correspondent_id, document_type_id, asn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, filename, storedName, mime, size, sha256, content, fid, docDate, corr, type, takenAsn ? null : Number(asn));
  setTags(lastInsertRowid, tags);
  const addField = db.prepare('INSERT OR IGNORE INTO document_custom_fields (document_id, field_id) SELECT ?, id FROM custom_fields WHERE id = ?');
  for (const f of customFields) addField.run(lastInsertRowid, Number(f));
  autoAssign(lastInsertRowid, content, { hasCorrespondent: !!corr, hasType: !!type, hasFolder: !!fid });
  return { id: lastInsertRowid };
}

// ---------- backup ----------
async function writeBackup(res) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'np-backup-'));
  try {
    db.exec(`VACUUM INTO '${path.join(tmp, 'neopaperless.db').replaceAll("'", "''")}'`);
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="neopaperless-backup-${stamp}.tar.gz"`);
    const tar = spawn('tar', ['-czf', '-', '-C', tmp, 'neopaperless.db', '-C', DATA_DIR, 'documents']);
    await pipeline(tar.stdout, res);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function restoreBackup(req) {
  const tmp = await fsp.mkdtemp(path.join(DATA_DIR, '.restore-'));
  try {
    const archive = path.join(tmp, 'backup.tar.gz');
    await pipeline(req, fs.createWriteStream(archive));
    const out = path.join(tmp, 'out');
    await fsp.mkdir(out);
    await execFileP('tar', ['-xzf', archive, '-C', out, '--no-same-owner', '--no-same-permissions']);
    const newDb = path.join(out, 'neopaperless.db');
    if (!fs.existsSync(newDb)) throw new Error('Archive invalide : base de données absente');
    // A symlink in the archive could expose files outside the data directory once served.
    if ((await fsp.readdir(out, { recursive: true, withFileTypes: true })).some((e) => e.isSymbolicLink()))
      throw new Error('Archive invalide : liens symboliques interdits');
    const { DatabaseSync } = await import('node:sqlite');
    const check = new DatabaseSync(newDb);
    try {
      check.prepare('SELECT count(*) FROM users').get();
    } finally {
      check.close();
    }

    closeDb();
    const old = path.join(tmp, 'old');
    await fsp.mkdir(old);
    for (const f of ['neopaperless.db', 'neopaperless.db-wal', 'neopaperless.db-shm', 'documents']) {
      const p = path.join(DATA_DIR, f);
      if (fs.existsSync(p)) await fsp.rename(p, path.join(old, f));
    }
    try {
      await fsp.rename(newDb, DB_PATH);
      await fsp.rename(path.join(out, 'documents'), FILES_DIR).catch(() => fsp.mkdir(FILES_DIR));
      openDb();
    } catch (err) {
      // Put the previous data back so a failed restore never loses anything.
      closeDb();
      for (const f of await fsp.readdir(old)) {
        await fsp.rm(path.join(DATA_DIR, f), { recursive: true, force: true });
        await fsp.rename(path.join(old, f), path.join(DATA_DIR, f));
      }
      openDb();
      throw err;
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

function newerVersion(latest, current) {
  const a = latest.replace(/^v/, '').split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

// ---------- app ----------
export function createApp() {
  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === '1');
  app.disable('x-powered-by');
  const json = express.json({ limit: '1mb' });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  const np = express.Router();

  np.get('/status', (req, res) => {
    const setupRequired = db.prepare('SELECT count(*) AS n FROM users').get().n === 0;
    res.json({ setupRequired, user: currentUser(req), version: VERSION });
  });

  np.post('/setup', json, (req, res) => {
    if (db.prepare('SELECT count(*) AS n FROM users').get().n > 0) return res.status(403).json({ error: 'Déjà configuré' });
    const creds = validCredentials(req.body);
    if (creds.error) return res.status(400).json(creds);
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)')
      .run(creds.username, hashPassword(creds.password));
    startSession(req, res, lastInsertRowid);
    res.json({ ok: true });
  });

  np.post('/login', json, (req, res) => {
    if (tooManyFailures(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body?.username || '').trim());
    if (!user || !verifyPassword(String(req.body?.password || ''), user.password_hash)) {
      recordFailure(req.ip);
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    startSession(req, res, user.id);
    res.json({ ok: true });
  });

  np.post('/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(readCookie(req, 'np_session') || '');
    res.clearCookie('np_session', { path: '/' });
    res.json({ ok: true });
  });

  // Public share links: no auth, token is the secret.
  app.get(['/s/:token', '/share/:token'], (req, res) => {
    const share = db.prepare('SELECT * FROM shares WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)')
      .get(req.params.token, Date.now());
    if (!share) return res.status(404).send('Lien de partage invalide ou expiré');
    sendFile(res, getDoc(share.document_id), req.query.download === '1');
  });

  const api = express.Router();
  api.use(requireAuth);

  api.get('/tokens', (req, res) => {
    res.json(db.prepare('SELECT rowid AS id, name, substr(token, -4) AS hint FROM sessions WHERE user_id = ? AND name IS NOT NULL ORDER BY rowid')
      .all(req.user.id));
  });

  api.post('/tokens', json, (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    res.status(201).json({ token: createSession(req.user.id, 3650, name) }); // shown once, like a password
  });

  api.delete('/tokens/:id', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE rowid = ? AND user_id = ? AND name IS NOT NULL').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  api.post('/password', json, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body?.current || ''), user.password_hash))
      return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
    const creds = validCredentials({ username: user.username, password: req.body?.next });
    if (creds.error) return res.status(400).json(creds);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(creds.password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, readCookie(req, 'np_session'));
    res.json({ ok: true });
  });

  api.get('/documents', (req, res) => {
    const q = ftsQuery(String(req.query.q || ''));
    const tag = Number(req.query.tag) || null;
    const folder = Number(req.query.folder) || null;
    const where = [], params = [];
    let from = 'documents d', extra = '', order = 'COALESCE(d.doc_date, d.added_at) DESC, d.id DESC';
    if (q) {
      from += ' JOIN documents_fts f ON f.rowid = d.id';
      where.push('documents_fts MATCH ?');
      params.push(q);
      // \u0002/\u0003 mark matches; the client turns them into <mark> without injecting HTML.
      extra = `, snippet(documents_fts, 1, char(2), char(3), '…', 16) AS snippet`;
      order = 'bm25(documents_fts, 10.0, 1.0, 3.0)';
    }
    if (tag) {
      where.push('d.id IN (SELECT document_id FROM document_tags WHERE tag_id = ?)');
      params.push(tag);
    }
    if (folder) {
      // A folder shows its subfolders' documents too.
      where.push(`d.folder_id IN (WITH RECURSIVE sub(id) AS (
        SELECT ? UNION SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id) SELECT id FROM sub)`);
      params.push(folder);
    }
    const sql = `SELECT ${DOC_COLUMNS}${extra} FROM ${from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY ${order} LIMIT 1000`;
    res.json(db.prepare(sql).all(...params).map(rowToDoc));
  });

  // Raw upload: body is the file, name comes from X-Filename. Streams to disk, no size cap in memory.
  api.post('/documents', wrap(async (req, res) => {
    const filename = decodeURIComponent(String(req.headers['x-filename'] || 'document')).replace(/[/\\]/g, '_');
    const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase();
    const tags = String(req.headers['x-tags'] || '').split(',').filter(Boolean);
    const r = await ingest(req, { filename, mime, folder: req.headers['x-folder'], tags });
    if (r.duplicate) return res.status(409).json({ error: 'Ce document existe déjà', id: r.duplicate });
    res.status(201).json(rowToDoc(getDoc(r.id)));
  }));

  api.get('/documents/:id', (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Introuvable' });
    const { content } = db.prepare('SELECT content FROM documents WHERE id = ?').get(doc.id);
    res.json({ ...rowToDoc(doc), content });
  });

  api.patch('/documents/:id', json, (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Introuvable' });
    const b = req.body || {};
    const title = b.title !== undefined ? String(b.title).trim() || doc.title : doc.title;
    const notes = b.notes !== undefined ? String(b.notes) : doc.notes;
    const docDate = b.doc_date !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.doc_date) ? b.doc_date : null) : doc.doc_date;
    const folder = b.folder_id !== undefined ? folderId(b.folder_id) : doc.folder_id;
    const link = (key, table, current) => (b[key] !== undefined ? existingId(table, b[key]) : current);
    db.prepare(`UPDATE documents SET title = ?, notes = ?, doc_date = ?, folder_id = ?, correspondent_id = ?, document_type_id = ?,
      modified = datetime('now') WHERE id = ?`).run(title, notes, docDate, folder,
      link('correspondent_id', 'correspondents', doc.correspondent_id), link('document_type_id', 'document_types', doc.document_type_id), doc.id);
    if (Array.isArray(b.tags)) setTags(doc.id, b.tags);
    res.json(rowToDoc(getDoc(doc.id)));
  });

  api.delete('/documents/:id', wrap(async (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Introuvable' });
    await removeDoc(doc);
    res.json({ ok: true });
  }));

  api.get('/documents/:id/file', (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Introuvable' });
    sendFile(res, doc, req.query.download === '1');
  });

  api.get('/documents/:id/thumb', (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).end();
    sendThumb(res, doc);
  });

  api.get('/documents/:id/shares', (req, res) => {
    res.json(db.prepare('SELECT token, expires_at, created_at FROM shares WHERE document_id = ? ORDER BY created_at DESC')
      .all(req.params.id));
  });

  api.post('/documents/:id/shares', json, (req, res) => {
    if (!getDoc(req.params.id)) return res.status(404).json({ error: 'Introuvable' });
    const days = Number(req.body?.days) || 0;
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = days > 0 ? Date.now() + days * 864e5 : null;
    db.prepare('INSERT INTO shares (token, document_id, expires_at) VALUES (?, ?, ?)').run(token, req.params.id, expires);
    res.status(201).json({ token, expires_at: expires });
  });

  api.delete('/shares/:token', (req, res) => {
    db.prepare('DELETE FROM shares WHERE token = ?').run(req.params.token);
    res.json({ ok: true });
  });

  api.get('/tags', (req, res) => {
    res.json(db.prepare(`SELECT t.*, (SELECT count(*) FROM document_tags WHERE tag_id = t.id) AS count
                         FROM tags t ORDER BY t.name`).all());
  });

  api.post('/tags', json, (req, res) => {
    const name = String(req.body?.name || '').trim();
    const color = /^#[0-9a-f]{6}$/i.test(req.body?.color) ? req.body.color : '#6366f1';
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    try {
      const { lastInsertRowid } = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color);
      res.status(201).json({ id: lastInsertRowid, name, color, count: 0 });
    } catch {
      res.status(409).json({ error: 'Ce tag existe déjà' });
    }
  });

  api.patch('/tags/:id', json, (req, res) => {
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
    if (!tag) return res.status(404).json({ error: 'Introuvable' });
    const name = String(req.body?.name ?? tag.name).trim() || tag.name;
    const color = /^#[0-9a-f]{6}$/i.test(req.body?.color) ? req.body.color : tag.color;
    try {
      db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, tag.id);
    } catch {
      return res.status(409).json({ error: 'Ce tag existe déjà' });
    }
    res.json({ ...tag, name, color });
  });

  api.delete('/tags/:id', (req, res) => {
    db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  api.get('/folders', (req, res) => {
    res.json(db.prepare(`WITH RECURSIVE tree(root, id) AS (
        SELECT id, id FROM folders UNION SELECT t.root, f.id FROM folders f JOIN tree t ON f.parent_id = t.id)
      SELECT f.*, (SELECT count(*) FROM documents d JOIN tree t ON d.folder_id = t.id WHERE t.root = f.id) AS count
      FROM folders f ORDER BY f.name`).all());
  });

  api.post('/folders', json, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    const parentId = folderId(req.body?.parent_id);
    try {
      const { lastInsertRowid } = db.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)').run(name, parentId);
      res.status(201).json({ id: lastInsertRowid, name, parent_id: parentId, count: 0 });
    } catch {
      res.status(409).json({ error: 'Ce dossier existe déjà ici' });
    }
  });

  api.patch('/folders/:id', json, (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.status(404).json({ error: 'Introuvable' });
    const name = String(req.body?.name ?? folder.name).trim() || folder.name;
    const parentId = req.body?.parent_id !== undefined ? folderId(req.body.parent_id) : folder.parent_id;
    // Walk up from the new parent: meeting the folder itself would create a cycle.
    for (let id = parentId; id; id = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(id).parent_id)
      if (id === folder.id) return res.status(400).json({ error: 'Un dossier ne peut pas être déplacé dans lui-même' });
    try {
      db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(name, parentId, folder.id);
    } catch {
      return res.status(409).json({ error: 'Ce dossier existe déjà ici' });
    }
    res.json({ ...folder, name, parent_id: parentId });
  });

  // Subfolders go with it (cascade); their documents stay, without a folder.
  api.delete('/folders/:id', (req, res) => {
    db.prepare('DELETE FROM folders WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  api.get('/backup', wrap((req, res) => writeBackup(res)));

  api.post('/restore', wrap(async (req, res) => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Réservé aux administrateurs' });
    await restoreBackup(req);
    res.json({ ok: true });
  }));

  api.get('/update', wrap(async (req, res) => {
    const r = await fetch(UPDATE_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return res.status(502).json({ error: 'Impossible de contacter le serveur de mises à jour' });
    const release = await r.json();
    res.json({
      current: VERSION, latest: release.tag_name, url: release.html_url, notes: release.body || '',
      available: newerVersion(release.tag_name || '0', VERSION),
    });
  }));

  np.use(api);
  // Native endpoints live under /api/np so /api/* can follow the Paperless-ngx API that third-party apps expect.
  app.use('/api/np', np);
  app.use('/api', paperlessApi({
    json, wrap, currentUser, createSession, verifyPassword, tooManyFailures, recordFailure, getDoc, DOC_COLUMNS,
    sendFile, sendThumb, removeDoc, ingest, setTags, folderId, version: VERSION, publicBase: process.env.PUBLIC_URL,
  }));

  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(dist, 'index.html'), (err) => err && res.status(404).send('Interface non compilée : lancez npm run build'));
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  openDb();
  const port = Number(process.env.PORT) || 3001;
  createApp().listen(port, process.env.HOST || '0.0.0.0', () =>
    console.log(`NeoPaperless ${VERSION} sur http://localhost:${port} (données : ${DATA_DIR})`));
}
