'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { resetPassword } from '@/lib/api';
import { CadreSansCompte } from '@/components/CadreSansCompte';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { aideMotDePasse } from '@/lib/mot-de-passe';
import { MIN_MOT_DE_PASSE } from '@/lib/partage/mot-de-passe';
import { Bouton } from '@/components/Bouton';

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
    <CadreSansCompte titre={t('Nouveau mot de passe', 'New password')}>
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
    </CadreSansCompte>
  );
}
