import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'np-migrate-'));
const { openDb, closeDb, MIGRATIONS, DB_PATH } = await import('./db.js');

test('tags become folders without losing a document label', () => {
  const old = new DatabaseSync(DB_PATH);
  old.exec(MIGRATIONS[0]);
  old.exec(`PRAGMA user_version = 1;
    INSERT INTO tags (id, name, color) VALUES (10, 'Amazon', '#000000');
    INSERT INTO documents (id, title, filename, stored_name, mime, size, sha256) VALUES
      (1, 'a', 'a', 'a', 'text/plain', 1, 'a'), (2, 'b', 'b', 'b', 'text/plain', 1, 'b'), (3, 'c', 'c', 'c', 'text/plain', 1, 'c');
    INSERT INTO document_tags VALUES (1, 1), (1, 10), (2, 3), (2, 1);`);
  old.close();

  const db = openDb();
  const docs = db.prepare('SELECT id, folder_id FROM documents ORDER BY id').all().map((d) => d.folder_id);
  assert.deepEqual(docs, [1, 1, null]); // lowest tag wins; untagged stays out of any folder
  assert.deepEqual(db.prepare('SELECT document_id, tag_id FROM document_tags ORDER BY 1, 2').all().map((r) => [r.document_id, r.tag_id]),
    [[1, 10], [2, 3]]);
  assert.deepEqual(db.prepare('SELECT name FROM tags ORDER BY name').all().map((t) => t.name), ['Amazon', 'Notices']);
  // Amazon and Notices are only ever secondary labels here, so they stay tags and do not become empty folders.
  assert.deepEqual(db.prepare('SELECT name FROM folders ORDER BY name').all().map((f) => f.name), ['Bulletins de paie', 'Factures']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM documents_fts WHERE documents_fts MATCH 'a'").get().n, 1);
  closeDb();
});
