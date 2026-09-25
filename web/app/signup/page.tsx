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
import { inputCls } from '@/lib/ui';
import { MIN_MOT_DE_PASSE, aideMotDePasse } from '@/lib/mot-de-passe';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';

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
          <TitrePage>{t('Créer ton espace', 'Create your workspace')}</TitrePage>
          <p className="mt-1 text-sm text-ink-400">{t('Ton espace WhatsApp Business en quelques secondes.', 'Your WhatsApp Business space in seconds.')}</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-6">
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-900">{t("Nom de l'espace / entreprise", 'Workspace / company name')}</label>
            <input required maxLength={80} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} className={inputCls} placeholder={t('Mon entreprise', 'My company')} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-900">{t('Ton nom', 'Your name')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder={t('Prénom Nom', 'First Last')} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-900">{t('Email', 'Email')}</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder={t('toi@entreprise.fr', 'you@company.com')} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-900">{t('Mot de passe', 'Password')}</label>
            <input type="password" required minLength={MIN_MOT_DE_PASSE} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} placeholder={t(aideMotDePasse().fr, aideMotDePasse().en)} />
          </div>

          {error && <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

          <Bouton enCours={loading} type="submit" disabled={loading} className="w-full">
            {loading ? t('Création...', 'Creating...') : t('Créer mon espace', 'Create my workspace')}
          </Bouton>
          <p className="text-center text-xs text-ink-400">{t('Déjà un compte ?', 'Already have an account?')} <Link href="/login" className="font-medium text-brand-600 hover:underline">{t('Se connecter', 'Log in')}</Link></p>

          <GoogleButton onError={setError} />
        </form>
      </div>
    </main>
  );
}
