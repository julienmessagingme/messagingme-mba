'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { login } from '@/lib/api';
import { saveSession } from '@/lib/session';
import { Logo } from '@/components/Logo';
import { GoogleButton } from '@/components/GoogleButton';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await login(email.trim(), password);
      saveSession({ token: res.token, email: res.user.email, role: res.user.role, tenantId: res.user.tenantId });
      router.replace(res.user.role === 'agent' ? '/inbox' : '/accueil');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Connexion impossible', 'Unable to sign in'));
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
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">MM Business Agent</h1>
          <p className="mt-1 text-sm text-ink-400">{t('Connecte-toi pour gérer tes contacts et campagnes.', 'Sign in to manage your contacts and campaigns.')}</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder="admin@demo.test"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Mot de passe', 'Password')}</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder="********"
            />
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
          >
            {loading ? t('Connexion...', 'Signing in...') : t('Se connecter', 'Sign in')}
          </button>
          <div className="flex items-center justify-between text-xs text-ink-400">
            <Link href="/forgot" className="hover:text-brand-600">{t('Mot de passe oublié ?', 'Forgot password?')}</Link>
            <Link href="/signup" className="font-medium text-brand-600 hover:underline">{t('Créer un espace', 'Create a workspace')}</Link>
          </div>

          <GoogleButton onError={setError} />
        </form>
      </div>
    </main>
  );
}
