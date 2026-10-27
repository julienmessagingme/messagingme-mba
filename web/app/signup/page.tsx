'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { signup, isLoginChoice, estEtapeSecondFacteur, type EtapeSecondFacteur, type SuiteConnexion } from '@/lib/api';
import { saveSession } from '@/lib/session';
import { avecDemande, demandeDeLAdresse } from '@/lib/oauth';
import { CadreSansCompte } from '@/components/CadreSansCompte';
import { GoogleButton, RetourGoogle } from '@/components/GoogleButton';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { aideMotDePasse } from '@/lib/mot-de-passe';
import { MIN_MOT_DE_PASSE } from '@/lib/partage/mot-de-passe';
import { Bouton } from '@/components/Bouton';
import { EtapesSecondFacteur, EtapeInterrompue } from '@/components/SecondFacteur';

export default function SignupPage() {
  const router = useRouter();
  const t = useT();
  const [workspaceName, setWorkspaceName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * L'espace est créé, et la réponse est d'ordinaire la session : un espace neuf n'exige pas le second facteur. Une
   * étape seulement si l'adresse en a déjà un (son code) ou est admin d'un autre espace qui l'exige (l'enrôlement).
   */
  const [etape, setEtape] = useState<EtapeSecondFacteur | null>(null);
  /**
   * L'étape n'a pas abouti (expirée). L'espace EXISTE : renvoyer au formulaire en créerait un second, on
   * renvoie donc à la connexion, qui reprendra l'enrôlement.
   */
  const [interrompu, setInterrompu] = useState<string | null>(null);
  /** Venue de la page d'autorisation d'une application (Claude Code), sans compte Google : on y retourne ensuite. */
  const [demande, setDemande] = useState<string | null>(null);

  // Lu ici et pas au rendu : l'adresse n'existe pas côté serveur.
  useEffect(() => { setDemande(demandeDeLAdresse(window.location.search)); }, []);

  function entrer(res: SuiteConnexion): void {
    // Impossible par construction (l'inscription porte un seul espace) : la connexion saura demander.
    if (isLoginChoice(res)) {
      router.replace(avecDemande('/login', demande));
      return;
    }
    saveSession({ token: res.token, email: res.user.email, role: res.user.role, tenantId: res.user.tenantId });
    // Le tunnel de la Base (lot 19) : le numéro (sautable), puis la page finale, sans passer par l'accueil. Venu
    // d'une application, le consentement d'abord : c'est elle qui fait la suite (`/messagingme:demarrer`).
    router.replace(demande !== null ? avecDemande('/autoriser', demande) : '/connecter-whatsapp?suite=demarrer');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await signup({ workspaceName: workspaceName.trim(), email: email.trim(), password, name: name.trim() || undefined });
      setPassword('');
      if (estEtapeSecondFacteur(res)) setEtape(res);
      else entrer(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Inscription impossible', 'Sign-up failed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <CadreSansCompte titre={t('Créer votre espace', 'Create your workspace')} sousTitre={t('Votre espace WhatsApp Business en quelques secondes.', 'Your WhatsApp Business workspace in seconds.')}>

      {etape ? (
        <EtapesSecondFacteur etape={etape} onSuite={entrer} onRetour={(message) => { setEtape(null); setInterrompu(message); }} />
      ) : interrompu ? (
        <EtapeInterrompue message={interrompu} connexion={avecDemande('/login', demande)} />
      ) : (
      <form onSubmit={onSubmit} className="space-y-4 rounded-carte border border-ink-200 bg-white p-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-900">{t("Nom de l’espace / entreprise", 'Workspace / company name')}</label>
          <input required maxLength={80} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} className={inputCls} placeholder={t('Mon entreprise', 'My company')} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-900">{t('Votre nom', 'Your name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder={t('Prénom Nom', 'First Last')} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-900">{t('Email', 'Email')}</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder={t('vous@entreprise.fr', 'you@company.com')} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-900">{t('Mot de passe', 'Password')}</label>
          <input type="password" required minLength={MIN_MOT_DE_PASSE} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} placeholder={t(aideMotDePasse().fr, aideMotDePasse().en)} />
        </div>

        {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

        <Bouton enCours={loading} type="submit" disabled={loading} className="w-full">
          {loading ? t('Création…', 'Creating…') : t('Créer mon espace', 'Create my workspace')}
        </Bouton>
        <p className="text-center text-xs text-ink-500">{t('Déjà un compte ?', 'Already have an account?')} <Link href={avecDemande('/login', demande)} className="font-medium text-brand-600 hover:underline">{t('Se connecter', 'Log in')}</Link></p>

        {/* Venu d'une application, Google est sur la page d'autorisation : ici il ouvrirait la console et perdrait la
            demande. On y renvoie, pour une adresse qui est en fait un compte Google (l'inscription la refuse). */}
        {demande === null ? <GoogleButton onError={setError} /> : <RetourGoogle demande={demande} />}
      </form>
      )}
    </CadreSansCompte>
  );
}
