import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'np-test-'));
const { openDb, ftsQuery } = await import('./db.js');
const { createApp } = await import('./index.js');

test('ftsQuery builds prefix terms and drops FTS syntax', () => {
  assert.equal(ftsQuery('facture EDF'), '"facture"* "EDF"*');
  assert.equal(ftsQuery('"a" OR -b*'), '"a"* "OR"* "b"*');
  assert.equal(ftsQuery('  '), '');
});

test('setup, upload, search, share, backup, restore', async (t) => {
  openDb();
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const call = async (url, opts = {}) => {
    const r = await fetch(base + url, { ...opts, headers: { cookie, ...opts.headers } });
    cookie = r.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return r;
  };
  const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await (await call('/api/np/status')).json()).setupRequired, true);
  assert.equal((await call('/api/np/documents')).status, 401);
  assert.equal((await call('/api/np/setup', json({ username: 'admin', password: 'short' }))).status, 400);
  assert.equal((await call('/api/np/setup', json({ username: 'admin', password: 'motdepasse1' }))).status, 200);
  assert.equal((await call('/api/np/setup', json({ username: 'x', password: 'motdepasse1' }))).status, 403);

  const patch = (body) => ({ ...json(body), method: 'PATCH' });
  assert.deepEqual((await (await call('/api/np/folders')).json()).map((f) => f.name), ['Bulletins de paie', 'Factures', 'Notices']);
  assert.equal((await (await call('/api/np/tags')).json()).length, 0);
  const factures = (await (await call('/api/np/folders')).json()).find((f) => f.name === 'Factures');
  const sub = await (await call('/api/np/folders', json({ name: '2024', parent_id: factures.id }))).json();
  const leaf = await (await call('/api/np/folders', json({ name: 'Octobre', parent_id: sub.id }))).json();
  assert.equal((await call('/api/np/folders', json({ name: '2024', parent_id: factures.id }))).status, 409);
  assert.equal((await call('/api/np/folders', json({ name: 'factures' }))).status, 409);
  assert.equal((await call('/api/np/folders', json({ name: '2024' }))).status, 201);
  assert.equal((await call(`/api/np/folders/${factures.id}`, patch({ parent_id: leaf.id }))).status, 400);
  assert.equal((await call(`/api/np/folders/${factures.id}`, patch({ parent_id: factures.id }))).status, 400);
  const amazon = await (await call('/api/np/tags', json({ name: 'Amazon' }))).json();

  const up = await call('/api/np/documents', {
    method: 'POST', body: 'Facture électricité octobre, montant 42 euros',
    headers: { 'content-type': 'text/plain', 'x-filename': encodeURIComponent('facture_edf.txt'), 'x-tags': amazon.id, 'x-folder': sub.id },
  });
  assert.equal(up.status, 201);
  const doc = await up.json();
  assert.equal(doc.title, 'facture edf');
  assert.deepEqual(doc.tags, [amazon.id]);
  assert.equal(doc.folder_id, sub.id);

  const dup = await call('/api/np/documents', {
    method: 'POST', body: 'Facture électricité octobre, montant 42 euros',
    headers: { 'content-type': 'text/plain', 'x-filename': 'copie.txt' },
  });
  assert.equal(dup.status, 409);

  const hits = await (await call('/api/np/documents?q=electri')).json();
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /\u0002électricité\u0003/);
  assert.equal((await (await call('/api/np/documents?q=gaz')).json()).length, 0);
  assert.equal((await (await call(`/api/np/documents?tag=${amazon.id + 1}`)).json()).length, 0);
  // Parent folders include subfolder documents, in the list and in the count; filters combine.
  assert.equal((await (await call(`/api/np/documents?folder=${factures.id}&tag=${amazon.id}&q=facture`)).json()).length, 1);
  assert.equal((await (await call(`/api/np/documents?folder=${leaf.id}`)).json()).length, 0);
  assert.equal((await (await call('/api/np/folders')).json()).find((f) => f.id === factures.id).count, 1);

  const html = await call('/api/np/documents', {
    method: 'POST', body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html', 'x-filename': 'x.html' },
  });
  const htmlFile = await call(`/api/np/documents/${(await html.json()).id}/file`);
  assert.equal(htmlFile.headers.get('content-type'), 'application/octet-stream');

  const { token } = await (await call(`/api/np/documents/${doc.id}/shares`, json({ days: 7 }))).json();
  const saved = cookie;
  cookie = '';
  assert.equal(await (await call(`/s/${token}`)).text(), 'Facture électricité octobre, montant 42 euros');
  cookie = saved;

  const backup = Buffer.from(await (await call('/api/np/backup')).arrayBuffer());
  await call(`/api/np/documents/${doc.id}`, { method: 'DELETE' });
  assert.equal((await (await call('/api/np/documents')).json()).length, 1);
  assert.equal((await call('/api/np/restore', { method: 'POST', body: backup })).status, 200);
  // Restore swaps the database, so sessions come from the backup: our session existed then.
  const restored = await (await call('/api/np/documents?q=facture')).json();
  assert.equal(restored.length, 1);
  assert.equal(await (await call(`/api/np/documents/${restored[0].id}/file`)).text(), 'Facture électricité octobre, montant 42 euros');

  // Deleting a folder removes its subfolders but keeps their documents, without a folder.
  await call(`/api/np/folders/${factures.id}`, { method: 'DELETE' });
  assert.equal((await (await call('/api/np/folders')).json()).some((f) => f.id === sub.id), false);
  const kept = await (await call(`/api/np/documents/${restored[0].id}`)).json();
  assert.equal(kept.folder_id, null);
  assert.equal((await (await call('/api/np/documents?q=electricite')).json()).length, 1);
});

test('Paperless-ngx compatible API: token, upload, filters, storage paths', async (t) => {
  openDb();
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}/api`;
  const hdr = { accept: 'application/json; version=5' };
  let auth = {};
  const call = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...hdr, ...auth, ...opts.headers } });
  const body = (data, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

  assert.equal((await call('/documents/')).status, 401);
  assert.equal((await call('/token/', body({ username: 'admin', password: 'mauvais' }))).status, 400);
  const { token } = await (await call('/token/', body({ username: 'admin', password: 'motdepasse1' }))).json();
  auth = { authorization: `Token ${token}` };

  const tag = await (await call('/tags/', body({ name: 'Important', color: '#ff0000' }))).json();
  const path = await (await call('/storage_paths/', body({ name: 'Maison/Factures' }))).json();
  assert.equal(path.name, 'Maison/Factures');
  assert.equal((await call('/storage_paths/', body({ name: 'Maison/Factures' }))).status, 400);
  const parent = (await (await call('/storage_paths/')).json()).results.find((p) => p.name === 'Maison');

  const form = new FormData();
  form.set('document', new Blob(['Contrat de bail du logement'], { type: 'text/plain' }), 'bail.txt');
  form.set('title', 'Bail');
  form.set('storage_path', String(path.id));
  form.append('tags', String(tag.id));
  const taskId = await (await call('/documents/post_document/', { method: 'POST', body: form })).json();
  const [task] = await (await call(`/tasks/?task_id=${taskId}`)).json();
  assert.equal(task.status, 'SUCCESS');

  const res = await (await call(`/documents/?query=logement&storage_path__id=${parent.id}&tags__id__all=${tag.id}`)).json();
  assert.equal(res.count, 1);
  assert.equal(res.results[0].id, Number(task.related_document));
  assert.equal(res.results[0].title, 'Bail');
  assert.deepEqual(res.results[0].tags, [tag.id]);
  assert.equal(res.results[0].storage_path, path.id);
  assert.match(res.results[0].__search_hit__.highlights, /<span class="match">logement<\/span>/);
  assert.equal((await (await call('/documents/?correspondent__id=1')).json()).count, 0);
  assert.equal((await (await call('/documents/?title__icontains=zzz')).json()).count, 0);
  assert.equal((await call(`/documents/${res.results[0].id}/download/`)).status, 200);
  assert.equal((await call(`/documents/${res.results[0].id}/`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/documents/${res.results[0].id}/`)).status, 404);
});
