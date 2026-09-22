export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw Object.assign(new Error(body.message ?? r.statusText), { status: r.status, body });
  }
  return r.json();
}

export const fmt = (n: number | undefined | null, d = 1) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—';
