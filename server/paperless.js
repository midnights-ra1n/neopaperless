import express from 'express';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { db, ftsQuery } from './db.js';
import { suggest } from './matching.js';

// Paperless-ngx REST API subset, enough for third-party apps (Swift Paperless...).
// Mapping: Neopaperless folders -> storage paths (name = full "A/B" path), tags -> tags.
// Real: tags, storage paths, correspondents, document types, ASN, notes, custom fields, saved views, matching rules.
// Empty lists: groups, mail accounts/rules, workflows, trash (deletion is permanent).
const API_MAX = 9;
const TOKEN_DAYS = 3650; // Paperless tokens never expire; apps do not re-login.
const ACTIONS = ['add', 'change', 'delete', 'view'];
const MODELS = ['document', 'tag', 'storagepath', 'correspondent', 'documenttype', 'savedview', 'customfield', 'user', 'group'];
const iso = (s) => (s ? s.replace(' ', 'T') + 'Z' : null);
const MATCH = (o) => ({ match: o.match ?? '', matching_algorithm: o.matching_algorithm ?? 0, is_insensitive: !!(o.is_insensitive ?? 1) });
const csv = (v) => String(v ?? '').split(',').map(Number).filter(Boolean);
const ORDER = {
  created: 'COALESCE(d.doc_date, d.added_at)', added: 'd.added_at', modified: 'd.added_at',
  title: 'd.title COLLATE NOCASE', id: 'd.id', archive_serial_number: 'd.asn', correspondent__name: '(SELECT name FROM correspondents WHERE id = d.correspondent_id)',
  document_type__name: '(SELECT name FROM document_types WHERE id = d.document_type_id)',
};

export function paperlessApi(ctx) {
  const { json, wrap, currentUser, getDoc, DOC_COLUMNS } = ctx;
  const router = express.Router();
  const tasks = new Map(); // task_id -> result; in memory, only needs to outlive the upload response

  // Browser-based clients (Obsidian mobile, web apps) call from another origin. Only the Authorization header
  // authenticates them: browsers never send our cookie on a wildcard cross-origin request.
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

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
    id: t.id, slug: slug(t.name), name: t.name, color: t.color, text_color: '#ffffff', ...MATCH(t),
    is_inbox_tag: false, document_count: t.count ?? 0, ...owner,
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
    id: f.id, slug: slug(f.path), name: f.path, path: f.path, ...MATCH(f),
    document_count: f.count ?? 0, ...owner,
  });
  const CF_SQL = `(SELECT json_group_array(json_object('field', c.field_id, 'value', json(c.value)))
    FROM document_custom_fields c WHERE c.document_id = d.id) AS cf_json`;
  const pNote = (n) => ({ ...n, created: iso(n.created) });
  const NOTES_SQL = `(SELECT json_group_array(json_object('id', n.id, 'note', n.note, 'created', n.created_at,
    'user', json_object('id', u.id, 'username', u.username, 'first_name', '', 'last_name', '')))
    FROM document_notes n JOIN users u ON u.id = n.user_id WHERE n.document_id = d.id) AS notes_json`;
  const pDoc = (req, row, content) => {
    const created = row.doc_date || row.added_at.slice(0, 10);
    return {
      id: row.id, correspondent: row.correspondent_id, document_type: row.document_type_id, storage_path: row.folder_id, title: row.title,
      content, tags: JSON.parse(row.tags), created: req.apiVersion >= 9 ? created : `${created}T00:00:00Z`,
      created_date: created, modified: iso(row.modified || row.added_at), added: iso(row.added_at), deleted_at: null,
      archive_serial_number: row.asn, original_file_name: row.filename, archived_file_name: null, mime_type: row.mime,
      page_count: null, notes: row.notes_json ? JSON.parse(row.notes_json).map(pNote) : [], custom_fields: row.cf_json ? JSON.parse(row.cf_json) : [], ...owner,
    };
  };
  const docOut = (req, id) => {
    const row = getDoc(id);
    if (!row) return null;
    const { content, ...extra } = db.prepare(`SELECT d.content, ${NOTES_SQL}, ${CF_SQL} FROM documents d WHERE d.id = ?`).get(id);
    return pDoc(req, { ...row, ...extra }, content);
  };

  // ----- documents -----
  // custom_field_query: ["AND", [expr...]] | ["OR", [expr...]] | ["NOT", expr] | [field name or id, operator, value]
  const customFieldQuery = (node, depth = 0) => {
    if (depth > 8 || !Array.isArray(node)) throw new Error('bad query');
    const [a, b, c] = node;
    if (a === 'AND' || a === 'OR') {
      const parts = b.map((n) => customFieldQuery(n, depth + 1));
      return [`(${parts.map((p) => p[0]).join(` ${a} `)})`, ...parts.flatMap((p) => p.slice(1))];
    }
    if (a === 'NOT') { const [sql, ...p] = customFieldQuery(b, depth + 1); return [`NOT (${sql})`, ...p]; }
    const v = typeof c === 'boolean' ? Number(c) : c, V = 'json_extract(x.value, \'$\')';
    const like = (pre, post) => [`LOWER(${V}) LIKE ? ESCAPE '\\'`, `${pre}${String(c).toLowerCase().replace(/[\\%_]/g, '\\$&')}${post}`];
    const list = Array.isArray(c) ? c : []; // only `in` and `range` take a list
    const ops = {
      exact: [`${V} = ?`, v], gt: [`${V} > ?`, v], gte: [`${V} >= ?`, v], lt: [`${V} < ?`, v], lte: [`${V} <= ?`, v],
      in: [`${V} IN (${list.map(() => '?').join(',') || 'NULL'})`, ...list],
      range: [`${V} BETWEEN ? AND ?`, ...list.slice(0, 2)], isnull: [`${V} IS ${c ? '' : 'NOT '}NULL`],
      icontains: like('%', '%'), istartswith: like('', '%'), iendswith: like('%', ''), exists: ['1'],
    };
    if (!ops[b]) throw new Error('bad operator');
    const [cond, ...p] = ops[b];
    const inner = `SELECT 1 FROM document_custom_fields x WHERE x.document_id = d.id AND x.field_id = (SELECT id FROM custom_fields WHERE id = ? OR name = ?) AND ${cond}`;
    return [b === 'exists' && !c ? `NOT EXISTS (${inner})` : `EXISTS (${inner})`, Number(a) || 0, String(a), ...p];
  };
  const filters = (q) => {
    const where = [], params = [];
    const add = (sql, ...p) => { where.push(sql); params.push(...p); };
    const ids = (v) => csv(v).map(() => '?').join(',') || 'NULL';
    const yes = (v) => /^(1|true)$/i.test(v);
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
    for (const [k, col] of [['correspondent', 'd.correspondent_id'], ['document_type', 'd.document_type_id']]) {
      if (q[`${k}__id`]) add(`${col} = ?`, Number(q[`${k}__id`]));
      if (q[`${k}__id__in`]) add(`${col} IN (${ids(q[`${k}__id__in`])})`, ...csv(q[`${k}__id__in`]));
      if (q[`${k}__id__none`]) add(`${col} IS NULL OR ${col} NOT IN (${ids(q[`${k}__id__none`])})`, ...csv(q[`${k}__id__none`]));
      if (q[`${k}__isnull`] !== undefined) add(`${col} IS ${yes(q[`${k}__isnull`]) ? '' : 'NOT '}NULL`);
    }
    if (q.archive_serial_number) add('d.asn = ?', Number(q.archive_serial_number));
    if (q.archive_serial_number__gt) add('d.asn > ?', Number(q.archive_serial_number__gt));
    if (q.archive_serial_number__lt) add('d.asn < ?', Number(q.archive_serial_number__lt));
    if (q.archive_serial_number__isnull !== undefined) add(`d.asn IS ${yes(q.archive_serial_number__isnull) ? '' : 'NOT '}NULL`);
    for (const id of csv(q.custom_fields__id__all)) add('d.id IN (SELECT document_id FROM document_custom_fields WHERE field_id = ?)', id);
    if (q.custom_fields__id__in) add(`d.id IN (SELECT document_id FROM document_custom_fields WHERE field_id IN (${ids(q.custom_fields__id__in)}))`, ...csv(q.custom_fields__id__in));
    if (q.custom_fields__id__none) add(`d.id NOT IN (SELECT document_id FROM document_custom_fields WHERE field_id IN (${ids(q.custom_fields__id__none)}))`, ...csv(q.custom_fields__id__none));
    if (q.has_custom_fields !== undefined) add(`d.id ${yes(q.has_custom_fields) ? '' : 'NOT '}IN (SELECT document_id FROM document_custom_fields)`);
    if (q.custom_field_query) {
      try { add(...customFieldQuery(JSON.parse(q.custom_field_query))); } catch { add('0'); }
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
    const join = search ? 'documents d JOIN documents_fts f ON f.rowid = d.id' : 'documents d';
    const field = String(req.query.ordering || '').replace(/^-/, '');
    let order = ORDER[field] || (/^custom_field_\d+$/.test(field)
      ? `(SELECT json_extract(value, '$') FROM document_custom_fields WHERE document_id = d.id AND field_id = ${Number(field.slice(13))})` : ORDER.created);
    order += String(req.query.ordering || '-created').startsWith('-') ? ' DESC' : ' ASC';
    if (search) {
      where.push('documents_fts MATCH ?');
      params.push(search);
      if (!req.query.ordering) order = 'rank';
    }
    // Ids of every match first (cheap), then full rows for the requested page only.
    const all = db.prepare(`SELECT d.id${search ? ", bm25(documents_fts, 10.0, 1.0, 3.0) AS rank" : ''} FROM ${join}
      ${where.length ? 'WHERE ' + where.map((w) => `(${w})`).join(' AND ') : ''} ORDER BY ${order}, d.id DESC`).all(...params);
    const size = Math.min(Number(req.query.page_size) || 25, 1000), n = Number(req.query.page) || 1;
    const pageIds = all.slice((n - 1) * size, n * size).map((r) => r.id);
    const byId = new Map(db.prepare(`SELECT ${DOC_COLUMNS}, substr(d.content, 1, 300) AS excerpt, ${NOTES_SQL}, ${CF_SQL}
      ${search ? ", snippet(documents_fts, 1, char(2), char(3), '…', 16) AS snippet" : ''} FROM ${join}
      WHERE d.id IN (${pageIds.map(() => '?').join(',') || 'NULL'})${search ? ' AND documents_fts MATCH ?' : ''}`)
      .all(...pageIds, ...(search ? [search] : [])).map((r) => [r.id, r]));
    const fields = String(req.query.fields || '').split(',').filter(Boolean);
    const docs = pageIds.map((id, i) => {
      const r = byId.get(id), doc = pDoc(req, r, r.excerpt);
      if (search) {
        const esc = (r.snippet || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        doc.__search_hit__ = {
          score: -all[(n - 1) * size + i].rank, rank: (n - 1) * size + i, note_highlights: '',
          highlights: esc.replace(/\u0002/g, '<span class="match">').replace(/\u0003/g, '</span>'),
        };
      }
      return fields.length ? Object.fromEntries(fields.filter((f) => f in doc).map((f) => [f, doc[f]])) : doc;
    });
    res.json(page(req, docs, all.length, all.map((r) => r.id)));
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
      correspondent: form.get('correspondent'), documentType: form.get('document_type'), asn: form.get('archive_serial_number'),
      customFields: form.getAll('custom_fields').flatMap((v) => { try { const j = JSON.parse(v); return Array.isArray(j) ? j : [j]; } catch { return []; } }),
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
      else if (method === 'set_correspondent') applyMeta(doc.id, { correspondent: parameters.correspondent });
      else if (method === 'set_document_type') applyMeta(doc.id, { document_type: parameters.document_type });
      else if (method === 'modify_custom_fields') {
        const add = parameters.add_custom_fields, now = db.prepare('SELECT field_id AS field, json(value) AS value FROM document_custom_fields WHERE document_id = ?').all(doc.id)
          .map((r) => ({ field: r.field, value: JSON.parse(r.value) }));
        const added = Array.isArray(add) ? add.map((f) => ({ field: f, value: null })) : Object.entries(add || {}).map(([field, value]) => ({ field, value }));
        const gone = (parameters.remove_custom_fields || []).map(Number);
        const next = [...now.filter((f) => !gone.includes(f.field) && !added.some((a) => Number(a.field) === f.field)), ...added];
        const err = setFields(doc.id, next);
        if (err) return res.status(400).json({ detail: err });
      }
      else if (method === 'add_tag') ctx.setTags(doc.id, [...tags, parameters.tag]);
      else if (method === 'remove_tag') ctx.setTags(doc.id, tags.filter((t) => t !== parameters.tag));
      else if (method === 'modify_tags') ctx.setTags(doc.id, [...tags.filter((t) => !(parameters.remove_tags || []).includes(t)), ...(parameters.add_tags || [])]);
      else return res.status(400).json({ detail: `Unsupported method ${method}` });
    }
    for (const doc of docs) if (method !== 'delete') touch(doc.id);
    res.json({ result: 'OK' });
  }));

  router.get('/', (req, res) => res.json(Object.fromEntries(['documents', 'correspondents', 'document_types', 'tags', 'storage_paths',
    'saved_views', 'custom_fields', 'tasks', 'status', 'statistics', 'profile', 'share_links', 'users', 'ui_settings']
    .map((k) => [k, `${base(req)}/api/${k}/`]))));
  router.get('/documents/next_asn', (req, res) =>
    res.json((db.prepare('SELECT max(asn) AS m FROM documents').get().m || 0) + 1));

  router.get('/documents/:id', (req, res) => {
    const doc = docOut(req, req.params.id);
    doc ? res.json(doc) : res.status(404).json({ detail: 'Not found.' });
  });

  // Only touches the fields present in `b`; null clears. Throws if the ASN is already taken.
  const applyMeta = (id, b) => {
    const exists = (table, v) => (v == null || v === '' ? null : db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(Number(v))?.id ?? null);
    if ('correspondent' in b) db.prepare('UPDATE documents SET correspondent_id = ? WHERE id = ?').run(exists('correspondents', b.correspondent), id);
    if ('document_type' in b) db.prepare('UPDATE documents SET document_type_id = ? WHERE id = ?').run(exists('document_types', b.document_type), id);
    if ('archive_serial_number' in b) db.prepare('UPDATE documents SET asn = ? WHERE id = ?').run(b.archive_serial_number == null || b.archive_serial_number === '' ? null : Number(b.archive_serial_number), id);
  };

  const touch = (id) => db.prepare("UPDATE documents SET modified = datetime('now') WHERE id = ?").run(id);

  const valid = {
    string: (v) => typeof v === 'string', longtext: (v) => typeof v === 'string', url: (v) => typeof v === 'string',
    date: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v), boolean: (v) => typeof v === 'boolean',
    integer: Number.isInteger, float: (v) => typeof v === 'number', monetary: (v) => typeof v === 'string' || typeof v === 'number',
    documentlink: (v) => Array.isArray(v) && v.every(Number.isInteger), select: (v) => typeof v === 'string',
  };
  // Replaces the document's custom field values with [{field, value}]; returns an error message or null.
  const setFields = (docId, list) => {
    const fields = new Map(db.prepare('SELECT id, data_type FROM custom_fields').all().map((f) => [f.id, f.data_type]));
    for (const { field, value } of list) {
      if (!fields.has(Number(field))) return `Invalid pk "${field}" - object does not exist.`;
      if (value != null && !valid[fields.get(Number(field))](value)) return `Value not valid for field ${field}.`;
    }
    db.prepare('DELETE FROM document_custom_fields WHERE document_id = ?').run(docId);
    for (const { field, value } of list)
      db.prepare('INSERT OR REPLACE INTO document_custom_fields (document_id, field_id, value) VALUES (?, ?, ?)').run(docId, Number(field), JSON.stringify(value ?? null));
    return null;
  };

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
    try { applyMeta(doc.id, b); } catch {
      return res.status(400).json({ archive_serial_number: ['Document with this Archive Serial Number already exists.'] });
    }
    if (Array.isArray(b.custom_fields)) {
      const err = setFields(doc.id, b.custom_fields);
      if (err) return res.status(400).json({ custom_fields: [err] });
    }
    touch(doc.id);
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
  router.get('/documents/:id/suggestions', withDoc((req, res, doc) => {
    res.json({ ...suggest(db.prepare('SELECT content FROM documents WHERE id = ?').get(doc.id).content), dates: [] });
  }));
  const noteList = (id) => db.prepare(`SELECT n.id, n.note, n.created_at AS created, json_object('id', u.id, 'username', u.username, 'first_name', '', 'last_name', '') AS user
    FROM document_notes n JOIN users u ON u.id = n.user_id WHERE n.document_id = ? ORDER BY n.id`).all(id)
    .map((n) => pNote({ ...n, user: JSON.parse(n.user) }));
  router.get('/documents/:id/notes', withDoc((req, res, doc) => res.json(noteList(doc.id))));
  router.post('/documents/:id/notes', json, withDoc((req, res, doc) => {
    const note = String(req.body?.note || '').trim();
    if (!note) return res.status(400).json({ note: ['This field is required.'] });
    db.prepare('INSERT INTO document_notes (document_id, user_id, note) VALUES (?, ?, ?)').run(doc.id, req.user.id, note);
    touch(doc.id);
    res.status(201).json(noteList(doc.id));
  }));
  router.delete('/documents/:id/notes', withDoc((req, res, doc) => {
    db.prepare('DELETE FROM document_notes WHERE id = ? AND document_id = ?').run(Number(req.query.id), doc.id);
    res.json(noteList(doc.id));
  }));
  router.get('/documents/:id/history', withDoc((req, res) => res.json([])));

  // ----- tags -----
  const tagRows = () => db.prepare(`SELECT t.*, (SELECT count(*) FROM document_tags WHERE tag_id = t.id) AS count
    FROM tags t ORDER BY t.name`).all();
  const color = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v) ? v : fallback);
  const matchOf = (b, cur = {}) => {
    const algo = b?.matching_algorithm !== undefined ? Number(b.matching_algorithm) : cur.matching_algorithm ?? 0;
    return [b?.match !== undefined ? String(b.match) : cur.match ?? '', algo >= 0 && algo <= 6 ? algo : 0,
      b?.is_insensitive !== undefined ? (b.is_insensitive ? 1 : 0) : cur.is_insensitive ?? 1];
  };
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
      const { lastInsertRowid } = db.prepare('INSERT INTO tags (name, color, match, matching_algorithm, is_insensitive) VALUES (?, ?, ?, ?, ?)').run(name, color(req.body.color, '#6366f1'), ...matchOf(req.body));
      res.status(201).json(pTag(tagRows().find((t) => t.id === lastInsertRowid)));
    } catch { dup(res); }
  });
  router.patch('/tags/:id', json, (req, res) => {
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
    if (!tag) return res.status(404).json({ detail: 'Not found.' });
    try {
      db.prepare('UPDATE tags SET name = ?, color = ?, match = ?, matching_algorithm = ?, is_insensitive = ? WHERE id = ?').run(
        String(req.body?.name ?? tag.name).trim() || tag.name, color(req.body?.color, tag.color), ...matchOf(req.body, tag), tag.id);
    } catch { return dup(res); }
    res.json(pTag(tagRows().find((t) => t.id === tag.id)));
  });
  router.delete('/tags/:id', (req, res) => {
    db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  // ----- correspondents and document types: same shape, one helper -----
  for (const [name, table, col] of [['correspondents', 'correspondents', 'correspondent_id'], ['document_types', 'document_types', 'document_type_id']]) {
    const rows = () => db.prepare(`SELECT o.*, (SELECT count(*) FROM documents WHERE ${col} = o.id) AS count FROM ${table} o ORDER BY o.name`).all();
    const out = (o) => ({
      id: o.id, slug: slug(o.name), name: o.name, ...MATCH(o), document_count: o.count,
      ...(name === 'correspondents' && { last_correspondence: null }), ...owner,
    });
    const save = (req, res, id) => {
      const current = id && db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      if (id && !current) return res.status(404).json({ detail: 'Not found.' });
      const value = String(req.body?.name ?? current?.name ?? '').trim();
      if (!value) return res.status(400).json({ name: ['This field is required.'] });
      try {
        const newId = id ? (db.prepare(`UPDATE ${table} SET name = ?, match = ?, matching_algorithm = ?, is_insensitive = ? WHERE id = ?`).run(value, ...matchOf(req.body, current), id), id)
          : db.prepare(`INSERT INTO ${table} (name, match, matching_algorithm, is_insensitive) VALUES (?, ?, ?, ?)`).run(value, ...matchOf(req.body)).lastInsertRowid;
        res.status(id ? 200 : 201).json(out(rows().find((o) => o.id === Number(newId))));
      } catch { dup(res); }
    };
    router.get(`/${name}`, (req, res) => {
      const q = String(req.query.name__icontains || '').toLowerCase(), ids = csv(req.query.id__in);
      res.json(paged(req, rows().filter((o) => o.name.toLowerCase().includes(q) && (!ids.length || ids.includes(o.id))).map(out)));
    });
    router.get(`/${name}/:id`, (req, res) => {
      const o = rows().find((r) => r.id === Number(req.params.id));
      o ? res.json(out(o)) : res.status(404).json({ detail: 'Not found.' });
    });
    router.post(`/${name}`, json, (req, res) => save(req, res));
    router.patch(`/${name}/:id`, json, (req, res) => save(req, res, Number(req.params.id)));
    router.put(`/${name}/:id`, json, (req, res) => save(req, res, Number(req.params.id)));
    router.delete(`/${name}/:id`, (req, res) => {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
      res.status(204).end();
    });
  }

  // ----- custom fields -----
  const fieldRows = () => db.prepare(`SELECT c.*, (SELECT count(*) FROM document_custom_fields WHERE field_id = c.id) AS count FROM custom_fields c ORDER BY c.name`).all();
  const pField = (f) => ({ id: f.id, name: f.name, data_type: f.data_type, extra_data: JSON.parse(f.extra_data), document_count: f.count, created: null, ...owner });
  const saveField = (req, res, id) => {
    const cur = id && db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(id);
    if (id && !cur) return res.status(404).json({ detail: 'Not found.' });
    const name = String(req.body?.name ?? cur?.name ?? '').trim(), type = cur?.data_type ?? req.body?.data_type; // the type cannot change
    if (!name) return res.status(400).json({ name: ['This field is required.'] });
    if (!valid[type]) return res.status(400).json({ data_type: [`"${type}" is not a valid choice.`] });
    const extra = { ...JSON.parse(cur?.extra_data ?? '{}'), ...(req.body?.extra_data || {}) };
    if (type === 'select') extra.select_options = (extra.select_options || []).map((o) => ({ id: o.id ?? crypto.randomBytes(8).toString('hex'), label: o.label }));
    try {
      const newId = id ? (db.prepare('UPDATE custom_fields SET name = ?, extra_data = ? WHERE id = ?').run(name, JSON.stringify(extra), id), id)
        : db.prepare('INSERT INTO custom_fields (name, data_type, extra_data) VALUES (?, ?, ?)').run(name, type, JSON.stringify(extra)).lastInsertRowid;
      res.status(id ? 200 : 201).json(pField(fieldRows().find((f) => f.id === Number(newId))));
    } catch { dup(res); }
  };
  router.get('/custom_fields', (req, res) => {
    const q = String(req.query.name__icontains || '').toLowerCase();
    res.json(paged(req, fieldRows().filter((f) => f.name.toLowerCase().includes(q)).map(pField)));
  });
  router.get('/custom_fields/:id', (req, res) => {
    const f = fieldRows().find((r) => r.id === Number(req.params.id));
    f ? res.json(pField(f)) : res.status(404).json({ detail: 'Not found.' });
  });
  router.post('/custom_fields', json, (req, res) => saveField(req, res));
  router.patch('/custom_fields/:id', json, (req, res) => saveField(req, res, Number(req.params.id)));
  router.put('/custom_fields/:id', json, (req, res) => saveField(req, res, Number(req.params.id)));
  router.delete('/custom_fields/:id', (req, res) => {
    db.prepare('DELETE FROM custom_fields WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  // ----- saved views: stored as given, the client applies the rules -----
  const pView = (v) => ({
    id: v.id, name: v.name, show_on_dashboard: !!v.show_on_dashboard, show_in_sidebar: !!v.show_in_sidebar, sort_field: v.sort_field,
    sort_reverse: !!v.sort_reverse, filter_rules: JSON.parse(v.filter_rules), page_size: null, display_mode: null, display_fields: null, ...owner,
  });
  const saveView = (req, res, id) => {
    const cur = id && db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id), b = req.body || {};
    if (id && !cur) return res.status(404).json({ detail: 'Not found.' });
    const name = String(b.name ?? cur?.name ?? '').trim();
    if (!name) return res.status(400).json({ name: ['This field is required.'] });
    const rules = JSON.stringify(Array.isArray(b.filter_rules) ? b.filter_rules : JSON.parse(cur?.filter_rules ?? '[]'));
    const flag = (k) => (b[k] !== undefined ? Number(!!b[k]) : cur?.[k] ?? 0);
    const vals = [name, flag('show_on_dashboard'), flag('show_in_sidebar'), b.sort_field !== undefined ? b.sort_field : cur?.sort_field ?? null, flag('sort_reverse'), rules];
    const newId = id ? (db.prepare('UPDATE saved_views SET name = ?, show_on_dashboard = ?, show_in_sidebar = ?, sort_field = ?, sort_reverse = ?, filter_rules = ? WHERE id = ?').run(...vals, id), id)
      : db.prepare('INSERT INTO saved_views (name, show_on_dashboard, show_in_sidebar, sort_field, sort_reverse, filter_rules) VALUES (?, ?, ?, ?, ?, ?)').run(...vals).lastInsertRowid;
    res.status(id ? 200 : 201).json(pView(db.prepare('SELECT * FROM saved_views WHERE id = ?').get(newId)));
  };
  router.get('/saved_views', (req, res) => res.json(paged(req, db.prepare('SELECT * FROM saved_views ORDER BY id').all().map(pView))));
  router.get('/saved_views/:id', (req, res) => {
    const v = db.prepare('SELECT * FROM saved_views WHERE id = ?').get(req.params.id);
    v ? res.json(pView(v)) : res.status(404).json({ detail: 'Not found.' });
  });
  router.post('/saved_views', json, (req, res) => saveView(req, res));
  router.patch('/saved_views/:id', json, (req, res) => saveView(req, res, Number(req.params.id)));
  router.put('/saved_views/:id', json, (req, res) => saveView(req, res, Number(req.params.id)));
  router.delete('/saved_views/:id', (req, res) => {
    db.prepare('DELETE FROM saved_views WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  // Deletion is permanent here, so there is never anything to restore; the call still succeeds for clients that empty the trash.
  router.post('/trash', json, (req, res) => res.json({ result: 'OK', doc_ids: [] }));

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
    db.prepare('UPDATE folders SET match = ?, matching_algorithm = ?, is_insensitive = ? WHERE id = ?').run(...matchOf(req.body), parent);
    res.status(201).json(pFolder(folderRows().find((f) => f.id === parent)));
  });
  // shortcut: PATCH renames the folder (last path segment) but never moves it; moving stays in the Neopaperless UI.
  router.patch('/storage_paths/:id', json, (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.status(404).json({ detail: 'Not found.' });
    const name = String(req.body?.name || '').split('/').pop().trim() || folder.name;
    try { db.prepare('UPDATE folders SET name = ?, match = ?, matching_algorithm = ?, is_insensitive = ? WHERE id = ?').run(name, ...matchOf(req.body, folder), folder.id); } catch { return dup(res); }
    res.json(pFolder(folderRows().find((f) => f.id === folder.id)));
  });
  router.delete('/storage_paths/:id', (req, res) => {
    db.prepare('DELETE FROM folders WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  // "My Profile" in Paperless-ngx is where users copy the API token that plugins ask for.
  router.get('/profile', (req, res) => {
    const t = db.prepare("SELECT token FROM sessions WHERE user_id = ? AND name = 'Profil'").get(req.user.id);
    res.json({ email: '', password: '', first_name: '', last_name: '', auth_token: t?.token ?? null, social_accounts: [], has_usable_password: true });
  });
  router.post('/profile/generate_auth_token', (req, res) => {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND name = 'Profil'").run(req.user.id);
    res.json(ctx.createSession(req.user.id, TOKEN_DAYS, 'Profil'));
  });

  // Public links reuse the native shares table; the link is served at /share/<slug>.
  router.post('/share_links', json, (req, res) => {
    const doc = getDoc(req.body?.document);
    if (!doc) return res.status(404).json({ detail: 'Not found.' });
    const slug = crypto.randomBytes(24).toString('base64url');
    const exp = req.body?.expiration ? Date.parse(req.body.expiration) : null;
    db.prepare('INSERT INTO shares (token, document_id, expires_at) VALUES (?, ?, ?)').run(slug, doc.id, exp || null);
    res.status(201).json({ id: doc.id, created: new Date().toISOString(), expiration: exp ? new Date(exp).toISOString() : null,
      slug, document: doc.id, file_version: req.body?.file_version || 'archive' });
  });

  // ----- always-empty collections and misc -----
  for (const name of ['groups', 'share_links', 'mail_accounts', 'trash', 'mail_rules', 'workflows'])
    router.get(`/${name}`, (req, res) => res.json(page(req, [], 0, [])));

  const me = (u) => ({ id: u.id, username: u.username, is_superuser: !!u.is_admin, is_staff: !!u.is_admin, first_name: '', last_name: '', groups: [] });
  router.get('/users', (req, res) => res.json(list(req, db.prepare('SELECT id, username, is_admin FROM users').all().map(me))));
  router.get('/ui_settings', (req, res) => res.json({
    user: me(req.user), settings: { language: 'fr-FR' },
    permissions: ACTIONS.flatMap((a) => MODELS.map((m) => `${a}_${m}`)),
  }));
  router.post('/tasks/acknowledge', json, (req, res) => res.json({ result: (req.body?.tasks || []).length }));
  router.get('/status', (req, res) => res.json({
    pngx_version: ctx.version, server_os: process.platform, install_type: 'bare-metal',
    storage: { total: 0, available: 0 }, database: { type: 'sqlite', url: '', status: 'OK', error: null,
      migration_status: { latest_migration: '', unapplied_migrations: [] } },
    tasks: { redis_url: '', redis_status: 'OK', redis_error: null, celery_status: 'OK', index_status: 'OK', index_last_modified: null,
      index_error: null, classifier_status: 'OK', classifier_last_trained: null, classifier_error: null },
  }));
  router.get('/remote_version', (req, res) => res.json({ version: ctx.version, update_available: false }));
  router.get('/statistics', (req, res) => {
    const { n, chars } = db.prepare('SELECT count(*) AS n, COALESCE(sum(length(content)), 0) AS chars FROM documents').get();
    res.json({
      documents_total: n, documents_inbox: 0, inbox_tag: null, inbox_tags: [], character_count: chars,
      tag_count: db.prepare('SELECT count(*) AS n FROM tags').get().n, correspondent_count: db.prepare('SELECT count(*) AS n FROM correspondents').get().n,
      document_type_count: db.prepare('SELECT count(*) AS n FROM document_types').get().n,
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
