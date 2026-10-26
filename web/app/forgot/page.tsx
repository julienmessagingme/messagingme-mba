'use client';

import { useState } from 'react';
import Link from 'next/link';
import { forgotPassword } from '@/lib/api';
import { CadreSansCompte } from '@/components/CadreSansCompte';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';

export default function ForgotPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    // Réponse toujours générique côté serveur (anti-énumération) : on affiche le même message quoi qu'il arrive.
    try { await forgotPassword(email.trim()); } catch { /* on n'affiche jamais d'erreur révélatrice */ }
    setSent(true);
    setLoading(false);
  }

  return (
    <CadreSansCompte titre={t('Mot de passe oublié', 'Forgot password')}>
      {sent ? (
        <div className="rounded-carte border border-ink-200 bg-white p-6 text-center">
          <p className="text-sm text-ink-900">{t('Si un compte existe pour cet email, un lien de réinitialisation vient d’être envoyé. Pensez à vérifier vos spams.', 'If an account exists for this email, a reset link has just been sent. Remember to check your spam folder.')}</p>
          <Link href="/login" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline">{t('Retour à la connexion', 'Back to login')}</Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4 rounded-carte border border-ink-200 bg-white p-6">
          <p className="text-sm text-ink-500">{t('Saisissez votre email : nous vous envoyons un lien pour choisir un nouveau mot de passe.', 'Enter your email: we will send you a link to choose a new password.')}</p>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder={t('vous@entreprise.fr', 'you@company.com')} />
          <Bouton enCours={loading} type="submit" disabled={loading} className="w-full">
            {loading ? t('Envoi…', 'Sending…') : t('Envoyer le lien', 'Send the link')}
          </Bouton>
          <p className="text-center text-xs text-ink-500"><Link href="/login" className="font-medium text-brand-600 hover:underline">{t('Retour', 'Back')}</Link></p>
        </form>
      )}
    </CadreSansCompte>
  );
}
