import { useEffect, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { FileText, Image, FileQuestion, Inbox } from 'lucide-react';
import { api, formatDate } from '../api.js';

// Server wraps matches in \u0002…\u0003; rendering them as <mark> elements avoids injecting document text as HTML.
function Snippet({ text }) {
  return text.replace(/\f/g, ' ').split(/\u0002(.*?)\u0003/s).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

function Thumb({ doc }) {
  const [failed, setFailed] = useState(false);
  const Icon = doc.mime === 'application/pdf' || doc.mime.startsWith('text/') ? FileText : doc.mime.startsWith('image/') ? Image : FileQuestion;
  if (failed) return <div className="grid h-full place-items-center text-zinc-300 dark:text-zinc-700"><Icon size={48} strokeWidth={1.25} /></div>;
  return <img src={`/api/documents/${doc.id}/thumb`} alt="" loading="lazy" onError={() => setFailed(true)}
    className="h-full w-full object-cover object-top transition duration-300 group-hover:scale-[1.03]" />;
}

export function TagChip({ tag, active, onClick }) {
  const Comp = onClick ? 'button' : 'span';
  return (
    <Comp type={onClick ? 'button' : undefined} onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition ${
        active === false ? 'opacity-40 hover:opacity-80' : ''}`}
      style={{ background: `${tag.color}1f`, color: tag.color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: tag.color }} />
      {tag.name}
    </Comp>
  );
}

export default function Documents() {
  const { tags, revision } = useOutletContext();
  const [params, setParams] = useSearchParams();
  const [docs, setDocs] = useState(null);
  const q = params.get('q') || '';
  const tag = params.get('tag');

  useEffect(() => {
    const search = new URLSearchParams();
    if (q) search.set('q', q);
    if (tag) search.set('tag', tag);
    let stale = false;
    api(`/documents?${search}`).then((d) => !stale && setDocs(d));
    return () => { stale = true; };
  }, [q, tag, revision]);

  const tagById = Object.fromEntries(tags.map((t) => [t.id, t]));
  const current = tag && tagById[tag];
  const toggleTag = (id) => {
    const next = new URLSearchParams(params);
    tag === String(id) ? next.delete('tag') : next.set('tag', id);
    setParams(next);
  };

  return (
    <>
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {q ? `Résultats pour « ${q} »` : current ? current.name : 'Tous les documents'}
          </h1>
          <p className="text-sm text-zinc-500">{docs ? `${docs.length} document${docs.length > 1 ? 's' : ''}` : 'Chargement…'}</p>
        </div>
      </div>

      <div className="-mx-4 mb-6 flex gap-2 overflow-x-auto px-4 pb-1 md:hidden">
        {tags.map((t) => <TagChip key={t.id} tag={t} active={tag ? tag === String(t.id) : undefined} onClick={() => toggleTag(t.id)} />)}
      </div>

      {docs?.length === 0 && (
        <div className="card flex flex-col items-center gap-3 px-6 py-16 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-indigo-500/10 text-indigo-500"><Inbox size={28} /></div>
          <p className="font-medium">{q || tag ? 'Aucun document trouvé' : 'Aucun document pour le moment'}</p>
          <p className="max-w-sm text-sm text-zinc-500">
            {q || tag ? 'Essayez avec d’autres mots-clés.' : 'Glissez-déposez vos factures, bulletins de paie ou notices ici, ou utilisez le bouton Ajouter.'}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
        {docs?.map((d) => (
          <Link key={d.id} to={`/documents/${d.id}`}
            className="card group flex flex-col overflow-hidden transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-indigo-500/10">
            <div className="aspect-[4/5] overflow-hidden border-b border-zinc-100 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-800/40">
              <Thumb doc={d} />
            </div>
            <div className="flex flex-1 flex-col gap-1.5 p-3">
              <p className="line-clamp-2 text-sm font-medium leading-snug">{d.title}</p>
              {d.snippet && <p className="line-clamp-3 text-xs text-zinc-500"><Snippet text={d.snippet} /></p>}
              <p className="text-xs text-zinc-400">{formatDate(d.doc_date || d.added_at)}</p>
              {d.tags.length > 0 && (
                <div className="mt-auto flex flex-wrap gap-1 pt-1">
                  {d.tags.map((id) => tagById[id] && <TagChip key={id} tag={tagById[id]} />)}
                </div>
              )}
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
