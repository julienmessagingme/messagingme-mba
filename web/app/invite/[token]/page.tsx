'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { acceptInvitation, estEtapeSecondFacteur, isLoginChoice, type EtapeSecondFacteur, type SuiteConnexion } from '@/lib/api';
import { saveSession, pageDArrivee } from '@/lib/session';
import { EtapesSecondFacteur, EtapeInterrompue } from '@/components/SecondFacteur';
import { Logo } from '@/components/Logo';
import { GoogleButton } from '@/components/GoogleButton';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { MIN_MOT_DE_PASSE, aideMotDePasse } from '@/lib/mot-de-passe';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const t = useT();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Invitation d'administrateur, ou adresse qui a déjà un second facteur : l'étape passe avant la session. */
  const [etape, setEtape] = useState<EtapeSecondFacteur | null>(null);
  /** L'étape n'a pas abouti. L'invitation est CONSOMMÉE : le formulaire ne la rejouerait pas, la connexion si. */
  const [interrompu, setInterrompu] = useState<string | null>(null);

  function entrer(res: SuiteConnexion): void {
    // Impossible par construction (l'invitation ouvre un seul espace) : la connexion saura demander.
    if (isLoginChoice(res)) {
      router.replace('/login');
      return;
    }
    saveSession({ token: res.token, email: res.user.email, role: res.user.role, tenantId: res.user.tenantId });
    router.replace(pageDArrivee(res.user.role));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await acceptInvitation(token, password);
      if (estEtapeSecondFacteur(res)) {
        setPassword('');
        setEtape(res);
        return;
      }
      entrer(res);
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
          <TitrePage>{t("Rejoindre l’espace", 'Join the workspace')}</TitrePage>
          <p className="mt-1 text-sm text-ink-500">{t('Choisissez votre mot de passe pour activer votre compte.', 'Choose a password to activate your account.')}</p>
        </div>
        {etape ? (
          <EtapesSecondFacteur etape={etape} onSuite={entrer} onRetour={(message) => { setEtape(null); setInterrompu(message); }} />
        ) : interrompu ? (
          <EtapeInterrompue message={interrompu} />
        ) : (
        <form onSubmit={onSubmit} className="space-y-4 rounded-carte border border-ink-200 bg-white p-6">
          <input type="password" required minLength={MIN_MOT_DE_PASSE} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} placeholder={t(aideMotDePasse().fr, aideMotDePasse().en)} />
          {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
          <Bouton enCours={loading} type="submit" disabled={loading} className="w-full">
            {loading ? t('Activation…', 'Activating…') : t('Activer mon compte', 'Activate my account')}
          </Bouton>
          <p className="text-center text-xs text-ink-500"><Link href="/login" className="font-medium text-brand-600 hover:underline">{t('Déjà activé ? Se connecter', 'Already activated? Sign in')}</Link></p>

          <GoogleButton onError={setError} />
        </form>
        )}
      </div>
    </main>
  );
}
