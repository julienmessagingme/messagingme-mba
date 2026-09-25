'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { changePassword } from '@/lib/api';
import { getSession, pageDArrivee, type Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { MIN_MOT_DE_PASSE, aideMotDePasse } from '@/lib/mot-de-passe';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';

export default function ComptePage() {
  const t = useT();
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
      setMsg({ kind: 'ok', text: t('Mot de passe mis à jour.', 'Password updated.') });
      setCurrent('');
      setNext('');
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Changement impossible', 'Unable to change password') });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <Link href={pageDArrivee(session.role)} className="mb-4 inline-block text-sm text-brand-600 hover:underline">← {t('Retour', 'Back')}</Link>
      <TitrePage>{t('Mon compte', 'My account')}</TitrePage>
      <p className="mt-1 text-sm text-ink-400">{session.email}</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4 rounded-2xl border border-ink-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-ink-900">{t('Changer le mot de passe', 'Change password')}</h2>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-900">{t('Mot de passe actuel', 'Current password')}</label>
          <input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-900">{t('Nouveau mot de passe', 'New password')}</label>
          <input type="password" required minLength={MIN_MOT_DE_PASSE} value={next} onChange={(e) => setNext(e.target.value)} className={inputCls} placeholder={t(aideMotDePasse().fr, aideMotDePasse().en)} />
        </div>
        {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-succes-50 text-succes-800' : 'bg-danger-50 text-danger-700'}`}>{msg.text}</p>}
        <Bouton enCours={loading} type="submit" disabled={loading} className="w-full">
          {loading ? t('Mise à jour...', 'Updating...') : t('Mettre à jour', 'Update')}
        </Bouton>
      </form>
    </main>
  );
}
