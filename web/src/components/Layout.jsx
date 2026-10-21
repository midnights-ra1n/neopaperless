import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { FileText, Settings, Search, Upload, LogOut, X, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { api, upload } from '../api.js';

export default function Layout({ user, version, onLogout }) {
  const [tags, setTags] = useState([]);
  const [revision, setRevision] = useState(0);
  const [uploads, setUploads] = useState([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const activeTag = location.pathname === '/' ? params.get('tag') : null;

  const reloadTags = useCallback(() => api('/tags').then(setTags), []);
  const changed = useCallback(() => { setRevision((r) => r + 1); reloadTags(); }, [reloadTags]);
  useEffect(() => { reloadTags(); }, [reloadTags]);

  // Search lives in the URL so results are linkable and survive the back button.
  const urlQuery = location.pathname === '/' ? params.get('q') || '' : null;
  const [query, setQuery] = useState(urlQuery || '');
  useEffect(() => { if (urlQuery !== null) setQuery(urlQuery); }, [urlQuery]);
  // Runs on typing only, so opening a document does not bounce back to the results.
  useEffect(() => {
    if (query === (urlQuery ?? '')) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(location.pathname === '/' ? params : '');
      query ? next.set('q', query) : next.delete('q');
      navigate({ pathname: '/', search: next.toString() }, { replace: location.pathname === '/' });
    }, 200);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addFiles(files) {
    const tagHeader = activeTag ? { 'x-tags': activeTag } : {};
    for (const file of files) {
      const id = crypto.randomUUID();
      const patch = (p) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)));
      setUploads((u) => [...u, { id, name: file.name, progress: 0, state: 'busy' }]);
      try {
        await upload('/documents', file, {
          headers: { 'x-filename': encodeURIComponent(file.name), ...tagHeader },
          onProgress: (progress) => patch({ progress }),
        });
        patch({ state: 'done', progress: 1 });
      } catch (err) {
        patch({ state: 'error', error: err.message });
      }
    }
    changed();
    setTimeout(() => setUploads((u) => u.filter((x) => x.state === 'error')), 3000);
  }

  async function logout() {
    await api('/logout', { method: 'POST' });
    onLogout();
  }

  const navClass = ({ isActive }) =>
    `flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition ${
      isActive ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400' : 'text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-800/60'}`;

  return (
    <div
      className="min-h-dvh md:pl-64"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => e.relatedTarget === null && setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles([...e.dataTransfer.files]); }}
    >
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-zinc-200/80 bg-white/70 p-4 backdrop-blur-xl md:flex dark:border-zinc-800/80 dark:bg-zinc-900/60">
        <div className="mb-6 flex items-center gap-3 px-2">
          <img src="/icon.svg" alt="" className="h-9 w-9 rounded-xl" />
          <span className="text-lg font-semibold tracking-tight">NeoPaperless</span>
        </div>
        <nav className="space-y-1">
          <NavLink to="/" end className={() => navClass({ isActive: location.pathname === '/' && !activeTag })}>
            <FileText size={18} /> Tous les documents
          </NavLink>
        </nav>
        <p className="mt-6 mb-2 px-3 text-xs font-medium uppercase tracking-wide text-zinc-400">Tags</p>
        <nav className="-mx-1 flex-1 space-y-0.5 overflow-y-auto px-1">
          {tags.map((t) => (
            <NavLink key={t.id} to={`/?tag=${t.id}`} className={() => navClass({ isActive: activeTag === String(t.id) })}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color }} />
              <span className="flex-1 truncate">{t.name}</span>
              <span className="text-xs text-zinc-400">{t.count}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 space-y-1 border-t border-zinc-200/80 pt-4 dark:border-zinc-800">
          <NavLink to="/settings" className={navClass}><Settings size={18} /> Paramètres</NavLink>
          <button onClick={logout} className={navClass({ isActive: false }) + ' w-full'}>
            <LogOut size={18} /> Déconnexion <span className="ml-auto text-xs text-zinc-400">{user.username}</span>
          </button>
          <p className="px-3 pt-2 text-xs text-zinc-400">v{version}</p>
        </div>
      </aside>

      <header className="sticky top-0 z-20 border-b border-zinc-200/80 bg-zinc-50/80 px-4 pb-3 pt-[max(.75rem,env(safe-area-inset-top))] backdrop-blur-xl md:px-8 dark:border-zinc-800/80 dark:bg-zinc-950/70">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <img src="/icon.svg" alt="" className="h-8 w-8 rounded-lg md:hidden" />
          <label className="relative flex-1">
            <span className="sr-only">Rechercher</span>
            <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher dans tous les documents…"
              className="input rounded-2xl pl-10"
            />
          </label>
          <button className="btn-primary hidden sm:inline-flex" onClick={() => fileInput.current.click()}>
            <Upload size={18} /> Ajouter
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pb-28 pt-6 md:px-8 md:pb-10">
        <Outlet context={{ tags, revision, changed, reloadTags }} />
      </main>

      <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />

      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-zinc-200/80 bg-white/80 px-6 pb-[max(.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl md:hidden dark:border-zinc-800 dark:bg-zinc-900/80">
        <NavLink to="/" end className={({ isActive }) => `flex flex-col items-center gap-0.5 text-xs ${isActive ? 'text-indigo-500' : 'text-zinc-500'}`}>
          <FileText size={22} /> Documents
        </NavLink>
        <button onClick={() => fileInput.current.click()} aria-label="Ajouter des documents"
          className="-mt-8 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-xl shadow-indigo-500/40">
          <Upload size={24} />
        </button>
        <NavLink to="/settings" className={({ isActive }) => `flex flex-col items-center gap-0.5 text-xs ${isActive ? 'text-indigo-500' : 'text-zinc-500'}`}>
          <Settings size={22} /> Réglages
        </NavLink>
      </nav>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-indigo-500/10 p-6 backdrop-blur-sm">
          <div className="rounded-3xl border-2 border-dashed border-indigo-400 bg-white/90 px-12 py-10 text-center shadow-2xl dark:bg-zinc-900/90">
            <Upload className="mx-auto mb-3 text-indigo-500" size={36} />
            <p className="text-lg font-semibold">Déposez vos fichiers</p>
            <p className="text-sm text-zinc-500">Ils seront indexés automatiquement</p>
          </div>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="fixed bottom-24 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] space-y-2 md:bottom-6">
          {uploads.map((u) => (
            <div key={u.id} className="card flex items-center gap-3 p-3 shadow-lg">
              {u.state === 'busy' && <Loader2 size={18} className="shrink-0 animate-spin text-indigo-500" />}
              {u.state === 'done' && <CheckCircle2 size={18} className="shrink-0 text-emerald-500" />}
              {u.state === 'error' && <AlertCircle size={18} className="shrink-0 text-red-500" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{u.name}</p>
                {u.state === 'error' ? <p className="text-xs text-red-500">{u.error}</p> : (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all" style={{ width: `${u.progress * 100}%` }} />
                  </div>
                )}
              </div>
              {u.state === 'error' && (
                <button aria-label="Fermer" className="text-zinc-400 hover:text-zinc-600" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
