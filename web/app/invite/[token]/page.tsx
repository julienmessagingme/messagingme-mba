'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { acceptInvitation } from '@/lib/api';
import { saveSession } from '@/lib/session';
import { Logo } from '@/components/Logo';
import { GoogleButton } from '@/components/GoogleButton';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';

const inputCls = 'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const t = useT();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await acceptInvitation(token, password);
      saveSession({ token: res.token, email: res.user.email, role: res.user.role, tenantId: res.user.tenantId });
      router.replace(res.user.role === 'agent' ? '/inbox' : '/accueil');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Invitation invalide ou expirée', 'Invalid or expired invitation'));
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
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t("Rejoindre l'espace", 'Join the workspace')}</h1>
          <p className="mt-1 text-sm text-ink-400">{t('Choisis ton mot de passe pour activer ton compte.', 'Choose a password to activate your account.')}</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
          <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} placeholder={t('Mot de passe (8 caractères min)', 'Password (8 characters min)')} />
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
            {loading ? t('Activation...', 'Activating...') : t('Activer mon compte', 'Activate my account')}
          </button>
          <p className="text-center text-xs text-ink-400"><Link href="/login" className="font-medium text-brand-600 hover:underline">{t('Déjà activé ? Se connecter', 'Already activated? Sign in')}</Link></p>

          <GoogleButton onError={setError} />
        </form>
      </div>
    </main>
  );
}
