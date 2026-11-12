import { db } from './db.js';

// Paperless-ngx matching algorithms: 1 any word, 2 all words, 3 exact, 4 regex, 5 fuzzy. 0 = none, 6 = auto.
// shortcut: 6 (auto) needs Paperless' trained classifier and is never applied; 5 (fuzzy) is a plain case-aware substring test.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (w, flags) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, flags);

export function matches({ match, matching_algorithm: algo, is_insensitive: insensitive }, text) {
  if (!match?.trim()) return false;
  const flags = insensitive ? 'iu' : 'u';
  const words = match.split(/\s+/).filter(Boolean);
  try {
    if (algo === 1) return words.some((w) => word(w, flags).test(text));
    if (algo === 2) return words.every((w) => word(w, flags).test(text));
    if (algo === 3) return word(match.trim(), flags).test(text);
    if (algo === 4) return new RegExp(match, flags).test(text); // the owner's own pattern, run on the owner's own documents
    if (algo === 5) return (insensitive ? text.toLowerCase() : text).includes(insensitive ? match.toLowerCase() : match);
  } catch { /* invalid regex: no match */ }
  return false;
}

const hits = (table, text) => db.prepare(`SELECT * FROM ${table} WHERE matching_algorithm BETWEEN 1 AND 5`).all().filter((o) => matches(o, text));

// What the matching rules propose for a text; at ingest Paperless only applies a single, unambiguous correspondent/type/path.
export const suggest = (text) => ({
  tags: hits('tags', text).map((o) => o.id),
  correspondents: hits('correspondents', text).map((o) => o.id),
  document_types: hits('document_types', text).map((o) => o.id),
  storage_paths: hits('folders', text).map((o) => o.id),
});

export function autoAssign(docId, text, { hasCorrespondent, hasType, hasFolder }) {
  const s = suggest(text);
  const add = db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)');
  for (const t of s.tags) add.run(docId, t);
  if (!hasCorrespondent && s.correspondents.length === 1) db.prepare('UPDATE documents SET correspondent_id = ? WHERE id = ?').run(s.correspondents[0], docId);
  if (!hasType && s.document_types.length === 1) db.prepare('UPDATE documents SET document_type_id = ? WHERE id = ?').run(s.document_types[0], docId);
  if (!hasFolder && s.storage_paths.length === 1) db.prepare('UPDATE documents SET folder_id = ? WHERE id = ?').run(s.storage_paths[0], docId);
}
