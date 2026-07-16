'use client';

import { useState } from 'react';
import Link from 'next/link';
import { forgotPassword } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';

const inputCls = 'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

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
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('Mot de passe oublié', 'Forgot password')}</h1>
        </div>
        {sent ? (
          <div className="rounded-2xl border border-ink-200 bg-white p-6 text-center shadow-sm">
            <p className="text-sm text-ink-700">{t("Si un compte existe pour cet email, un lien de réinitialisation vient d'être envoyé. Pense à vérifier tes spams.", 'If an account exists for this email, a reset link has just been sent. Remember to check your spam folder.')}</p>
            <Link href="/login" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline">{t('Retour à la connexion', 'Back to login')}</Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-ink-500">{t("Entre ton email : on t'envoie un lien pour choisir un nouveau mot de passe.", 'Enter your email: we will send you a link to choose a new password.')}</p>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder={t('toi@entreprise.fr', 'you@company.com')} />
            <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
              {loading ? t('Envoi...', 'Sending...') : t('Envoyer le lien', 'Send the link')}
            </button>
            <p className="text-center text-xs text-ink-400"><Link href="/login" className="font-medium text-brand-600 hover:underline">{t('Retour', 'Back')}</Link></p>
          </form>
        )}
      </div>
    </main>
  );
}
