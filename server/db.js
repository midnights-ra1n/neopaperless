import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const FILES_DIR = path.join(DATA_DIR, 'documents');
export const DB_PATH = path.join(DATA_DIR, 'neopaperless.db');

// Each entry runs once, in order; PRAGMA user_version tracks progress so updates migrate old databases.
const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
     is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE TABLE sessions (
     token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL);
   CREATE TABLE documents (
     id INTEGER PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL, stored_name TEXT NOT NULL,
     mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '', doc_date TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE INDEX documents_sha ON documents(sha256);
   CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, color TEXT NOT NULL);
   CREATE TABLE document_tags (
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
     PRIMARY KEY (document_id, tag_id));
   CREATE TABLE shares (
     token TEXT PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     expires_at INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE VIRTUAL TABLE documents_fts USING fts5(
     title, content, notes, content='documents', content_rowid='id',
     tokenize='unicode61 remove_diacritics 2');
   CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
     INSERT INTO documents_fts(rowid, title, content, notes) VALUES (new.id, new.title, new.content, new.notes);
   END;
   CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
     INSERT INTO documents_fts(documents_fts, rowid, title, content, notes) VALUES ('delete', old.id, old.title, old.content, old.notes);
   END;
   CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
     INSERT INTO documents_fts(documents_fts, rowid, title, content, notes) VALUES ('delete', old.id, old.title, old.content, old.notes);
     INSERT INTO documents_fts(rowid, title, content, notes) VALUES (new.id, new.title, new.content, new.notes);
   END;
   INSERT INTO tags (name, color) VALUES ('Factures', '#6366f1'), ('Bulletins de paie', '#10b981'), ('Notices', '#f59e0b');`,
];

export let db;

export function openDb() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  return db;
}

export function closeDb() {
  db?.close();
  db = undefined;
}

// Turns free text into an FTS5 prefix query: every word must match, as a prefix, accents ignored.
export function ftsQuery(text) {
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  return words.map((w) => `"${w}"*`).join(' ');
}
