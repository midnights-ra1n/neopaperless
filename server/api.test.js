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

  assert.equal((await (await call('/api/status')).json()).setupRequired, true);
  assert.equal((await call('/api/documents')).status, 401);
  assert.equal((await call('/api/setup', json({ username: 'admin', password: 'short' }))).status, 400);
  assert.equal((await call('/api/setup', json({ username: 'admin', password: 'motdepasse1' }))).status, 200);
  assert.equal((await call('/api/setup', json({ username: 'x', password: 'motdepasse1' }))).status, 403);

  const up = await call('/api/documents', {
    method: 'POST', body: 'Facture électricité octobre, montant 42 euros',
    headers: { 'content-type': 'text/plain', 'x-filename': encodeURIComponent('facture_edf.txt'), 'x-tags': '1' },
  });
  assert.equal(up.status, 201);
  const doc = await up.json();
  assert.equal(doc.title, 'facture edf');
  assert.deepEqual(doc.tags, [1]);

  const dup = await call('/api/documents', {
    method: 'POST', body: 'Facture électricité octobre, montant 42 euros',
    headers: { 'content-type': 'text/plain', 'x-filename': 'copie.txt' },
  });
  assert.equal(dup.status, 409);

  const hits = await (await call('/api/documents?q=electri')).json();
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /\u0002électricité\u0003/);
  assert.equal((await (await call('/api/documents?q=gaz')).json()).length, 0);
  assert.equal((await (await call('/api/documents?tag=2')).json()).length, 0);

  const html = await call('/api/documents', {
    method: 'POST', body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html', 'x-filename': 'x.html' },
  });
  const htmlFile = await call(`/api/documents/${(await html.json()).id}/file`);
  assert.equal(htmlFile.headers.get('content-type'), 'application/octet-stream');

  const { token } = await (await call(`/api/documents/${doc.id}/shares`, json({ days: 7 }))).json();
  const saved = cookie;
  cookie = '';
  assert.equal(await (await call(`/s/${token}`)).text(), 'Facture électricité octobre, montant 42 euros');
  cookie = saved;

  const backup = Buffer.from(await (await call('/api/backup')).arrayBuffer());
  await call(`/api/documents/${doc.id}`, { method: 'DELETE' });
  assert.equal((await (await call('/api/documents')).json()).length, 1);
  assert.equal((await call('/api/restore', { method: 'POST', body: backup })).status, 200);
  // Restore swaps the database, so sessions come from the backup: our session existed then.
  const restored = await (await call('/api/documents?q=facture')).json();
  assert.equal(restored.length, 1);
  assert.equal(await (await call(`/api/documents/${restored[0].id}/file`)).text(), 'Facture électricité octobre, montant 42 euros');
});
