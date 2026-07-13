'use client';

import { useState } from 'react';
import Link from 'next/link';
import { forgotPassword } from '@/lib/api';
import { Logo } from '@/components/Logo';

const inputCls = 'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

export default function ForgotPage() {
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
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Logo className="mx-auto mb-3 h-14 w-14" />
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">Mot de passe oublié</h1>
        </div>
        {sent ? (
          <div className="rounded-2xl border border-ink-200 bg-white p-6 text-center shadow-sm">
            <p className="text-sm text-ink-700">Si un compte existe pour cet email, un lien de réinitialisation vient d&apos;être envoyé. Pense à vérifier tes spams.</p>
            <Link href="/login" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline">Retour à la connexion</Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-ink-500">Entre ton email : on t&apos;envoie un lien pour choisir un nouveau mot de passe.</p>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="toi@entreprise.fr" />
            <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
              {loading ? 'Envoi...' : 'Envoyer le lien'}
            </button>
            <p className="text-center text-xs text-ink-400"><Link href="/login" className="font-medium text-brand-600 hover:underline">Retour</Link></p>
          </form>
        )}
      </div>
    </main>
  );
}
