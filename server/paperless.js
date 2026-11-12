import express from 'express';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { db, ftsQuery } from './db.js';

// Paperless-ngx REST API subset, enough for third-party apps (Swift Paperless...).
// Mapping: Neopaperless folders -> storage paths (name = full "A/B" path), tags -> tags.
// Correspondents and document types do not exist here: their lists are empty and their filters match nothing.
const API_MAX = 9;
const TOKEN_DAYS = 3650; // Paperless tokens never expire; apps do not re-login.
const ACTIONS = ['add', 'change', 'delete', 'view'];
const MODELS = ['document', 'tag', 'storagepath', 'correspondent', 'documenttype', 'savedview', 'customfield', 'user', 'group'];
const iso = (s) => (s ? s.replace(' ', 'T') + 'Z' : null);
const csv = (v) => String(v ?? '').split(',').map(Number).filter(Boolean);
const ORDER = {
  created: 'COALESCE(d.doc_date, d.added_at)', added: 'd.added_at', modified: 'd.added_at',
  title: 'd.title COLLATE NOCASE', id: 'd.id', archive_serial_number: 'd.id',
};

export function paperlessApi(ctx) {
  const { json, wrap, currentUser, getDoc, DOC_COLUMNS } = ctx;
  const router = express.Router();
  const tasks = new Map(); // task_id -> result; in memory, only needs to outlive the upload response

  router.use((req, res, next) => {
    // Clients negotiate with "Accept: application/json; version=N" and read the answer from x-api-version.
    req.apiVersion = Math.min(Number(req.headers.accept?.match(/version=(\d+)/)?.[1]) || 1, API_MAX);
    res.setHeader('X-Api-Version', req.apiVersion);
    res.setHeader('X-Version', ctx.version);
    res.setHeader('Access-Control-Expose-Headers', 'X-Api-Version, X-Version');
    next();
  });

  router.post('/token', json, (req, res) => {
    if (ctx.tooManyFailures(req.ip)) return res.status(429).json({ non_field_errors: ['Trop de tentatives'] });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body?.username || '').trim());
    if (!user || !ctx.verifyPassword(String(req.body?.password || ''), user.password_hash)) {
      ctx.recordFailure(req.ip);
      return res.status(400).json({ non_field_errors: ['Unable to log in with provided credentials.'] });
    }
    res.json({ token: ctx.createSession(user.id, TOKEN_DAYS) });
  });

  router.use((req, res, next) => {
    req.user = currentUser(req);
    if (!req.user) return res.status(401).json({ detail: 'Authentication credentials were not provided.' });
    next();
  });

  const base = (req) => ctx.publicBase || `${req.protocol}://${req.get('host')}`;
  const page = (req, rows, count, all) => {
    const size = Math.min(Number(req.query.page_size) || 25, 1000), n = Number(req.query.page) || 1;
    const link = (p) => { const u = new URL(req.originalUrl, base(req)); u.searchParams.set('page', p); return u.toString(); };
    return {
      count, next: n * size < count ? link(n + 1) : null, previous: n > 1 ? link(n - 1) : null,
      ...(all && { all }), results: rows,
    };
  };
  const list = (req, rows) => page(req, rows, rows.length, rows.map((r) => r.id));
  const paged = (req, rows) => {
    const size = Math.min(Number(req.query.page_size) || 25, 1000), n = Number(req.query.page) || 1;
    return page(req, rows.slice((n - 1) * size, n * size), rows.length, rows.map((r) => r.id));
  };

  // ----- serializers -----
  const owner = { owner: null, user_can_change: true, is_shared_by_requester: false };
  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const pTag = (t) => ({
    id: t.id, slug: slug(t.name), name: t.name, color: t.color, text_color: '#ffffff', match: '', matching_algorithm: 0,
    is_insensitive: true, is_inbox_tag: false, document_count: t.count ?? 0, ...owner,
  });
  const folderRows = () => {
    const rows = db.prepare(`WITH RECURSIVE tree(root, id) AS (
        SELECT id, id FROM folders UNION SELECT t.root, f.id FROM folders f JOIN tree t ON f.parent_id = t.id)
      SELECT f.*, (SELECT count(*) FROM documents d JOIN tree t ON d.folder_id = t.id WHERE t.root = f.id) AS count
      FROM folders f`).all();
    const byId = new Map(rows.map((f) => [f.id, f]));
    const full = (f) => (f.parent_id && byId.has(f.parent_id) ? `${full(byId.get(f.parent_id))}/${f.name}` : f.name);
    return rows.map((f) => ({ ...f, path: full(f) })).sort((a, b) => a.path.localeCompare(b.path));
  };
  const pFolder = (f) => ({
    id: f.id, slug: slug(f.path), name: f.path, path: f.path, match: '', matching_algorithm: 0, is_insensitive: true,
    document_count: f.count ?? 0, ...owner,
  });
  const pDoc = (req, row, content) => {
    const created = row.doc_date || row.added_at.slice(0, 10);
    return {
      id: row.id, correspondent: null, document_type: null, storage_path: row.folder_id, title: row.title,
      content, tags: JSON.parse(row.tags), created: req.apiVersion >= 9 ? created : `${created}T00:00:00Z`,
      created_date: created, modified: iso(row.added_at), added: iso(row.added_at), deleted_at: null,
      archive_serial_number: null, original_file_name: row.filename, archived_file_name: null, mime_type: row.mime,
      page_count: null, notes: [], custom_fields: [], ...owner,
    };
  };
  const docOut = (req, id) => {
    const row = getDoc(id);
    if (!row) return null;
    return pDoc(req, row, db.prepare('SELECT content FROM documents WHERE id = ?').get(id).content);
  };

  // ----- documents -----
  const filters = (q) => {
    const where = [], params = [];
    const add = (sql, ...p) => { where.push(sql); params.push(...p); };
    const ids = (v) => csv(v).map(() => '?').join(',') || 'NULL';
    const inFolders = (list) => `d.folder_id IN (WITH RECURSIVE sub(id) AS (
      SELECT value FROM json_each(?) UNION SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id) SELECT id FROM sub)`;
    const like = (col, v) => add(`${col} LIKE ? ESCAPE '\\'`, `%${String(v).replace(/[\\%_]/g, '\\$&')}%`);

    if (q.id__in) add(`d.id IN (${ids(q.id__in)})`, ...csv(q.id__in));
    for (const t of csv(q.tags__id__all)) add('d.id IN (SELECT document_id FROM document_tags WHERE tag_id = ?)', t);
    if (q.tags__id) add('d.id IN (SELECT document_id FROM document_tags WHERE tag_id = ?)', Number(q.tags__id));
    if (q.tags__id__in) add(`d.id IN (SELECT document_id FROM document_tags WHERE tag_id IN (${ids(q.tags__id__in)}))`, ...csv(q.tags__id__in));
    if (q.tags__id__none) add(`d.id NOT IN (SELECT document_id FROM document_tags WHERE tag_id IN (${ids(q.tags__id__none)}))`, ...csv(q.tags__id__none));
    if (q.is_tagged !== undefined) add(`d.id ${/^(1|true)$/i.test(q.is_tagged) ? '' : 'NOT '}IN (SELECT document_id FROM document_tags)`);
    if (/^(1|true)$/i.test(q.is_in_inbox)) add('0'); // no inbox tags here
    for (const key of ['storage_path__id', 'storage_path__id__in']) {
      if (q[key]) add(inFolders(), JSON.stringify(csv(q[key])));
    }
    if (q.storage_path__id__none) add(`NOT COALESCE(${inFolders()}, 0)`, JSON.stringify(csv(q.storage_path__id__none)));
    if (q.storage_path__isnull !== undefined) add(`d.folder_id IS ${/^(1|true)$/i.test(q.storage_path__isnull) ? '' : 'NOT '}NULL`);
    // Correspondents / document types are always empty: asking for one matches nothing, "none" matches all.
    for (const k of ['correspondent', 'document_type']) {
      if (q[`${k}__id`] || q[`${k}__id__in`] || /^(0|false)$/i.test(q[`${k}__isnull`])) add('0');
    }
    if (q.title__icontains) like('d.title', q.title__icontains);
    if (q.content__icontains) like('d.content', q.content__icontains);
    if (q.title_content) { where.push(`(d.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')`); const v = `%${String(q.title_content).replace(/[\\%_]/g, '\\$&')}%`; params.push(v, v); }
    const ops = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
    for (const [key, v] of Object.entries(q)) {
      const m = key.match(/^(created|added)(?:__date)?__(gt|gte|lt|lte)$/);
      if (m && /^\d{4}-\d{2}-\d{2}/.test(v)) add(`date(${m[1] === 'created' ? ORDER.created : 'd.added_at'}) ${ops[m[2]]} date(?)`, String(v).slice(0, 10));
    }
    return { where, params };
  };

  router.get('/documents', (req, res) => {
    const { where, params } = filters(req.query);
    const search = ftsQuery(String(req.query.query || ''));
    let from = 'documents d', extra = '';
    let order = ORDER[String(req.query.ordering || '').replace(/^-/, '')] || ORDER.created;
    order += String(req.query.ordering || '-created').startsWith('-') ? ' DESC' : ' ASC';
    if (search) {
      from += ' JOIN documents_fts f ON f.rowid = d.id';
      where.push('documents_fts MATCH ?');
      params.push(search);
      extra = `, snippet(documents_fts, 1, char(2), char(3), '…', 16) AS snippet, bm25(documents_fts, 10.0, 1.0, 3.0) AS rank`;
      if (!req.query.ordering) order = 'rank';
    }
    const rows = db.prepare(`SELECT ${DOC_COLUMNS}, substr(d.content, 1, 300) AS excerpt${extra} FROM ${from}
      ${where.length ? 'WHERE ' + where.map((w) => `(${w})`).join(' AND ') : ''} ORDER BY ${order}, d.id DESC`).all(...params);
    const fields = String(req.query.fields || '').split(',').filter(Boolean);
    const docs = rows.map((r, i) => {
      const doc = pDoc(req, r, r.excerpt);
      if (search) {
        const esc = (r.snippet || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        doc.__search_hit__ = {
          score: -r.rank, rank: i, note_highlights: '',
          highlights: esc.replace(/\u0002/g, '<span class="match">').replace(/\u0003/g, '</span>'),
        };
      }
      return fields.length ? Object.fromEntries(fields.filter((f) => f in doc).map((f) => [f, doc[f]])) : doc;
    });
    const out = paged(req, docs);
    out.all = rows.map((r) => r.id);
    res.json(out);
  });

  // Upload is "multipart/form-data"; the answer is a task id the app polls through /tasks/.
  // shortcut: Request.formData() buffers the whole file in memory, switch to a streaming parser for multi-GB uploads.
  router.post('/documents/post_document', wrap(async (req, res) => {
    const form = await new Request('http://localhost/', {
      method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half',
    }).formData().catch(() => null);
    const file = form?.get('document');
    if (!file || typeof file === 'string') return res.status(400).json({ document: ['No document was provided.'] });
    const created = String(form.get('created') || '').slice(0, 10);
    const taskId = crypto.randomUUID();
    const r = await ctx.ingest(Readable.fromWeb(file.stream()), {
      filename: (file.name || 'document').replace(/[/\\]/g, '_'),
      mime: (file.type || 'application/octet-stream').split(';')[0].toLowerCase(),
      title: String(form.get('title') || '').trim() || undefined,
      docDate: /^\d{4}-\d{2}-\d{2}$/.test(created) ? created : null,
      folder: form.get('storage_path'),
      tags: form.getAll('tags'),
    });
    tasks.set(taskId, r.duplicate
      ? { status: 'FAILURE', result: `Not consuming ${file.name}: It is a duplicate of document #${r.duplicate}`, related_document: null }
      : { status: 'SUCCESS', result: `Success. New document id ${r.id} created`, related_document: String(r.id) });
    res.json(taskId);
  }));

  router.get('/tasks', (req, res) => {
    const out = [...tasks].map(([task_id, t]) => ({
      id: 0, task_id, task_file_name: null, task_name: 'consume_file', date_created: null, date_done: null,
      type: 'file', acknowledged: false, ...t,
    })).filter((t) => !req.query.task_id || t.task_id === req.query.task_id);
    res.json(out);
  });

  router.post('/documents/bulk_edit', json, wrap(async (req, res) => {
    const { documents = [], method, parameters = {} } = req.body || {};
    const docs = documents.map((id) => getDoc(id)).filter(Boolean);
    for (const doc of docs) {
      const tags = JSON.parse(doc.tags);
      if (method === 'delete') await ctx.removeDoc(doc);
      else if (method === 'set_storage_path') db.prepare('UPDATE documents SET folder_id = ? WHERE id = ?').run(ctx.folderId(parameters.storage_path), doc.id);
      else if (method === 'add_tag') ctx.setTags(doc.id, [...tags, parameters.tag]);
      else if (method === 'remove_tag') ctx.setTags(doc.id, tags.filter((t) => t !== parameters.tag));
      else if (method === 'modify_tags') ctx.setTags(doc.id, [...tags.filter((t) => !(parameters.remove_tags || []).includes(t)), ...(parameters.add_tags || [])]);
      else return res.status(400).json({ detail: `Unsupported method ${method}` });
    }
    res.json({ result: 'OK' });
  }));

  router.get('/documents/:id', (req, res) => {
    const doc = docOut(req, req.params.id);
    doc ? res.json(doc) : res.status(404).json({ detail: 'Not found.' });
  });

  const update = (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).json({ detail: 'Not found.' });
    const b = req.body || {};
    const created = String(b.created_date ?? b.created ?? '').slice(0, 10);
    db.prepare('UPDATE documents SET title = ?, doc_date = ?, folder_id = ? WHERE id = ?').run(
      b.title !== undefined ? String(b.title).trim() || doc.title : doc.title,
      /^\d{4}-\d{2}-\d{2}$/.test(created) ? created : doc.doc_date,
      b.storage_path !== undefined ? ctx.folderId(b.storage_path) : doc.folder_id, doc.id);
    if (Array.isArray(b.tags)) ctx.setTags(doc.id, b.tags);
    res.json(docOut(req, doc.id));
  };
  router.patch('/documents/:id', json, update);
  router.put('/documents/:id', json, update);

  router.delete('/documents/:id', wrap(async (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).json({ detail: 'Not found.' });
    await ctx.removeDoc(doc);
    res.status(204).end();
  }));

  const withDoc = (fn) => (req, res) => {
    const doc = getDoc(req.params.id);
    return doc ? fn(req, res, doc) : res.status(404).json({ detail: 'Not found.' });
  };
  router.get('/documents/:id/download', withDoc((req, res, doc) => ctx.sendFile(res, doc, true)));
  router.get('/documents/:id/preview', withDoc((req, res, doc) => ctx.sendFile(res, doc, false)));
  router.get('/documents/:id/thumb', withDoc((req, res, doc) => ctx.sendThumb(res, doc)));
  router.get('/documents/:id/metadata', withDoc((req, res, doc) => {
    const { sha256 } = db.prepare('SELECT sha256 FROM documents WHERE id = ?').get(doc.id);
    res.json({
      original_checksum: sha256, original_size: doc.size, original_mime_type: doc.mime, media_filename: doc.filename,
      has_archive_version: false, original_metadata: [], archive_checksum: null, archive_media_filename: null,
      original_filename: doc.filename, lang: null, archive_size: null, archive_metadata: null,
    });
  }));
  router.get('/documents/:id/suggestions', withDoc((req, res) =>
    res.json({ correspondents: [], tags: [], document_types: [], storage_paths: [], dates: [] })));
  router.get('/documents/:id/notes', withDoc((req, res) => res.json([])));
  router.get('/documents/:id/history', withDoc((req, res) => res.json([])));

  // ----- tags -----
  const tagRows = () => db.prepare(`SELECT t.*, (SELECT count(*) FROM document_tags WHERE tag_id = t.id) AS count
    FROM tags t ORDER BY t.name`).all();
  const color = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v) ? v : fallback);
  const dup = (res) => res.status(400).json({ name: ['Object with this name already exists.'] });

  router.get('/tags', (req, res) => {
    const name = String(req.query.name__icontains || '').toLowerCase();
    const rows = tagRows().filter((t) => t.name.toLowerCase().includes(name));
    res.json(paged(req, rows.map(pTag)));
  });
  router.get('/tags/:id', (req, res) => {
    const t = tagRows().find((r) => r.id === Number(req.params.id));
    t ? res.json(pTag(t)) : res.status(404).json({ detail: 'Not found.' });
  });
  router.post('/tags', json, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ name: ['This field is required.'] });
    try {
      const { lastInsertRowid } = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color(req.body.color, '#6366f1'));
      res.status(201).json(pTag(tagRows().find((t) => t.id === lastInsertRowid)));
    } catch { dup(res); }
  });
  router.patch('/tags/:id', json, (req, res) => {
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
    if (!tag) return res.status(404).json({ detail: 'Not found.' });
    try {
      db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(
        String(req.body?.name ?? tag.name).trim() || tag.name, color(req.body?.color, tag.color), tag.id);
    } catch { return dup(res); }
    res.json(pTag(tagRows().find((t) => t.id === tag.id)));
  });
  router.delete('/tags/:id', (req, res) => {
    db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  // ----- storage paths (= folders) -----
  router.get('/storage_paths', (req, res) => {
    const name = String(req.query.name__icontains || '').toLowerCase();
    res.json(paged(req, folderRows().filter((f) => f.path.toLowerCase().includes(name)).map(pFolder)));
  });
  router.get('/storage_paths/:id', (req, res) => {
    const f = folderRows().find((r) => r.id === Number(req.params.id));
    f ? res.json(pFolder(f)) : res.status(404).json({ detail: 'Not found.' });
  });
  router.post('/storage_paths', json, (req, res) => {
    // "A/B" creates the missing folders along the way.
    const parts = String(req.body?.name || '').split('/').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return res.status(400).json({ name: ['This field is required.'] });
    let parent = null, created = false;
    for (const name of parts) {
      const hit = db.prepare('SELECT id FROM folders WHERE name = ? AND parent_id IS ?').get(name, parent);
      created = !hit;
      parent = hit?.id ?? db.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)').run(name, parent).lastInsertRowid;
    }
    if (!created) return dup(res);
    res.status(201).json(pFolder(folderRows().find((f) => f.id === parent)));
  });
  // shortcut: PATCH renames the folder (last path segment) but never moves it; moving stays in the Neopaperless UI.
  router.patch('/storage_paths/:id', json, (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.status(404).json({ detail: 'Not found.' });
    const name = String(req.body?.name || '').split('/').pop().trim() || folder.name;
    try { db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, folder.id); } catch { return dup(res); }
    res.json(pFolder(folderRows().find((f) => f.id === folder.id)));
  });
  router.delete('/storage_paths/:id', (req, res) => {
    db.prepare('DELETE FROM folders WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  // ----- always-empty collections and misc -----
  for (const name of ['correspondents', 'document_types', 'saved_views', 'custom_fields', 'groups', 'share_links', 'mail_accounts'])
    router.get(`/${name}`, (req, res) => res.json(page(req, [], 0, [])));

  const me = (u) => ({ id: u.id, username: u.username, is_superuser: !!u.is_admin, is_staff: !!u.is_admin, first_name: '', last_name: '', groups: [] });
  router.get('/users', (req, res) => res.json(list(req, db.prepare('SELECT id, username, is_admin FROM users').all().map(me))));
  router.get('/ui_settings', (req, res) => res.json({
    user: me(req.user), settings: { language: 'fr-FR' },
    permissions: ACTIONS.flatMap((a) => MODELS.map((m) => `${a}_${m}`)),
  }));
  router.get('/remote_version', (req, res) => res.json({ version: ctx.version, update_available: false }));
  router.get('/statistics', (req, res) => {
    const { n, chars } = db.prepare('SELECT count(*) AS n, COALESCE(sum(length(content)), 0) AS chars FROM documents').get();
    res.json({
      documents_total: n, documents_inbox: 0, inbox_tag: null, inbox_tags: [], character_count: chars,
      tag_count: db.prepare('SELECT count(*) AS n FROM tags').get().n, correspondent_count: 0, document_type_count: 0,
      storage_path_count: db.prepare('SELECT count(*) AS n FROM folders').get().n,
      current_asn: null, document_file_type_counts: [],
    });
  });
  router.get('/search/autocomplete', (req, res) => {
    const term = String(req.query.term || '').toLowerCase();
    const limit = Number(req.query.limit) || 10;
    res.json(term ? db.prepare('SELECT DISTINCT lower(title) AS t FROM documents WHERE lower(title) LIKE ? ESCAPE \'\\\' LIMIT ?')
      .all(`${term.replace(/[\\%_]/g, '\\$&')}%`, limit).map((r) => r.t) : []);
  });

  router.use((req, res) => res.status(404).json({ detail: 'Not found.' }));
  return router;
}
