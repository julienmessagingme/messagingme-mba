'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { login, chooseWorkspace, isLoginChoice, type LoginChoice } from '@/lib/api';
import { saveSession, pageDArrivee } from '@/lib/session';
import { Logo } from '@/components/Logo';
import { GoogleButton } from '@/components/GoogleButton';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * Choix d'espace en attente : l'adresse en dessert plusieurs. `null` = formulaire normal.
   *
   * Le mot de passe est déjà vérifié à ce stade ; il ne reste qu'à savoir OÙ entrer. C'est la question que
   * l'ancienne règle « un email = un compte » évitait en interdisant le cas.
   */
  const [choix, setChoix] = useState<LoginChoice | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await login(email.trim(), password);
      // Adresse donnant accès à PLUSIEURS espaces : on ne choisit pas à la place de l'utilisateur, on
      // affiche la liste. Aucune session n'existe à ce stade, seulement un jeton de choix.
      if (isLoginChoice(res)) {
        setChoix(res);
        return;
      }
      saveSession({ token: res.token, email: res.user.email, role: res.user.role, tenantId: res.user.tenantId });
      router.replace(pageDArrivee(res.user.role));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Connexion impossible', 'Unable to sign in'));
    } finally {
      setLoading(false);
    }
  }

  /** L'utilisateur a désigné son espace : on échange le jeton de choix contre une vraie session. */
  async function entrer(tenantId: string): Promise<void> {
    if (!choix) return;
    setError(null);
    setLoading(true);
    try {
      const res = await chooseWorkspace(choix.choiceToken, tenantId);
      saveSession({ token: res.token, email: res.user.email, role: res.user.role, tenantId: res.user.tenantId });
      router.replace(pageDArrivee(res.user.role));
    } catch (err) {
      // Le jeton de choix est court (5 min) : le plus probable est qu'il ait expiré. On le dit, et on ramène
      // au formulaire plutôt que de laisser une liste morte à l'écran.
      setChoix(null);
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

        {choix ? (
          <div className="space-y-3 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm" data-testid="choix-espace">
            <p className="text-sm text-ink-700">
              {t('Cette adresse donne accès à plusieurs espaces. Lequel veux-tu ouvrir ?', 'This address gives access to several workspaces. Which one do you want to open?')}
            </p>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <ul className="space-y-2">
              {choix.workspaces.map((w) => (
                <li key={w.tenantId}>
                  <button
                    type="button"
                    onClick={() => { void entrer(w.tenantId); }}
                    disabled={loading}
                    data-testid={`espace-${w.tenantId}`}
                    className="flex w-full items-center justify-between rounded-xl border border-ink-200 px-4 py-3 text-left transition hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50"
                  >
                    <span className="text-sm font-medium text-ink-900">{w.tenantName}</span>
                    <span className="text-xs text-ink-500">{w.role}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => { setChoix(null); setError(null); }}
              className="text-xs text-ink-500 underline hover:text-ink-800"
            >
              {t('Utiliser une autre adresse', 'Use another address')}
            </button>
          </div>
        ) : (
        <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
          <div>
            {/* `htmlFor`/`id` : le label n'était relié à rien, donc invisible pour un lecteur d'écran et
                sans effet au clic. Deux attributs, et le champ devient annonçable. */}
            <label htmlFor="login-email" className="mb-1 block text-sm font-medium text-ink-700">Email</label>
            <input
              id="login-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
              placeholder="admin@demo.test"
            />
          </div>
          <div>
            <label htmlFor="login-password" className="mb-1 block text-sm font-medium text-ink-700">{t('Mot de passe', 'Password')}</label>
            <input
              id="login-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
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
        )}
      </div>
    </main>
  );
}
