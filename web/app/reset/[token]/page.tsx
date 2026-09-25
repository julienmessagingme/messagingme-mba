'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { resetPassword } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { MIN_MOT_DE_PASSE, aideMotDePasse } from '@/lib/mot-de-passe';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';

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
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <LocaleToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Logo className="mx-auto mb-3 h-14 w-14" />
          <TitrePage>{t('Nouveau mot de passe', 'New password')}</TitrePage>
        </div>
        {done ? (
          <div className="rounded-carte border border-ink-200 bg-white p-6 text-center">
            <p className="text-sm text-succes-700">{t('Mot de passe mis à jour. Redirection vers la connexion…', 'Password updated. Redirecting to sign-in…')}</p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 rounded-carte border border-ink-200 bg-white p-6">
            <input type="password" required minLength={MIN_MOT_DE_PASSE} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} placeholder={t(aideMotDePasse().fr, aideMotDePasse().en)} />
            {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
            <Bouton enCours={loading} type="submit" disabled={loading} className="w-full">
              {loading ? t('Mise à jour…', 'Updating…') : t('Définir le mot de passe', 'Set password')}
            </Bouton>
            <p className="text-center text-xs text-ink-500"><Link href="/login" className="font-medium text-brand-600 hover:underline">{t('Retour à la connexion', 'Back to sign-in')}</Link></p>
          </form>
        )}
      </div>
    </main>
  );
}
