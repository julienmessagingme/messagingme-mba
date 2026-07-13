'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { changePassword } from '@/lib/api';
import { getSession, type Session } from '@/lib/session';

const inputCls = 'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

export default function ComptePage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const s = getSession();
    if (!s) { router.replace('/login'); return; }
    setSession(s);
  }, [router]);

  if (!session) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setLoading(true);
    try {
      await changePassword(current, next);
      setMsg({ kind: 'ok', text: 'Mot de passe mis à jour.' });
      setCurrent('');
      setNext('');
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Changement impossible' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <Link href={session.role === 'agent' ? '/inbox' : '/accueil'} className="mb-4 inline-block text-sm text-brand-600 hover:underline">← Retour</Link>
      <h1 className="text-lg font-semibold tracking-tight text-ink-900">Mon compte</h1>
      <p className="mt-1 text-sm text-ink-400">{session.email}</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-ink-800">Changer le mot de passe</h2>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-700">Mot de passe actuel</label>
          <input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-700">Nouveau mot de passe</label>
          <input type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} className={inputCls} placeholder="8 caractères minimum" />
        </div>
        {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
        <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
          {loading ? 'Mise à jour...' : 'Mettre à jour'}
        </button>
      </form>
    </main>
  );
}
