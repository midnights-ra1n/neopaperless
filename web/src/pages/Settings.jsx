import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Plus, Trash2, Plug, Users, FileType, Download, Upload, RefreshCw, KeyRound, Tags, Folder, DatabaseBackup, Sparkles, Loader2 } from 'lucide-react';
import { api, send, upload, flattenFolders, paperless } from '../api.js';
import { FolderSelect } from './Documents.jsx';

function Section({ icon: Icon, title, children }) {
  return (
    <section className="card p-5 sm:p-6">
      <h2 className="mb-4 flex items-center gap-2.5 font-semibold">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-500/10 text-indigo-500"><Icon size={16} /></span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Message({ msg }) {
  if (!msg) return null;
  return <p role="status" className={`mt-3 text-sm ${msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>{msg.text}</p>;
}

function FoldersSection() {
  const { folders, changed } = useOutletContext();
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [msg, setMsg] = useState(null);
  const run = (p) => { setMsg(null); return p.then(changed).catch((e) => { setMsg({ text: e.message }); throw e; }); };

  return (
    <Section icon={Folder} title="Dossiers">
      <ul className="mb-4 divide-y divide-zinc-100 dark:divide-zinc-800">
        {flattenFolders(folders).map((f) => (
          <li key={f.id} className="flex items-center gap-2 py-2" style={{ paddingLeft: `${f.depth}rem` }}>
            <input className="input py-1.5" aria-label="Nom du dossier" defaultValue={f.name}
              onBlur={(e) => e.target.value !== f.name && run(send(`/folders/${f.id}`, { name: e.target.value }, 'PATCH')).catch(() => {})} />
            <FolderSelect folders={folders} aria-label={`Dossier parent de ${f.name}`} value={f.parent_id ?? ''}
              onChange={(e) => run(send(`/folders/${f.id}`, { parent_id: e.target.value }, 'PATCH')).catch(() => {})} />
            <button className="btn-danger p-2" aria-label={`Supprimer ${f.name}`}
              onClick={() => confirm(`Supprimer le dossier « ${f.name} » et ses sous-dossiers ? Les documents ne seront pas supprimés.`) && run(api(`/folders/${f.id}`, { method: 'DELETE' })).catch(() => {})}>
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap gap-2 sm:flex-nowrap" onSubmit={(e) => { e.preventDefault(); run(send('/folders', { name, parent_id: parent })).then(() => setName(''), () => {}); }}>
        <input className="input" placeholder="Nouveau dossier…" value={name} onChange={(e) => setName(e.target.value)} required />
        <FolderSelect folders={folders} aria-label="Dossier parent" value={parent} onChange={(e) => setParent(e.target.value)} />
        <button className="btn-primary shrink-0"><Plus size={16} /> Ajouter</button>
      </form>
      <Message msg={msg} />
    </Section>
  );
}

function TagsSection() {
  const { tags, reloadTags } = useOutletContext();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [msg, setMsg] = useState(null);
  const run = (p) => p.then(reloadTags, (e) => setMsg({ text: e.message }));

  return (
    <Section icon={Tags} title="Tags">
      <ul className="mb-4 divide-y divide-zinc-100 dark:divide-zinc-800">
        {tags.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-2">
            <input type="color" aria-label={`Couleur de ${t.name}`} defaultValue={t.color}
              onChange={(e) => run(send(`/tags/${t.id}`, { color: e.target.value }, 'PATCH'))}
              className="h-8 w-8 shrink-0 cursor-pointer rounded-lg border-0 bg-transparent" />
            <input className="input py-1.5" aria-label="Nom du tag" defaultValue={t.name}
              onBlur={(e) => e.target.value !== t.name && run(send(`/tags/${t.id}`, { name: e.target.value }, 'PATCH'))} />
            <span className="w-10 shrink-0 text-right text-xs text-zinc-400">{t.count} doc.</span>
            <button className="btn-danger p-2" aria-label={`Supprimer ${t.name}`}
              onClick={() => confirm(`Supprimer le tag « ${t.name} » ? Les documents ne seront pas supprimés.`) && run(api(`/tags/${t.id}`, { method: 'DELETE' }))}>
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(send('/tags', { name, color })).then(() => setName('')); }}>
        <input type="color" aria-label="Couleur" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-10 shrink-0 cursor-pointer rounded-lg border-0 bg-transparent" />
        <input className="input" placeholder="Nouveau tag…" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn-primary shrink-0"><Plus size={16} /> Ajouter</button>
      </form>
      <Message msg={msg} />
    </Section>
  );
}

function BackupSection() {
  const input = useRef();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function restore(file) {
    if (!file || !confirm('Restaurer cette sauvegarde ? Toutes les données actuelles seront remplacées.')) return;
    setBusy(true);
    setMsg(null);
    try {
      await upload('/restore', file);
      setMsg({ ok: true, text: 'Sauvegarde restaurée. Rechargement…' });
      setTimeout(() => location.assign('/'), 1200);
    } catch (e) {
      setMsg({ text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section icon={DatabaseBackup} title="Sauvegarde & import">
      <p className="mb-4 text-sm text-zinc-500">
        L’archive contient la base de données (documents, dossiers, tags, liens de partage, comptes) et tous les fichiers.
        Importez-la sur une autre installation pour tout retrouver.
      </p>
      <div className="flex flex-wrap gap-2">
        <a className="btn-primary" href="/api/np/backup"><Download size={16} /> Télécharger une sauvegarde</a>
        <button className="btn-ghost border border-zinc-200 dark:border-zinc-700" disabled={busy} onClick={() => input.current.click()}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} Restaurer
        </button>
        <input ref={input} type="file" accept=".tar.gz,.tgz,application/gzip" hidden onChange={(e) => { restore(e.target.files[0]); e.target.value = ''; }} />
      </div>
      <Message msg={msg} />
    </Section>
  );
}

function UpdateSection() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(null); // version we had when the update was requested
  async function check() {
    setBusy(true);
    setState(await api('/update').catch((e) => ({ error: e.message })));
    setBusy(false);
  }
  useEffect(() => { check(); }, []);
  // The service restarts during the install: poll until it answers with a new version (or says it failed).
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => api('/update/status').then((s) => {
      if (s.current !== waiting || /^\S+ erreur/.test(s.last || '')) { setWaiting(null); check(); }
    }, () => {}), 3000);
    return () => clearInterval(t);
  }, [waiting]);
  async function install() {
    await send('/update/install', {}).then(() => setWaiting(state.current), (e) => setState({ ...state, error: e.message }));
  }
  const toggleAuto = (enabled) => send('/update/auto', { enabled }, 'PUT').then(() => setState({ ...state, auto: enabled }));
  return (
    <Section icon={Sparkles} title="Mises à jour">
      {state?.mode === 'deb' && (
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={state.auto} onChange={(e) => toggleAuto(e.target.checked)} />
          Installer automatiquement les nouvelles versions (chaque nuit)
        </label>
      )}
      <button className="btn-ghost border border-zinc-200 dark:border-zinc-700" disabled={busy || !!waiting} onClick={check}>
        <RefreshCw size={16} className={busy ? 'animate-spin' : ''} /> Vérifier les mises à jour
      </button>
      {state?.error && <Message msg={{ text: state.error }} />}
      {state && !state.error && !state.available && <Message msg={{ ok: true, text: `Vous utilisez la dernière version (${state.current}).` }} />}
      {state?.last && <p className="mt-2 text-xs text-zinc-500">Dernière opération : {state.last}</p>}
      {state?.available && (
        <div className="mt-4 rounded-xl bg-indigo-500/10 p-4 text-sm">
          <p className="font-medium">Nouvelle version disponible : {state.latest}</p>
          {state.notes && <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{state.notes}</p>}
          {state.mode === 'deb' && (
            <button className="btn-primary mt-3" disabled={!!waiting || state.pending} onClick={install}>
              {waiting || state.pending ? <><Loader2 size={16} className="animate-spin" /> Installation en cours…</> : 'Installer maintenant'}
            </button>
          )}
          {state.mode === 'docker' && <p className="mt-3 text-zinc-600 dark:text-zinc-400">Docker : <code>docker compose pull && docker compose up -d</code></p>}
          {state.mode === 'manual' && <p className="mt-3 text-zinc-600 dark:text-zinc-400">Installez le nouveau paquet depuis la page de la version.</p>}
          <a className="btn-ghost mt-3" href={state.url} target="_blank" rel="noreferrer">Voir la version</a>
        </div>
      )}
    </Section>
  );
}

function PasswordSection() {
  const [form, setForm] = useState({ current: '', next: '' });
  const [msg, setMsg] = useState(null);
  async function submit(e) {
    e.preventDefault();
    try {
      await send('/password', form);
      setForm({ current: '', next: '' });
      setMsg({ ok: true, text: 'Mot de passe modifié. Les autres sessions ont été déconnectées.' });
    } catch (err) {
      setMsg({ text: err.message });
    }
  }
  return (
    <Section icon={KeyRound} title="Mot de passe">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <input type="password" className="input" placeholder="Mot de passe actuel" autoComplete="current-password" required
          value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        <input type="password" className="input" placeholder="Nouveau (8 caractères min.)" autoComplete="new-password" required minLength={8}
          value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        <button className="btn-primary">Modifier</button>
      </form>
      <Message msg={msg} />
    </Section>
  );
}

function NamedListSection({ path, title, icon }) {
  const [items, setItems] = useState([]);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState(null);
  const load = () => paperless(`/${path}/?page_size=1000`).then((d) => setItems(d.results), (e) => setMsg({ text: e.message }));
  useEffect(() => { load(); }, []);
  const run = (p) => p.then(load, (e) => setMsg({ text: e.message }));
  return (
    <Section icon={icon} title={title}>
      <form onSubmit={(e) => { e.preventDefault(); run(paperless(`/${path}/`, { method: 'POST', body: JSON.stringify({ name }) }).then(() => setName(''))); }} className="flex gap-3">
        <input className="input" placeholder="Nouveau" required value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-primary">Ajouter</button>
      </form>
      <ul className="mt-3 divide-y divide-slate-200/60 dark:divide-white/10">
        {items.map((o) => (
          <li key={o.id} className="flex items-center justify-between py-2 text-sm">
            <span>{o.name} <span className="text-xs text-slate-400">{o.document_count}</span></span>
            <button aria-label={`Supprimer ${o.name}`} className="btn-ghost" onClick={() => run(paperless(`/${path}/${o.id}/`, { method: 'DELETE' }))}><Trash2 size={15} /></button>
          </li>
        ))}
      </ul>
      <Message msg={msg} />
    </Section>
  );
}

function TokensSection() {
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => api('/tokens').then(setTokens).catch((e) => setMsg({ text: e.message }));
  useEffect(() => { load(); }, []);
  async function create(e) {
    e.preventDefault();
    try {
      setCreated((await send('/tokens', { name })).token);
      setName('');
      load();
    } catch (err) {
      setMsg({ text: err.message });
    }
  }
  return (
    <Section icon={Plug} title="Jetons d'API (Obsidian, applications)">
      <p className="mb-3 text-sm text-slate-500">Un jeton remplace le mot de passe pour les plugins compatibles Paperless-ngx : URL du serveur + jeton.</p>
      <form onSubmit={create} className="flex gap-3">
        <input className="input" placeholder="Nom (ex. Obsidian)" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-primary">Créer</button>
      </form>
      {created && <p className="mt-3 break-all rounded-lg bg-amber-500/10 p-3 font-mono text-xs">Copiez-le maintenant, il ne sera plus affiché : {created}</p>}
      <ul className="mt-3 divide-y divide-slate-200/60 dark:divide-white/10">
        {tokens.map((t) => (
          <li key={t.id} className="flex items-center justify-between py-2 text-sm">
            <span>{t.name} <span className="font-mono text-xs text-slate-400">…{t.hint}</span></span>
            <button aria-label={`Révoquer ${t.name}`} className="btn-ghost" onClick={() => send(`/tokens/${t.id}`, {}, 'DELETE').then(load)}><Trash2 size={15} /></button>
          </li>
        ))}
      </ul>
      <Message msg={msg} />
    </Section>
  );
}

export default function Settings() {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Paramètres</h1>
      <FoldersSection />
      <TagsSection />
      <BackupSection />
      <UpdateSection />
      <NamedListSection path="correspondents" title="Correspondants" icon={Users} />
      <NamedListSection path="document_types" title="Types de document" icon={FileType} />
      <TokensSection />
      <PasswordSection />
    </div>
  );
}
