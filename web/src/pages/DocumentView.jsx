import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Share2, Trash2, Copy, Check, X, Save, Link2 } from 'lucide-react';
import { api, send, formatDate, formatSize } from '../api.js';
import { TagChip } from './Documents.jsx';

const PdfViewer = lazy(() => import('../components/PdfViewer.jsx'));

function Preview({ doc }) {
  const url = `/api/documents/${doc.id}/file`;
  if (doc.mime === 'application/pdf') return <Suspense><PdfViewer url={url} /></Suspense>;
  if (/^image\/(png|jpeg|gif|webp)$/.test(doc.mime)) return <img src={url} alt={doc.title} className="mx-auto max-h-full object-contain p-4" />;
  if (doc.mime.startsWith('text/')) return <pre className="h-full overflow-auto whitespace-pre-wrap p-6 text-sm">{doc.content}</pre>;
  return (
    <div className="grid h-full place-items-center p-8 text-center text-sm text-zinc-500">
      <div>Aperçu indisponible pour ce type de fichier.<br />
        <a className="btn-primary mt-4" href={`${url}?download=1`}><Download size={16} /> Télécharger</a>
      </div>
    </div>
  );
}

function ShareDialog({ doc, onClose }) {
  const [shares, setShares] = useState([]);
  const [days, setDays] = useState(7);
  const [copied, setCopied] = useState('');
  const load = () => api(`/documents/${doc.id}/shares`).then(setShares);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const link = (token) => `${location.origin}/s/${token}`;
  async function create() {
    const { token } = await send(`/documents/${doc.id}/shares`, { days });
    await load();
    copy(token);
  }
  async function copy(token) {
    // navigator.clipboard needs HTTPS; on plain HTTP the link stays visible for manual copy.
    await navigator.clipboard?.writeText(link(token)).catch(() => {});
    setCopied(token);
  }
  async function share(token) {
    if (navigator.share) navigator.share({ title: doc.title, url: link(token) }).catch(() => {});
    else copy(token);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Partager" className="card w-full max-w-md rounded-b-none p-6 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Partager le document</h2>
          <button className="btn-ghost p-2" aria-label="Fermer" onClick={onClose}><X size={18} /></button>
        </div>
        <p className="mb-4 text-sm text-zinc-500">Toute personne disposant du lien pourra consulter et télécharger ce document, sans compte.</p>
        <div className="flex gap-2">
          <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Expiration">
            <option value={1}>Expire dans 24 h</option>
            <option value={7}>Expire dans 7 jours</option>
            <option value={30}>Expire dans 30 jours</option>
            <option value={0}>N’expire jamais</option>
          </select>
          <button className="btn-primary shrink-0" onClick={create}><Link2 size={16} /> Créer</button>
        </div>
        {shares.length > 0 && <p className="label mt-6">Liens actifs</p>}
        <ul className="space-y-2">
          {shares.map((s) => (
            <li key={s.token} className="flex items-center gap-2 rounded-xl bg-zinc-100 p-2 pl-3 dark:bg-zinc-800">
              <div className="min-w-0 flex-1">
                <input readOnly value={link(s.token)} onFocus={(e) => e.target.select()} className="w-full truncate bg-transparent text-xs outline-none" />
                <p className="text-xs text-zinc-500">{s.expires_at ? `Expire le ${new Date(s.expires_at).toLocaleDateString('fr-FR')}` : 'Sans expiration'}</p>
              </div>
              <button className="btn-ghost p-2" aria-label="Copier / partager" onClick={() => share(s.token)}>
                {copied === s.token ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
              </button>
              <button className="btn-danger p-2" aria-label="Révoquer" onClick={() => api(`/shares/${s.token}`, { method: 'DELETE' }).then(load)}><Trash2 size={16} /></button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function DocumentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { tags, changed } = useOutletContext();
  const [doc, setDoc] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    api(`/documents/${id}`).then((d) => {
      setDoc(d);
      setForm({ title: d.title, notes: d.notes, doc_date: d.doc_date || '', tags: d.tags });
    }, (e) => setError(e.message));
  }, [id]);

  if (error) return <p className="text-zinc-500">{error}</p>;
  if (!doc) return null;

  const dirty = form.title !== doc.title || form.notes !== doc.notes || form.doc_date !== (doc.doc_date || '')
    || [...form.tags].sort().join() !== [...doc.tags].sort().join();
  const toggle = (tagId) => setForm({ ...form, tags: form.tags.includes(tagId) ? form.tags.filter((t) => t !== tagId) : [...form.tags, tagId] });

  async function save() {
    const d = await send(`/documents/${doc.id}`, form, 'PATCH');
    setDoc({ ...doc, ...d });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    changed();
  }

  async function remove() {
    if (!confirm(`Supprimer définitivement « ${doc.title} » ?`)) return;
    await api(`/documents/${doc.id}`, { method: 'DELETE' });
    changed();
    navigate('/');
  }

  return (
    <>
      <div className="mb-4 flex items-center gap-1">
        <button className="btn-ghost -ml-2 px-2" onClick={() => (history.length > 1 ? navigate(-1) : navigate('/'))}><ArrowLeft size={18} /> Retour</button>
        <div className="ml-auto flex gap-1">
          <a className="btn-ghost p-2.5" href={`/api/documents/${doc.id}/file?download=1`} aria-label="Télécharger" title="Télécharger"><Download size={18} /></a>
          <button className="btn-ghost p-2.5" onClick={() => setSharing(true)} aria-label="Partager" title="Partager"><Share2 size={18} /></button>
          <button className="btn-danger p-2.5" onClick={remove} aria-label="Supprimer" title="Supprimer"><Trash2 size={18} /></button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="card h-[70dvh] overflow-hidden bg-zinc-100 lg:h-[calc(100dvh-11.5rem)] dark:bg-zinc-900/50">
          <Preview doc={doc} />
        </div>

        <aside className="space-y-5">
          <div className="card space-y-4 p-5">
            <div>
              <label className="label" htmlFor="title">Titre</label>
              <input id="title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="date">Date du document</label>
              <input id="date" type="date" className="input" value={form.doc_date} onChange={(e) => setForm({ ...form, doc_date: e.target.value })} />
            </div>
            <div>
              <p className="label">Tags</p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => <TagChip key={t.id} tag={t} active={form.tags.includes(t.id)} onClick={() => toggle(t.id)} />)}
                {tags.length === 0 && <Link to="/settings" className="text-sm text-indigo-500">Créer des tags</Link>}
              </div>
            </div>
            <div>
              <label className="label" htmlFor="notes">Notes</label>
              <textarea id="notes" rows={3} className="input resize-y" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <button className="btn-primary w-full" disabled={!dirty && !saved} onClick={save}>
              {saved ? <><Check size={16} /> Enregistré</> : <><Save size={16} /> Enregistrer</>}
            </button>
          </div>

          <dl className="card grid grid-cols-2 gap-3 p-5 text-sm">
            <div><dt className="label">Fichier</dt><dd className="truncate" title={doc.filename}>{doc.filename}</dd></div>
            <div><dt className="label">Taille</dt><dd>{formatSize(doc.size)}</dd></div>
            <div><dt className="label">Ajouté le</dt><dd>{formatDate(doc.added_at)}</dd></div>
            <div><dt className="label">Type</dt><dd className="truncate">{doc.mime}</dd></div>
          </dl>

          {doc.content.trim() && (
            <details className="card p-5 text-sm">
              <summary className="cursor-pointer font-medium">Texte indexé</summary>
              <p className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-zinc-500">{doc.content.slice(0, 20000)}</p>
            </details>
          )}
        </aside>

        {sharing && <ShareDialog doc={doc} onClose={() => setSharing(false)} />}
      </div>
    </>
  );
}
