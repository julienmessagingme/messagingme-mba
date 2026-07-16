'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { resetPassword } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { useT } from '@/lib/i18n';

const inputCls = 'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

export default function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await resetPassword(token, password);
      setDone(true);
      setTimeout(() => router.replace('/login'), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Lien invalide ou expiré', 'Invalid or expired link'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Logo className="mx-auto mb-3 h-14 w-14" />
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('Nouveau mot de passe', 'New password')}</h1>
        </div>
        {done ? (
          <div className="rounded-2xl border border-ink-200 bg-white p-6 text-center shadow-sm">
            <p className="text-sm text-emerald-700">{t('Mot de passe mis à jour. Redirection vers la connexion…', 'Password updated. Redirecting to sign-in…')}</p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} placeholder={t('Nouveau mot de passe (8 min)', 'New password (8 min)')} />
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
              {loading ? t('Mise à jour...', 'Updating...') : t('Définir le mot de passe', 'Set password')}
            </button>
            <p className="text-center text-xs text-ink-400"><Link href="/login" className="font-medium text-brand-600 hover:underline">{t('Retour à la connexion', 'Back to sign-in')}</Link></p>
          </form>
        )}
      </div>
    </main>
  );
}
