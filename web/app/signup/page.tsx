'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { signup } from '@/lib/api';
import { saveSession } from '@/lib/session';
import { Logo } from '@/components/Logo';
import { GoogleButton } from '@/components/GoogleButton';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';

const inputCls = 'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

export default function SignupPage() {
  const router = useRouter();
  const t = useT();
  const [workspaceName, setWorkspaceName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await signup({ workspaceName: workspaceName.trim(), email: email.trim(), password, name: name.trim() || undefined });
      saveSession({ token: res.token, email: res.user.email, role: res.user.role, tenantId: res.user.tenantId });
      router.replace('/accueil');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Inscription impossible', 'Sign-up failed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center px-4 py-8">
      <div className="absolute right-4 top-4">
        <LocaleToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Logo className="mx-auto mb-3 h-14 w-14" />
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('Créer ton espace', 'Create your workspace')}</h1>
          <p className="mt-1 text-sm text-ink-400">{t('Ton espace WhatsApp Business en quelques secondes.', 'Your WhatsApp Business space in seconds.')}</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t("Nom de l'espace / entreprise", 'Workspace / company name')}</label>
            <input required value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} className={inputCls} placeholder={t('Mon entreprise', 'My company')} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Ton nom', 'Your name')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder={t('Prénom Nom', 'First Last')} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Email', 'Email')}</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder={t('toi@entreprise.fr', 'you@company.com')} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Mot de passe', 'Password')}</label>
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} placeholder={t('8 caractères minimum', '8 characters minimum')} />
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
            {loading ? t('Création...', 'Creating...') : t('Créer mon espace', 'Create my workspace')}
          </button>
          <p className="text-center text-xs text-ink-400">{t('Déjà un compte ?', 'Already have an account?')} <Link href="/login" className="font-medium text-brand-600 hover:underline">{t('Se connecter', 'Log in')}</Link></p>

          <GoogleButton onError={setError} />
        </form>
      </div>
    </main>
  );
}
