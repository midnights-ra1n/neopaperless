import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api } from './api.js';
import Auth from './pages/Auth.jsx';
import Layout from './components/Layout.jsx';
import Documents from './pages/Documents.jsx';
import DocumentView from './pages/DocumentView.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const refresh = () => api('/status').then(setStatus).catch((e) => setError(e.message));

  useEffect(() => {
    refresh();
    const onLogout = () => setStatus((s) => s && { ...s, user: null });
    window.addEventListener('np:logout', onLogout);
    return () => window.removeEventListener('np:logout', onLogout);
  }, []);

  if (error) return <div className="grid min-h-dvh place-items-center p-6 text-center text-zinc-500">Serveur injoignable : {error}</div>;
  if (!status) return <div className="min-h-dvh" />;
  if (status.setupRequired || !status.user) return <Auth setup={status.setupRequired} onDone={refresh} />;

  return (
    <Routes>
      <Route element={<Layout user={status.user} version={status.version} onLogout={refresh} />}>
        <Route index element={<Documents />} />
        <Route path="documents/:id" element={<DocumentView />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
