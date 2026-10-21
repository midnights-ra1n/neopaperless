export async function api(path, opts = {}) {
  const headers = typeof opts.body === 'string' ? { 'content-type': 'application/json', ...opts.headers } : opts.headers;
  const r = await fetch(`/api${path}`, { ...opts, headers });
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (r.status === 401 && path !== '/login') window.dispatchEvent(new Event('np:logout'));
  if (!r.ok) throw Object.assign(new Error(data?.error || `Erreur ${r.status}`), { status: r.status, data });
  return data;
}

export const send = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body) });

// XHR instead of fetch: fetch cannot report upload progress.
export function upload(path, file, { headers = {}, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data?.error || `Erreur ${xhr.status}`), { status: xhr.status, data }));
    };
    xhr.onerror = () => reject(new Error('Erreur réseau'));
    xhr.send(file);
  });
}

export const formatSize = (n) =>
  n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(0)} Ko` : `${(n / 1048576).toFixed(1)} Mo`;

export const formatDate = (s) =>
  s ? new Date(s.length === 10 ? s : s.replace(' ', 'T') + 'Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
