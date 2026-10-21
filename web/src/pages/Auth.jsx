import { useState } from 'react';
import { send } from '../api.js';

export default function Auth({ setup, onDone }) {
  const [form, setForm] = useState({ username: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    if (setup && form.password !== form.confirm) return setError('Les mots de passe ne correspondent pas');
    setBusy(true);
    setError('');
    try {
      await send(setup ? '/setup' : '/login', { username: form.username, password: form.password });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-gradient-to-br from-indigo-500/30 to-violet-500/30 blur-3xl" />
      <form onSubmit={submit} className="card relative w-full max-w-sm space-y-5 p-8 backdrop-blur">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="/icon.svg" alt="" className="h-14 w-14 rounded-2xl shadow-lg shadow-indigo-500/30" />
          <h1 className="text-2xl font-semibold tracking-tight">NeoPaperless</h1>
          <p className="text-sm text-zinc-500">
            {setup ? 'Bienvenue ! Créez le compte administrateur pour commencer.' : 'Connectez-vous pour accéder à vos documents.'}
          </p>
        </div>
        <div>
          <label className="label" htmlFor="username">Nom d'utilisateur</label>
          <input id="username" className="input" autoComplete="username" required value={form.username} onChange={set('username')} />
        </div>
        <div>
          <label className="label" htmlFor="password">Mot de passe</label>
          <input id="password" type="password" className="input" required minLength={setup ? 8 : undefined}
            autoComplete={setup ? 'new-password' : 'current-password'} value={form.password} onChange={set('password')} />
        </div>
        {setup && (
          <div>
            <label className="label" htmlFor="confirm">Confirmer le mot de passe</label>
            <input id="confirm" type="password" className="input" required autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />
          </div>
        )}
        {error && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-500/10 dark:text-red-400">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>{setup ? 'Créer le compte' : 'Se connecter'}</button>
      </form>
    </div>
  );
}
