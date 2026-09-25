'use client';

import { useState } from 'react';
import Link from 'next/link';
import { forgotPassword } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';

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
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <LocaleToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Logo className="mx-auto mb-3 h-14 w-14" />
          <TitrePage>{t('Mot de passe oublié', 'Forgot password')}</TitrePage>
        </div>
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
      </div>
    </main>
  );
}
