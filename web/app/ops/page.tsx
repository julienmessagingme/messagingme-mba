'use client';

import { useCallback, useEffect, useState } from 'react';
import { DailyChart } from '@/components/DailyChart';
import { getOpsOverview, getOpsStockage, getOpsVercel, type JaugeVercel, observerTenant, lireGrillePrixOps, ecrireGrillePrixOps, loginOps, loginOpsGoogle, estEtapeSecondFacteur, type OpsOverview,
  lireNumerosFournis, declarerNumeroFourni, sortirNumeroDeLaReserve, type ReserveNumerosOps, lirePlafondApiOps, type PlafondApiOps, type FenetrePlafondOps,
  lireOffreOps, ecrireOffreOps, type OffreEntrepriseOps,
  lireSuppressionOps, supprimerEspaceOps, type BilanSuppressionOps, type EtapePrevueOps, type SuppressionEspaceOps, type EtapeSuppressionNom,
  type TenantOverviewRow, type QueueLoadRow, type QueueGroupLoadRow, type QueueLatenceRow, type LatenceHttpRow, type WorkerHeartbeat, type PoolInstantane,
  type PoolAttentePoint, type GrillePrix, type EtapeSecondFacteur, type SessionOpsOuverte, type TacheFondRow, type MesureStockage } from '@/lib/api';
import { ApiError } from '@/lib/http';
import { GrillePrixChamps } from '@/components/GrillePrixChamps';
import { enChamps, depuisChamps } from '@/lib/grille-saisie';
import { formatDate } from '@/lib/day';
import { fmtCost, fmtNum } from '@/lib/format';
import { eurosDepuisMicro } from '@/lib/agent-solde';
import { Modale } from '@/components/Modale';
import { ordonnerLatences, enAlerte, SEUIL_P95_MS, EFFECTIF_MIN, CODE_ABANDON } from '@/lib/latence-http';
import { tacheEnAlerte, fichiersEnBase, fmtOctets, SEUIL_TACHE_LENTE_MS, SEUIL_FICHIERS_EN_BASE_OCTETS, teinteVercel, fmtDollars, SEUIL_VERCEL_ORANGE_POURCENT, SEUIL_VERCEL_ROUGE_POURCENT } from '@/lib/ops-mesures';
import { useLocale, useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { saveSession, getSessionOps, saveSessionOps, clearSessionOps, type SessionOps } from '@/lib/session';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';
import { EtapesSecondFacteur } from '@/components/SecondFacteur';
import { GoogleButton } from '@/components/GoogleButton';
import { alerte, brand, danger, ink, succes } from '@/lib/couleurs';
import { useConfirmation } from '@/components/Confirmation';
import { Squelette } from '@/components/Squelette';
import { Nd } from '@/components/Nd';
import { lireConservation, conservationPeutPurger, lireContactsEntreprise, lireCommissionEntreprise } from '@/lib/ops-offre';
import { lireUtilisateursBusiness, retraitCoupeLeNumero } from '@/lib/ops-offre';
import { OpsEmailsCard } from '@/components/OpsEmailsCard';
import { MbaTabs } from '@/components/MbaTabs';
import { OpsSante } from '@/components/OpsSante';
import { OpsCapacite } from '@/components/OpsCapacite';
import { OpsSeuils } from '@/components/OpsSeuils';

/**
 * Les quatre onglets (refonte, `docs/superpowers/specs/2026-10-27-ops-refonte-design.md`). Santé d'abord : c'est
 * l'écran du téléphone. L'onglet vit dans l'adresse (`?tab=`), lu au montage et réécrit sans recharger.
 */
const ONGLETS = ['sante', 'capacite', 'clients', 'reglages'] as const;
type Onglet = (typeof ONGLETS)[number];
const ongletDe = (valeur: string | null): Onglet => (ONGLETS as readonly string[]).includes(valeur ?? '') ? valeur as Onglet : 'sante';

/**
 * LA CONSOLE D'EXPLOITATION, NOMINATIVE (plan `docs/superpowers/plans/2026-09-28-ops-nominatif.md`).
 *
 * Plus de jeton partagé : on se connecte avec son compte habituel (mot de passe ou Google), puis son second
 * facteur, et le serveur rend une session d'exploitation de 12 heures, gardée à part de la session d'espace
 * (`lib/session.ts`). C'est le SERVEUR qui décide qui entre (la liste `OPS_EMAILS`, relue à chaque requête) :
 * l'écran ne fait que présenter la session, et la quitte au premier 401.
 */
export default function OpsPage() {
  const t = useT();
  const confirmer = useConfirmation();
  const { locale } = useLocale();
  const [session, setSession] = useState<SessionOps | null>(null);
  /** `false` tant que la session gardée n'est pas relue : sans lui, le formulaire clignoterait avant la vue. */
  const [pret, setPret] = useState(false);
  const [data, setData] = useState<OpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** L'espace dont on ouvre le bilan de suppression (RC8). */
  const [aSupprimer, setASupprimer] = useState<{ id: string; nom: string } | null>(null);
  const [quotasDe, setQuotasDe] = useState<{ id: string; nom: string } | null>(null);
  const [offreDe, setOffreDe] = useState<{ id: string; nom: string; membres: number } | null>(null);
  const [onglet, setOnglet] = useState<Onglet>('sante');
  /** La révision lue par l'onglet Santé, qui ne charge pas la vue d'ensemble. */
  const [revisionSante, setRevisionSante] = useState<string | null>(null);

  useEffect(() => {
    // Relue ici et pas au rendu : le stockage du navigateur n'existe pas côté serveur. `getSessionOps` efface au
    // passage l'ancien jeton partagé, qui n'ouvre plus rien.
    setSession(getSessionOps());
    setOnglet(ongletDe(new URLSearchParams(window.location.search).get('tab')));
    setPret(true);
  }, []);

  function choisirOnglet(cle: string): void {
    const suivant = ongletDe(cle);
    setOnglet(suivant);
    window.history.replaceState(null, '', suivant === 'sante' ? '/ops' : `/ops?tab=${suivant}`);
  }

  /** La session d'exploitation est tombée (expirée, adresse retirée de la liste, facteur retiré) : on la quitte. */
  const perdue = useCallback(() => {
    clearSessionOps();
    setSession(null);
    setData(null);
    setError(t('Session d’exploitation expirée ou retirée : reconnectez-vous.', 'Operations session expired or revoked: sign in again.'));
  }, [t]);

  const load = useCallback(async (jeton: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await getOpsOverview(jeton));
    } catch (e) {
      setData(null);
      if (e instanceof ApiError && e.status === 401) {
        perdue();
        return;
      }
      setError(e instanceof Error ? e.message : t('Erreur', 'Error'));
    } finally {
      setLoading(false);
    }
  }, [t, perdue]);

  // La vue d'ensemble est lourde (charge et latence des files, lues dans la table des jobs de pg-boss) : l'onglet Santé,
  // celui du téléphone et de l'incident, n'en a pas besoin. Elle se relit en arrivant sur un autre onglet.
  const besoinVue = onglet !== 'sante';
  useEffect(() => {
    if (session && besoinVue) void load(session.token);
  }, [session, besoinVue, load]);

  /**
   * Ouvre une session d'OBSERVATION dans l'espace d'un client, puis y bascule.
   *
   * On écrit la session de la console AVEC la marque d'observation : l'AppShell la lit pour afficher un
   * bandeau permanent. Sans lui, on oublierait qu'on regarde chez quelqu'un d'autre, et on prendrait ses
   * chiffres pour les siens.
   *
   * ⚠️ La session d'ESPACE en cours est ÉCRASÉE. C'est assumé : on entre chez un client, on n'ouvre pas deux
   * mondes côte à côte. La session d'exploitation, elle, vit à part et reste ouverte.
   */
  async function observer(tenantId: string, nom: string): Promise<void> {
    if (!session) return;
    if (!(await confirmer({ titre: t('Observer l’espace', 'Observe the workspace'), message: t(
      `Observer l’espace « ${nom} » ? Vous verrez ce que ce client voit, sans pouvoir rien modifier. Votre session actuelle sera remplacée.`,
      `Observe the "${nom}" workspace? You will see what this customer sees, without being able to change anything. Your current session will be replaced.`,
    ), confirmer: t('Observer', 'Observe') }))) return;
    try {
      const r = await observerTenant(session.token, tenantId);
      saveSession({ token: r.token, email: `observation:${nom}`, role: 'admin', tenantId: r.tenantId, observation: nom });
      window.location.href = '/inbox';
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        perdue();
        return;
      }
      setError(e instanceof Error ? e.message : t('Observation impossible', 'Observation failed'));
    }
  }

  function quitter() {
    clearSessionOps();
    setSession(null);
    setData(null);
    setError(null);
  }

  if (!pret) return null;
  if (!session) {
    return (
      <ConnexionOps
        message={error}
        onSession={(s) => {
          saveSessionOps(s);
          setError(null);
          setSession(s);
        }}
      />
    );
  }

  const totalMessages = data?.tenants.reduce((a, tn) => a + tn.messages, 0) ?? 0;
  const totalContacts = data?.tenants.reduce((a, tn) => a + tn.contacts, 0) ?? 0;
  const dailyFrom = data?.daily[0]?.date;
  const dailyTo = data?.daily[data.daily.length - 1]?.date;

  return (
    <main className="min-h-screen bg-surface-subtle px-4 py-8 sm:px-6">
      <div className="mx-auto w-full max-w-liste space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <TitrePage>{t("Console d’exploitation", 'Operations console')}</TitrePage>
            {(data?.revision ?? revisionSante) && (
              <p className="-mt-2 text-xs text-ink-500" data-testid="ops-revision">
                {t('API en production : révision', 'API in production: revision')} <span className="font-mono text-ink-900">{data?.revision ?? revisionSante}</span>
              </p>
            )}
            <p className="text-sm text-ink-500">
              {t('Vue cross-tenant, au nom de', 'Cross-tenant view, as')} <span className="font-medium text-ink-900" data-testid="ops-exploitant">{session.email}</span>
            </p>
          </div>
          <Bouton variante="secondaire" onClick={quitter}>{t('Quitter', 'Exit')}</Bouton>
        </div>

        {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
        <MbaTabs
          tabs={[
            { key: 'sante', label: t('Santé', 'Health') },
            { key: 'capacite', label: t('Capacité', 'Capacity') },
            { key: 'clients', label: t('Clients', 'Clients') },
            { key: 'reglages', label: t('Réglages', 'Settings') },
          ]}
          active={onglet}
          onSelect={choisirOnglet}
        />
        {/* Santé et Capacité lisent leurs propres routes : elles n'attendent pas la vue d'ensemble. */}
        {onglet === 'sante' && <OpsSante jeton={session.token} onPerdue={perdue} onRevision={setRevisionSante} />}
        {onglet === 'capacite' && <OpsCapacite jeton={session.token} onPerdue={perdue} />}
        {loading && !data ? (
          <Squelette forme="carte" />
        ) : data ? (
          <>
            {onglet === 'capacite' && (
              <>
                <WorkerCard workers={data.workers ?? (data.worker ? [data.worker] : [])} />
                <QueueCard queues={data.queues} />
                <LatenceCard lignes={data.latences ?? []} />
                <LatenceHttpCard lignes={data.latencesHttp ?? []} />
                <TachesFondCard taches={data.tachesFond ?? []} />
                <PoolCard instantane={data.poolInstantane ?? null} points={data.attentesPool ?? []} />
                <EquiteCard groupes={data.queuesParGroupe ?? []} />
                <StockageCard jeton={session.token} />
                <VercelCard jeton={session.token} />
              </>
            )}

            {onglet === 'clients' && (
              <>
                <div className="grid grid-cols-3 gap-4">
                  <Stat label={t('Clients', 'Clients')} value={fmtNum(data.tenants.length, locale)} />
                  <Stat label={t('Messages', 'Messages')} value={fmtNum(totalMessages, locale)} />
                  <Stat label={t('Contacts', 'Contacts')} value={fmtNum(totalContacts, locale)} />
                </div>

                {dailyFrom && dailyTo && data.daily.length > 0 && (
                  <DailyChart
                    title={t('Messages échangés (tous clients)', 'Messages exchanged (all clients)')}
                    subtitle={t('par jour, 14 derniers jours', 'per day, last 14 days')}
                    from={dailyFrom}
                    to={dailyTo}
                    series={[{ label: t('Messages', 'Messages'), color: brand[400], points: data.daily }]}
                  />
                )}

                <TenantTable
                  onObserver={(id, nom) => { void observer(id, nom); }}
                  onSupprimer={(id, nom) => setASupprimer({ id, nom })}
                  onQuotas={(id, nom) => setQuotasDe({ id, nom })}
                  onOffre={(id, nom, membres) => setOffreDe({ id, nom, membres })}
                  tenants={data.tenants}
                />
              </>
            )}

            {onglet === 'reglages' && (
              <>
                <OpsSeuils token={session.token} />
                <GrillePrixCard token={session.token} />
                <NumerosFournisCard token={session.token} />
                <OpsEmailsCard token={session.token} />
              </>
            )}
          </>
        ) : null}
        {quotasDe && <QuotasApi jeton={session.token} tenantId={quotasDe.id} nom={quotasDe.nom} onFermer={() => setQuotasDe(null)} />}
        {offreDe && <OffreEspace jeton={session.token} tenantId={offreDe.id} nom={offreDe.nom} membres={offreDe.membres} onFermer={() => setOffreDe(null)} />}
        {aSupprimer && (
          <SuppressionEspace
            jeton={session.token}
            tenantId={aSupprimer.id}
            nom={aSupprimer.nom}
            onPerdue={perdue}
            onFermer={(supprime) => {
              setASupprimer(null);
              if (supprime) void load(session.token);
            }}
          />
        )}
      </div>
    </main>
  );
}


/**
 * LA CONNEXION D'EXPLOITATION : le compte habituel, puis TOUJOURS le second facteur (le code, ou l'enrôlement
 * pour une adresse de la liste qui n'en a pas encore). Les mêmes étapes que la connexion de la console
 * (`EtapesSecondFacteur`), mais la suite est une session d'exploitation, jamais une session d'espace.
 */
function ConnexionOps({ message, onSession }: { message: string | null; onSession: (s: SessionOps) => void }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [etape, setEtape] = useState<EtapeSecondFacteur | null>(null);
  const [error, setError] = useState<string | null>(message);
  const [loading, setLoading] = useState(false);

  /**
   * ⚠️ La console part chez Vercel au `git push`, l'API à son `up` : entre les deux, une API d'avant ignore
   * `ops: true` et rend une connexion d'ESPACE. On le dit au lieu d'afficher une étape qui ne mène nulle part.
   */
  const apiPasAJour = t('Cette API ne connaît pas encore la connexion d’exploitation : réessayez après son déploiement.', 'This API does not support the operations sign-in yet: try again after it is deployed.');
  const suiteEtape = (res: EtapeSecondFacteur): void => {
    if (estEtapeSecondFacteur(res)) setEtape(res);
    else setError(apiPasAJour);
  };

  async function entrer(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      suiteEtape(await loginOps(email.trim(), password));
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Connexion impossible', 'Unable to sign in'));
    } finally {
      setLoading(false);
    }
  }

  function parGoogle(idToken: string): void {
    setError(null);
    loginOpsGoogle(idToken)
      .then(suiteEtape)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('Connexion Google impossible', 'Google sign-in failed')));
  }

  function fin(s: SessionOpsOuverte): void {
    if (typeof s.sessionOps !== 'string' || s.sessionOps === '') {
      setEtape(null);
      setError(apiPasAJour);
      return;
    }
    onSession({ token: s.sessionOps, email: s.email });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-subtle p-4">
      <div className="w-full max-w-sm space-y-4">
        <div>
          <TitrePage>{t("Console d’exploitation", 'Operations console')}</TitrePage>
          <p className="mt-1 text-sm text-ink-500">
            {t(
              'Réservée aux adresses de l’exploitation : votre compte habituel, puis votre code d’authentification.',
              'Reserved for operations addresses: your usual account, then your authentication code.',
            )}
          </p>
        </div>
        {etape ? (
          <EtapesSecondFacteur<SessionOpsOuverte>
            etape={etape}
            onSuite={fin}
            introEnrolement={t('Obligatoire pour l’exploitation : scannez ce code avec votre application d’authentification.', 'Required for operations: scan this code with your authenticator app.')}
            onRetour={(m) => { setEtape(null); setError(m); }}
            abandon={{ libelle: t('Revenir à la connexion', 'Back to sign in'), action: () => { setEtape(null); setError(null); } }}
          />
        ) : (
          <form onSubmit={entrer} className="space-y-4 rounded-carte border border-ink-200 bg-white p-6" data-testid="ops-connexion">
            <div>
              <label htmlFor="ops-email" className="mb-1 block text-sm font-medium text-ink-900">Email</label>
              <input id="ops-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="ops-password" className="mb-1 block text-sm font-medium text-ink-900">{t('Mot de passe', 'Password')}</label>
              <input id="ops-password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} />
            </div>
            {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="ops-connexion-erreur">{error}</p>}
            <Bouton enCours={loading} type="submit" disabled={loading} className="w-full">
              {loading ? t('Connexion…', 'Signing in…') : t('Se connecter', 'Sign in')}
            </Bouton>
            <GoogleButton onError={setError} surJeton={parGoogle} />
          </form>
        )}
      </div>
    </main>
  );
}

/**
 * LA GRILLE DE PRIX, UNE POUR TOUS LES ESPACES (lot 8 du 2026-09-23, migration 0168).
 *
 * 🔴 ELLE EST ICI ET PLUS DANS LES PARAMETRES DU CLIENT, et c'est tout le sujet du lot : un client n'a pas
 * a fixer, ni meme a voir, ce qu'on lui facture. Seconde ecriture metier de cette surface, apres le
 * rechargement d'un solde, et elle s'y trouve pour la meme raison exactement.
 *
 * ⚠️ ELLE SE MASQUE QUAND LA ROUTE N'EXISTE PAS ENCORE, ET C'EST INDISPENSABLE ICI. La console part chez
 * Vercel a chaque `git push`, l'API attend son `up` : entre les deux, `GET /ops/prix` rend 404 ou 503. Un
 * formulaire de zeros ferait croire que tout est gratuit, et une erreur rouge ferait croire a une panne
 * alors qu'il ne manque qu'un deploiement. On ne montre rien, et on le DIT en une ligne.
 *
 * 🔴 PAS D'ENREGISTREMENT OPTIMISTE : ce sont des PRIX, et une valeur peut etre refusee par les bornes du
 * serveur. Afficher « enregistre » avant sa reponse laisserait repartir en croyant la marge posee.
 */
function GrillePrixCard({ token }: { token: string }) {
  const t = useT();
  const [champs, setChamps] = useState<Record<string, string> | null>(null);
  const [absente, setAbsente] = useState(false);
  const [note, setNote] = useState('');
  const [statut, setStatut] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [champFautif, setChampFautif] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    lireGrillePrixOps(token)
      .then((r) => { if (vivant) setChamps(enChamps(r.prix)); })
      // Silencieux et masque : une API plus ancienne que cette console n'a pas la route.
      .catch(() => { if (vivant) setAbsente(true); });
    return () => { vivant = false; };
  }, [token]);

  const onChamp = (champ: string, valeur: string) => {
    setChamps((p) => (p === null ? p : { ...p, [champ]: valeur }));
    setStatut('idle');
    setChampFautif(null);
  };

  function enregistrer() {
    if (champs === null) return;
    setStatut('saving');
    setMsg(null);
    ecrireGrillePrixOps(token, depuisChamps(champs) as GrillePrix, note)
      .then((r) => { setChamps(enChamps(r.prix)); setStatut('saved'); setChampFautif(null); setNote(''); })
      .catch((err: unknown) => {
        // Le serveur NOMME le champ fautif : le montrer vaut mieux qu'un « erreur » qui oblige a chercher
        // lequel des six ne va pas.
        const texte = err instanceof Error ? err.message : '';
        setChampFautif(/champ invalide : (\w+)/.exec(texte)?.[1] ?? null);
        setMsg(texte || null);
        setStatut('error');
      });
  }

  if (absente) {
    return (
      <div className="rounded-carte border border-ink-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-ink-900">{t('Grille de prix', 'Pricing grid')}</h2>
        <p className="mt-1 text-xs text-ink-500">
          {t('Indisponible sur cette instance : l’API n’a pas encore la route.', 'Unavailable on this instance: the API does not have the route yet.')}
        </p>
      </div>
    );
  }
  if (champs === null) return null;

  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-prix">
      <h2 className="text-sm font-semibold text-ink-900">{t('Grille de prix', 'Pricing grid')}</h2>
      <p className="mt-1 text-xs text-ink-500">
        {t(
          'Une seule grille pour tous les espaces. Le tarif des templates vient de Meta, avec une marge ; les autres prix se saisissent.',
          'A single grid for every workspace. Template rates come from Meta, with a margin; the other prices are entered.',
        )}
      </p>

      <GrillePrixChamps valeurs={champs} onChange={onChamp} champFautif={champFautif} />

      {/* La NOTE est obligatoire cote serveur : elle dit POURQUOI ; QUI, le serveur le lit dans la session
          d'exploitation. Le dire ici evite un 400 incomprehensible. */}
      <div className="mt-4">
        <label htmlFor="prix-note" className="block text-xs font-medium text-ink-900">
          {t('Pourquoi ce changement ?', 'Why this change?')}
        </label>
        <input
          id="prix-note" value={note} onChange={(e) => setNote(e.target.value)} data-testid="ops-prix-note"
          placeholder={t('qui décide, et pourquoi', 'who decides, and why')}
          className="mt-1 w-full rounded-controle border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <p className="mt-1 text-xs text-ink-500">
          {t('Obligatoire : elle dit pourquoi, et votre adresse est enregistrée avec.', 'Required: it says why, and your address is recorded with it.')}
        </p>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Bouton
          type="button" onClick={enregistrer} disabled={statut === 'saving'} data-testid="ops-prix-enregistrer"
        >
          {statut === 'saving' ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
        </Bouton>
        {statut === 'saved' && <span className="text-xs text-succes-700" data-testid="ops-prix-ok">{t('Enregistré', 'Saved')}</span>}
        {statut === 'error' && (
          <span className="text-xs text-danger-700" data-testid="ops-prix-erreur">
            {champFautif
              ? t('Valeur refusée, corrigez le champ en rouge.', 'Value rejected, fix the field in red.')
              : msg ?? t('Enregistrement impossible.', 'Could not save.')}
          </span>
        )}
      </div>

      {/* ⚠️ CE QUE CES PRIX NE FONT PAS, dit plutot que laisse deviner. */}
      <p className="mt-3 text-xs text-ink-500">
        {t(
          'Ces prix chiffrent ce que les clients voient dans Performance Lab. Ils n’émettent aucune facture et ne changent rien chez Meta.',
          'These prices cost what clients see in Performance Lab. They issue no invoice and change nothing at Meta.',
        )}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-4">
      <div className="text-xs font-medium text-ink-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-ink-900">{value}</div>
    </div>
  );
}

/** Au-delà de ce délai sans battement, le worker est présumé mort (interval côté serveur = 20 s ; ~4 battements
 *  manqués). En dessous, un simple hoquet réseau/DB ne doit pas afficher une fausse panne. */
const WORKER_STALE_S = 90;

/** Signal de vie des workers (item 4.9), UN PAR RÔLE depuis le 2026-10-03. Le worker est le SEUL process qui
 *  envoie les messages : un crash-loop passait inaperçu (mba-api répond 200). Vert = battement récent ; rouge =
 *  silencieux = à investiguer. 🔴 Une ligne PAR RÔLE : avec deux workers, une ligne unique laissait le survivant
 *  rafraîchir la ligne du mort, donc sa mort était invisible d'ici. */
function WorkerCard({ workers }: { workers: WorkerHeartbeat[] }) {
  const t = useT();
  const { locale } = useLocale();
  const age = (s: number) => (s < 60 ? t(`il y a ${s} s`, `${s} s ago`) : t(`il y a ${Math.floor(s / 60)} min`, `${Math.floor(s / 60)} min ago`));
  const fmtDate = (iso: string) => formatDate(iso, locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5">
      <h3 className="mb-3 text-sm font-semibold text-ink-900">{t('Workers (envoi des messages)', 'Workers (message sending)')}</h3>
      {workers.length === 0 ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ink[300] }} />
            <span className="text-sm font-medium text-ink-900">{t('Aucun signal', 'No signal')}</span>
          </span>
          <span className="text-xs text-ink-500">{t('Aucun worker n’a jamais signalé de vie (jamais démarré, ou table absente).', 'No worker has ever reported liveness (never started, or table missing).')}</span>
        </div>
      ) : (
        <ul className="space-y-2">
          {workers.map((w) => {
            const alive = w.ageSeconds <= WORKER_STALE_S;
            const nom = w.role ?? 'worker';
            return (
              <li key={nom} className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: alive ? succes[400] : danger[500] }} />
                  <span className="font-mono text-sm font-medium text-ink-900">{nom}</span>
                  <span className="text-xs text-ink-500">{alive ? t('Actif', 'Alive') : t('Silencieux', 'Silent')}</span>
                </span>
                <span className="text-xs text-ink-500">{t('Dernier battement', 'Last heartbeat')} : <span className="tabular-nums text-ink-900">{age(w.ageSeconds)}</span></span>
                {w.bootedAt && <span className="text-xs text-ink-500">{t('Démarré', 'Booted')} : <span className="text-ink-900">{fmtDate(w.bootedAt)}</span></span>}
                {w.instance && <span className="font-mono text-xs text-ink-500">{w.instance}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * ÉQUITÉ : qui attend le plus, groupe par groupe (SLO 3 de `docs/SLO-2026-09-01.md`).
 *
 * 🔴 Cette carte n'apparaît QUE quand quelqu'un attend, et c'est tout son intérêt : la profondeur et l'âge
 * globaux disent « la file avance », pas « tout le monde est servi ». Un espace affamé derrière un espace
 * bavard est parfaitement invisible d'une moyenne, et l'équité est la promesse la plus facile à trahir sans
 * s'en apercevoir.
 *
 * ⚠️ Ce que « groupe » désigne dépend de la file : l'ESPACE pour `campaign-run`, le CONTACT pour `webhook`.
 * L'écran le dit, sinon on lirait un identifiant de contact comme un identifiant de client.
 */
function EquiteCard({ groupes }: { groupes: QueueGroupLoadRow[] }) {
  const t = useT();
  const { locale } = useLocale();
  if (groupes.length === 0) return null;
  const SEUIL_S = 300; // 5 min : le seuil du SLO 3, au-delà duquel un client se demande si ça marche pour lui.
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-equite">
      <h3 className="text-sm font-semibold text-ink-900">{t('Qui attend le plus', 'Who is waiting longest')}</h3>
      <p className="mb-3 text-xs text-ink-500">
        {t(
          'Groupe = l’espace client pour les campagnes, le contact pour les entrants. Au-delà de 5 min, l’objectif d’équité est dépassé.',
          'Group = the workspace for campaigns, the contact for inbound. Beyond 5 min, the fairness objective is breached.',
        )}
      </p>
      <div className="space-y-1.5">
        {groupes.map((g) => (
          <div key={`${g.queue}:${g.groupe}`} className="flex items-center justify-between rounded-controle bg-ink-50 px-3 py-2 text-xs">
            <span className="flex min-w-0 gap-2">
              <span className="font-mono text-ink-900">{g.queue}</span>
              <span className="truncate font-mono text-ink-500" title={g.groupe}>{g.groupe}</span>
            </span>
            <span className="flex shrink-0 gap-3 tabular-nums">
              <span className="text-ink-500">{fmtNum(g.backlog, locale)} {t('en file', 'queued')}</span>
              <span className={g.ageMaxSecondes >= SEUIL_S ? 'font-medium text-danger' : 'text-ink-500'}>
                {g.ageMaxSecondes >= 60 ? `${Math.round(g.ageMaxSecondes / 60)} min` : `${g.ageMaxSecondes} s`}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * L'ATTENTE DU POOL DE CONNEXIONS (lot 7 du plan post-audit, 2026-09-02).
 *
 * 🔴 Le bon indicateur n'est PAS « à combien du plafond on est », c'est « quelqu'un a-t-il attendu, et combien
 * de temps ». Quinze connexions sur seize sans une seule attente, tout va bien ; des attentes à huit sur seize,
 * c'est autre chose qui cloche. D'où deux blocs qui ne se remplacent pas : l'état INSTANTANÉ de l'API (le seul
 * pool qu'elle voie en mémoire), et la COURBE par minute lue en base, qui est le seul canal par lequel le
 * WORKER peut se montrer.
 *
 * ⚠️ Une jauge lue à l'ouverture de l'écran afficherait zéro presque toujours et raterait le pic. La courbe,
 * elle, stocke le MAXIMUM de mesures exactes et non un échantillon : aucun pic n'est perdu. Ce qu'on ne saura
 * pas, c'est la seconde exacte du pic, et ça n'a pas de valeur pour un phénomène qui se joue sur des minutes.
 */
const SEUIL_ATTENTE_MS = 50;

function PoolCard({ instantane, points }: { instantane: PoolInstantane | null; points: PoolAttentePoint[] }) {
  const t = useT();
  const { locale } = useLocale();
  if (!instantane && points.length === 0) return null;

  // Une barre par minute et par process : c'est le pic de la minute qui compte, jamais la moyenne.
  const parProcess = new Map<string, PoolAttentePoint[]>();
  for (const p of points) {
    const liste = parProcess.get(p.process) ?? [];
    liste.push(p);
    parProcess.set(p.process, liste);
  }
  const maxCourbe = Math.max(1, ...points.map((p) => p.maxMs));

  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-pool">
      <h3 className="text-sm font-semibold text-ink-900">{t('Pool de connexions', 'Connection pool')}</h3>
      <p className="mb-3 text-xs text-ink-500">
        {t(
          'Ce qui compte : quelqu’un a-t-il attendu une connexion, et combien de temps. Chaque acquisition est mesurée.',
          'What matters: did anyone wait for a connection, and for how long. Every acquisition is measured.',
        )}
      </p>

      {instantane && (
        <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-controle bg-ink-50 px-3 py-2 text-xs tabular-nums">
          <span className="font-mono text-ink-900">{instantane.process}</span>
          <span className="text-ink-500">{fmtNum(instantane.total, locale)}/{fmtNum(instantane.max, locale)} {t('connexions', 'connections')}</span>
          <span className="text-ink-500">{fmtNum(instantane.libres, locale)} {t('libres', 'idle')}</span>
          {/* Le seul chiffre qui alarme : une requête en attente, c'est le pool saturé À CET INSTANT. */}
          <span className={instantane.enAttente > 0 ? 'font-medium text-danger' : 'text-ink-500'}>
            {fmtNum(instantane.enAttente, locale)} {t('en attente', 'waiting')}
          </span>
          <span className="text-ink-500">{t('pic depuis le démarrage', 'peak since start')} : {fmtNum(instantane.maxMsDepuisDemarrage, locale)} ms</span>
        </div>
      )}

      {points.length === 0 ? (
        <p className="text-xs text-ink-500">
          {t('Aucune minute enregistrée pour l’instant.', 'No minute recorded yet.')}
        </p>
      ) : (
        [...parProcess.entries()].map(([processus, liste]) => (
          <div key={processus} className="mt-3">
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="font-mono text-ink-500">{processus}</span>
              <span className="text-ink-500">
                {t('acquisition max par minute, rouge = attente sur pool saturé', 'max acquisition per minute, red = wait on a saturated pool')} · {fmtNum(liste.reduce((n, p) => n + p.attentes, 0), locale)} {t('attente(s) sur pool saturé', 'wait(s) on a saturated pool')}
              </span>
            </div>
            <div className="flex h-16 items-end gap-px overflow-x-auto">
              {liste.map((p) => (
                <span
                  key={p.minute}
                  title={`${p.minute} · ${p.maxMs} ms au total, dont ${p.maxAttenteMs} ms sur pool saturé · ${p.echantillons} acquisitions`}
                  /* 🔴 La couleur suit l'attente SATURÉE, jamais le maximum global. Avant le 2026-09-02 elle
                     suivait `maxMs`, qui inclut l'ouverture normale d'une connexion neuve : une barre rouge
                     pouvait donc s'afficher avec ZÉRO attente. Un indicateur qui crie au loup se fait ignorer
                     le jour où il a raison. Relevé par l'audit externe. */
                  className={`w-1 shrink-0 rounded-t-controle ${p.maxAttenteMs >= SEUIL_ATTENTE_MS ? 'bg-danger' : 'bg-ink-300'}`}
                  style={{ height: `${Math.max(2, Math.round((p.maxMs / maxCourbe) * 100))}%` }}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** Charge des files pg-boss : signal de bascule VPS -> Railway (backlog qui monte = saturation). */
function QueueCard({ queues }: { queues: QueueLoadRow[] }) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5">
      <h3 className="mb-3 text-sm font-semibold text-ink-900">{t('Files de traitement (pg-boss)', 'Processing queues (pg-boss)')}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {queues.map((q) => (
          <div key={q.queue} className="flex items-center justify-between rounded-controle bg-ink-50 px-3 py-2">
            <span className="font-mono text-xs text-ink-900">{q.queue}</span>
            <span className="flex gap-3 text-xs tabular-nums">
              <span title={t('en attente', 'pending')} className="text-ink-500">{fmtNum(q.backlog, locale)} {t('en file', 'queued')}</span>
              <span title={t('actifs', 'active')} className="text-brand-600">{fmtNum(q.active, locale)} {t('actifs', 'active')}</span>
              <span title={t('échoués', 'failed')} className={q.failed > 0 ? 'font-medium text-danger' : 'text-ink-500'}>{fmtNum(q.failed, locale)} {t('échoués', 'failed')}</span>
              {/* 🔴 L'AGE du plus vieux job prêt, et pas seulement leur nombre : mille jobs avalés en trois
                  secondes vont bien, dix qui attendent depuis un quart d'heure vont mal. C'est ce chiffre
                  que les objectifs de service regardent (docs/SLO-2026-09-01.md). Le seuil d'alerte est
                  celui de la file la plus exigeante, l'entrant : au-delà d'une minute, un client attend. */}
              {q.ageMaxSecondes !== undefined && q.ageMaxSecondes > 0 && (
                <span
                  data-testid={`file-age-${q.queue}`}
                  title={t('âge du plus vieux job prêt', 'age of the oldest ready job')}
                  className={q.ageMaxSecondes >= 60 ? 'font-medium text-danger' : 'text-ink-500'}
                >
                  {q.ageMaxSecondes >= 60 ? `${Math.round(q.ageMaxSecondes / 60)} min` : `${q.ageMaxSecondes} s`} {t('d’attente', 'waiting')}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * LA LATENCE REELLE, sur 24 h, calculee sur les jobs TERMINES (constat A4 de l'audit externe du 2026-09-02).
 *
 * 🔴 Pourquoi elle est SEPAREE de la carte des files : ce ne sont pas deux vues du meme chiffre. La carte du
 * dessus est une PHOTO (« qui attend en ce moment »), celle-ci est un HISTORIQUE (« a quoi ressemblaient les
 * dernieres 24 h »). Le document de SLO confondait les deux et en tirait un p95 que la photo ne pouvait pas
 * donner. Les mettre l'une sous l'autre, avec leurs noms, est ce qui empeche de refaire l'amalgame.
 *
 * Vide = aucun job termine sur la fenetre, ce qui est l'etat normal d'une installation au repos. On le DIT,
 * plutot que d'afficher des zeros qui se liraient « tout va vite ».
 */
function LatenceCard({ lignes }: { lignes: QueueLatenceRow[] }) {
  const t = useT();
  const { locale } = useLocale();
  const utiles = lignes.filter((l) => l.echantillons > 0).sort((a, b) => b.attenteP95Secondes - a.attenteP95Secondes);
  /**
   * 🔴 LE SEUIL DU SLO 1, ET IL S'APPLIQUE AUX DEUX MESURES (contre-audit du 2026-09-03).
   *
   * Il n'était posé que sur l'ATTENTE. Or le SLO promet qu'un message entrant est TRAITÉ en moins de trente
   * secondes, c'est-à-dire l'attente PLUS le traitement : une file prise en une seconde et traitée en
   * quarante-cinq restait donc verte alors que l'objectif était violé. Le cas n'a rien de théorique, la file
   * `agent-turn` est un appel modèle, sa durée vit presque entièrement dans le traitement, et cette couleur
   * est la SEULE alarme du produit sur la latence.
   *
   * Chaque chiffre garde son propre seuil plutôt qu'un seuil commun : les deux ne se corrigent pas au même
   * endroit (une attente longue est un problème de capacité, un traitement long un problème de dépendance).
   *
   * Le seuil est celui de la FILE (`seuilSecondes`, dérivé de sa cadence par le serveur) : 30 s pour une file qu'un
   * contact attend, trois cadences pour une file de fond, qui sinon passait au rouge en marchant comme prévu. 30 s
   * quand une API plus ancienne ne l'envoie pas.
   */
  const SEUIL_DEFAUT_S = 30;
  const seuilDe = (l: QueueLatenceRow): number => l.seuilSecondes ?? SEUIL_DEFAUT_S;
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-ink-900">{t('Latence réelle des files (24 h)', 'Actual queue latency (24 h)')}</h3>
      <p className="mb-3 mt-1 text-xs text-ink-500">
        {t(
          'Sur les jobs terminés : les jobs échoués n’y figurent pas, ils se lisent sur la carte ci-dessus.',
          'Over completed jobs: failed jobs are absent here, read them on the card above.',
        )}
      </p>
      {utiles.length === 0 ? (
        <p className="text-xs text-ink-500">{t('Aucun job terminé sur la fenêtre.', 'No job completed in this window.')}</p>
      ) : (
        <div className="grid gap-2">
          {utiles.map((l) => (
            <div key={l.queue} className="flex items-center justify-between rounded-controle bg-ink-50 px-3 py-2">
              <span className="font-mono text-xs text-ink-900">{l.queue}</span>
              <span className="flex gap-3 text-xs tabular-nums">
                {/* L'effectif EN PREMIER : un p95 sur trois jobs ne veut rien dire. */}
                <span className="text-ink-500" title={t('jobs terminés sur la fenêtre', 'jobs completed in window')}>
                  {fmtNum(l.echantillons, locale)} {t('jobs', 'jobs')}
                </span>
                <span className="text-ink-500" title={t('attente médiane avant prise', 'median wait before pickup')}>
                  p50 {fmtSecondes(l.attenteP50Secondes)}
                </span>
                <span
                  data-testid={`latence-p95-${l.queue}`}
                  className={l.attenteP95Secondes >= seuilDe(l) ? 'font-medium text-danger' : 'text-ink-500'}
                  title={t('attente au 95e centile', '95th percentile wait')}
                >
                  p95 {fmtSecondes(l.attenteP95Secondes)}
                </span>
                <span
                  data-testid={`latence-bout-en-bout-${l.queue}`}
                  className={l.boutEnBoutP95Secondes >= seuilDe(l) ? 'font-medium text-danger' : 'text-ink-500'}
                  title={t('bout en bout au 95e centile (attente + traitement)', 'end-to-end 95th percentile')}
                >
                  {t('bout en bout', 'end to end')} {fmtSecondes(l.boutEnBoutP95Secondes)}
                </span>
                {/*
                  Le PIRE cas, déjà calculé et déjà transporté jusqu'ici, et affiché nulle part jusqu'à
                  aujourd'hui. Il tient lieu de p99 : sur les effectifs réels du produit (quelques dizaines de
                  jobs par file et par jour) un p99 vaudrait le maximum, donc le calculer serait du travail
                  pour le même chiffre, et le maximum majore le p99 dans tous les cas.
                */}
                <span
                  data-testid={`latence-max-${l.queue}`}
                  className={l.boutEnBoutMaxSecondes >= 120 ? 'font-medium text-danger' : 'text-ink-500'}
                  title={t('pire cas bout en bout sur la fenêtre', 'worst end-to-end case in window')}
                >
                  {t('pire', 'worst')} {fmtSecondes(l.boutEnBoutMaxSecondes)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * La latence HTTP par route normalisée et code de retour (audit de performance du 2026-10-02, § 11). Les webhooks,
 * l'Inbox et l'API publique d'abord, comme l'audit le demande. Ce qui passe en rouge, et l'ordre : `lib/latence-http`.
 */
function LatenceHttpCard({ lignes }: { lignes: LatenceHttpRow[] }) {
  const t = useT();
  const { locale } = useLocale();
  const noms: Record<LatenceHttpRow['groupe'], string> = {
    webhooks: t('Webhooks entrants', 'Inbound webhooks'),
    inbox: t('Inbox', 'Inbox'),
    v1: t('API publique (/v1)', 'Public API (/v1)'),
    autres: t('Autres routes', 'Other routes'),
  };
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="latence-http">
      <h3 className="text-sm font-semibold text-ink-900">{t('Latence HTTP par route (24 h)', 'HTTP latency by route (24 h)')}</h3>
      <p className="mb-3 mt-1 text-xs text-ink-500">
        {t(
          `Toutes copies de l’API confondues. p50 et p95 sont des majorants (« au plus »), tirés de tranches de durée. Rouge : p95 au-delà de ${SEUIL_P95_MS} ms sur un webhook ou une lecture de l’Inbox, à partir de ${EFFECTIF_MIN} requêtes. ${CODE_ABANDON} : requête abandonnée par le client avant sa réponse.`,
          `All API copies combined. p50 and p95 are upper bounds (“at most”), derived from duration buckets. Red: p95 above ${SEUIL_P95_MS} ms on a webhook or an Inbox read, from ${EFFECTIF_MIN} requests. ${CODE_ABANDON}: request abandoned by the client before its response.`,
        )}
      </p>
      {lignes.length === 0 ? (
        <p className="text-xs text-ink-500">{t('Aucune requête mesurée sur la fenêtre.', 'No request measured in this window.')}</p>
      ) : (
        <div className="grid gap-4">
          {ordonnerLatences(lignes).map((g) => (
            <div key={g.cle} className="grid gap-2">
              <p className="text-xs font-medium text-ink-900">
                {noms[g.cle]} <span className="font-normal text-ink-500">· {fmtNum(g.requetes, locale)} {t('requêtes', 'requests')}</span>
                {g.erreurs > 0 && <span className="font-normal text-danger"> · {fmtNum(g.erreurs, locale)} {t('en 5xx', 'in 5xx')}</span>}
                {g.abandons > 0 && <span className="font-normal text-danger"> · {fmtNum(g.abandons, locale)} {t('abandonnée(s)', 'abandoned')}</span>}
              </p>
              {g.lignes.map((l) => (
                <div key={`${l.methode} ${l.code} ${l.route}`} className="flex items-center justify-between gap-3 rounded-controle bg-ink-50 px-3 py-2">
                  <span className="min-w-0 break-all font-mono text-xs text-ink-900">
                    {l.methode} {l.route}{' '}
                    <span className={l.code >= CODE_ABANDON ? 'font-medium text-danger' : 'text-ink-500'}>{l.code}</span>
                  </span>
                  <span className="flex shrink-0 gap-3 text-xs tabular-nums">
                    {/* L'effectif EN PREMIER : un p95 sur trois requêtes ne veut rien dire. */}
                    <span className="text-ink-500">{fmtNum(l.requetes, locale)} {t('req.', 'req.')}</span>
                    <span className="text-ink-500">p50 ≤ {fmtMs(l.p50Ms)}</span>
                    <span
                      data-testid={`latence-http-p95-${l.methode}-${l.code}-${l.route}`}
                      className={enAlerte(l) ? 'font-medium text-danger' : 'text-ink-500'}
                    >
                      p95 ≤ {fmtMs(l.p95Ms)}
                    </span>
                    <span className="text-ink-500">{t('pire', 'worst')} {fmtMs(l.maxMs)}</span>
                  </span>
                </div>
              ))}
              {g.cachees > 0 && (
                <p className="text-xs text-ink-500">
                  {t(`et ${g.cachees} autre(s) ligne(s), plus rapides ou à faible effectif`, `and ${g.cachees} more line(s), faster or with few requests`)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * LES TÂCHES DE FOND DES WORKERS (migration 0207, audit de performance du 2026-10-02, § 11). Toutes les tâches sont
 * mesurées par le registre commun, la plus lente en tête. Rouge : une passe au-delà du seuil de l'audit, ou un échec.
 * Les lignes n'existent que pour les tâches qui les comptent (statistiques d'analyse, risque, purges).
 */
function TachesFondCard({ taches }: { taches: TacheFondRow[] }) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="taches-fond">
      <h3 className="text-sm font-semibold text-ink-900">{t('Tâches de fond (24 h)', 'Background tasks (24 h)')}</h3>
      <p className="mb-3 mt-1 text-xs text-ink-500">
        {t(
          `Chaque passe de chaque tâche des workers, la plus lente en tête. Rouge : une passe au-delà de ${fmtMs(SEUIL_TACHE_LENTE_MS)}, une passe en échec, ou un tour sauté parce que la passe précédente tournait encore.`,
          `Every pass of every worker task, slowest first. Red: a pass over ${fmtMs(SEUIL_TACHE_LENTE_MS)}, a failed pass, or a run skipped because the previous one was still going.`,
        )}
      </p>
      {taches.length === 0 ? (
        <p className="text-xs text-ink-500">{t('Aucune passe mesurée sur la fenêtre.', 'No pass measured in this window.')}</p>
      ) : (
        <div className="grid gap-1.5">
          {taches.map((tf) => (
            <div key={`${tf.process} ${tf.tache}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-controle bg-ink-50 px-3 py-2">
              <span className="min-w-0 break-all font-mono text-xs text-ink-900">
                {tf.tache} <span className="text-ink-500">{tf.process.replace(/^worker-?/, '') || 'worker'}</span>
              </span>
              <span className="flex shrink-0 flex-wrap gap-3 text-xs tabular-nums">
                <span className="text-ink-500">{fmtNum(tf.passes, locale)} {t('passe(s)', 'pass(es)')}</span>
                {tf.echecs > 0 && <span className="font-medium text-danger">{fmtNum(tf.echecs, locale)} {t('échec(s)', 'failed')}</span>}
                {tf.sautees > 0 && <span className="font-medium text-danger">{fmtNum(tf.sautees, locale)} {t('tour(s) sauté(s)', 'skipped run(s)')}</span>}
                <span className="text-ink-500">{t('moy.', 'avg')} {fmtMs(tf.passes > 0 ? tf.sommeMs / tf.passes : 0)}</span>
                <span data-testid={`tache-max-${tf.process}-${tf.tache}`} className={tacheEnAlerte(tf) ? 'font-medium text-danger' : 'text-ink-500'}>
                  {t('pire', 'worst')} {fmtMs(tf.maxMs)}
                </span>
                {tf.lignes !== null && (
                  <span className="text-ink-500">
                    {fmtNum(tf.lignes, locale)} {t('ligne(s)', 'row(s)')}{tf.maxLignes !== null ? ` · ${t('max', 'max')} ${fmtNum(tf.maxLignes, locale)}` : ''}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * LE BUDGET D'ÉQUIPE VERCEL (lot 14). À 100 %, chaque bot de chaque client se tait : la carte dit où on en est, aux
 * couleurs des alertes Telegram du worker. Lue chez Vercel une fois, à l'ouverture de l'écran. Une API qui ne porte pas
 * encore la route (la console est publiée avant l'API) ou une lecture en échec ne fait tomber que cette carte.
 */
function VercelCard({ jeton }: { jeton: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [jauge, setJauge] = useState<JaugeVercel | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => {
    let vivant = true;
    getOpsVercel(jeton)
      .then((j) => {
        if (!vivant) return;
        if (typeof j?.configure === 'boolean') setJauge(j);
        else setErreur(t('Jauge indisponible sur cette version de l’API.', 'Gauge unavailable on this API version.'));
      })
      .catch((e: unknown) => {
        if (!vivant) return;
        const detail = e instanceof Error ? e.message : '';
        setErreur(`${t('Jauge indisponible', 'Gauge unavailable')}${detail ? ` : ${detail}` : ''}`);
      });
    return () => { vivant = false; };
  }, [jeton, t]);
  const part = jauge?.part ?? null;
  const teinte = jauge?.configure ? teinteVercel(part) : null;
  const classe = teinte === 'danger' ? 'text-danger' : teinte === 'alerte' ? 'text-alerte-700' : 'text-ink-900';
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="vercel-budget">
      <h3 className="text-sm font-semibold text-ink-900">{t('Budget d’équipe Vercel (IA)', 'Vercel team budget (AI)')}</h3>
      <p className="mb-3 mt-1 text-xs text-ink-500">
        {t(
          `À 100 %, Vercel refuse tous les appels de l’équipe et chaque bot se tait. Alerte Telegram à ${SEUIL_VERCEL_ORANGE_POURCENT} % puis à ${SEUIL_VERCEL_ROUGE_POURCENT} % ; le budget se relève chez Vercel.`,
          `At 100%, Vercel refuses every team call and every bot goes silent. Telegram alert at ${SEUIL_VERCEL_ORANGE_POURCENT}% then ${SEUIL_VERCEL_ROUGE_POURCENT}%; the budget is raised at Vercel.`,
        )}
      </p>
      {erreur ? (
        <p className="text-xs text-danger">{erreur}</p>
      ) : !jauge ? (
        <Squelette forme="lignes" lignes={2} />
      ) : !jauge.configure ? (
        <p className="text-xs text-ink-500">{t('Jeton de compte Vercel non configuré : rien à lire.', 'Vercel account token not configured: nothing to read.')}</p>
      ) : jauge.limiteDollars === null || jauge.limiteDollars === undefined || part === null ? (
        <p className="text-xs text-danger">
          {t('Aucun budget d’équipe chez Vercel : rien ne borne la dépense', 'No team budget at Vercel: nothing caps spend')}
          {' '}({fmtDollars(jauge.depenseRetenueDollars ?? 0, locale)} {t('ce mois', 'this month')}).
        </p>
      ) : (
        <div className="grid gap-1.5 text-xs">
          <p className="text-ink-900">
            <span data-testid="vercel-part" className={`font-medium tabular-nums ${classe}`}>{Math.round(part * 100)} %</span>
            {' · '}
            <span className="tabular-nums">{fmtDollars(jauge.depenseRetenueDollars ?? 0, locale)}</span>
            {' '}{t('sur', 'of')}{' '}
            <span className="tabular-nums">{fmtDollars(jauge.limiteDollars, locale)}</span>
            {' '}{t('ce mois', 'this month')}
          </p>
          <p className="text-ink-500">
            {/* Les deux chiffres : le compteur de l'équipe a été mesuré en retard sur les clés (2026-10-12). */}
            {t('Compteur de l’équipe', 'Team counter')} <span className="tabular-nums">{fmtDollars(jauge.depenseEquipeDollars ?? 0, locale)}</span>
            {' · '}{t('clés mensuelles', 'monthly keys')} <span className="tabular-nums">{fmtDollars(jauge.depenseClesMensuellesDollars ?? 0, locale)}</span>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * LES OCTETS EN BASE (audit de performance du 2026-10-02, § 9). Lus une fois à l'ouverture de l'écran, pas avec la
 * vue d'ensemble : la mesure parcourt le catalogue. Rouge : les fichiers en base dépassent le seuil, il est temps de
 * les sortir vers un stockage objet.
 */
function StockageCard({ jeton }: { jeton: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [mesure, setMesure] = useState<MesureStockage | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => {
    let vivant = true;
    getOpsStockage(jeton)
      // Une réponse sans la bonne forme ne doit pas faire tomber tout l'écran d'exploitation : la carte le dit.
      .then((m) => {
        if (!vivant) return;
        if (Array.isArray(m?.familles) && Array.isArray(m?.tables)) setMesure(m);
        else setErreur(t('Mesure indisponible sur cette version de l’API.', 'Measure unavailable on this API version.'));
      })
      .catch((e: unknown) => { if (vivant) setErreur(e instanceof Error ? e.message : t('Mesure impossible', 'Measure failed')); });
    return () => { vivant = false; };
  }, [jeton, t]);
  const noms: Record<MesureStockage['familles'][number]['famille'], string> = {
    rcs: t('Images RCS', 'RCS images'),
    pubs: t('Visuels des brouillons de pub', 'Ad draft visuals'),
    flows: t('Flows (JSON, images comprises)', 'Flows (JSON, images included)'),
  };
  const fichiers = mesure ? fichiersEnBase(mesure) : 0;
  const auDela = fichiers >= SEUIL_FICHIERS_EN_BASE_OCTETS;
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="stockage-base">
      <h3 className="text-sm font-semibold text-ink-900">{t('Stockage en base', 'Database storage')}</h3>
      <p className="mb-3 mt-1 text-xs text-ink-500">
        {t(
          `Les fichiers gardés dans Postgres grossissent la base et ses sauvegardes. Rouge au-delà de ${fmtOctets(SEUIL_FICHIERS_EN_BASE_OCTETS, locale)} de fichiers : il est temps de les sortir vers un stockage objet.`,
          `Files kept in Postgres grow the database and its backups. Red above ${fmtOctets(SEUIL_FICHIERS_EN_BASE_OCTETS, locale)} of files: time to move them to object storage.`,
        )}
      </p>
      {erreur ? (
        <p className="text-xs text-danger">{erreur}</p>
      ) : !mesure ? (
        <Squelette forme="lignes" lignes={3} />
      ) : (
        <div className="grid gap-3">
          <p className="text-xs text-ink-900">
            {t('Base entière', 'Whole database')} <span className="font-medium tabular-nums">{fmtOctets(mesure.baseOctets, locale)}</span>
            {' · '}{t('dont fichiers', 'of which files')}{' '}
            <span data-testid="stockage-fichiers" className={auDela ? 'font-medium text-danger tabular-nums' : 'font-medium tabular-nums'}>{fmtOctets(fichiers, locale)}</span>
          </p>
          <div className="grid gap-1.5">
            {mesure.familles.map((fa) => (
              <div key={fa.famille} className="flex items-center justify-between gap-3 rounded-controle bg-ink-50 px-3 py-2 text-xs">
                <span className="text-ink-900">{noms[fa.famille]}</span>
                <span className="tabular-nums text-ink-500">
                  {fmtNum(fa.elements, locale)} · {fmtOctets(fa.octets, locale)}{' '}
                  {/* Les Flows sont comptés compressés (`pg_column_size`), les images en taille brute : deux unités. */}
                  {fa.famille === 'flows' ? t('stockés', 'stored') : t('utiles', 'payload')} · {fmtOctets(fa.disqueOctets, locale)} {t('sur disque', 'on disk')}
                </span>
              </div>
            ))}
          </div>
          <div className="grid gap-1">
            <p className="text-xs font-medium text-ink-900">{t('Les plus grosses tables', 'Largest tables')}</p>
            {mesure.tables.map((ta) => (
              <div key={ta.table} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 break-all font-mono text-ink-900">{ta.table}</span>
                <span className="shrink-0 tabular-nums text-ink-500">{fmtOctets(ta.octets, locale)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * LA RÉSERVE DES NUMÉROS FOURNIS (lot 3a, spec `docs/superpowers/specs/2026-10-05-pont-du-code-design.md`). Julien
 * achète un numéro chez DIDWW, puis le déclare ici : le serveur le branche sur le trunk de l'Asterisk et l'inscrit
 * libre. La carte montre aussi le dernier appel capté par numéro, le seul endroit où lire le code tant que la page
 * « Connecter WhatsApp » n'existe pas.
 *
 * ⚠️ Elle tolère une API qui n'a pas encore la route (déployée après la console, ou l'inverse) : la carte le dit, et
 * le reste de l'écran d'exploitation reste debout.
 */
function NumerosFournisCard({ token }: { token: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [reserve, setReserve] = useState<ReserveNumerosOps | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [numero, setNumero] = useState('');
  const [note, setNote] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [retour, setRetour] = useState<{ ok: boolean; texte: string } | null>(null);
  // Le numéro qu'on sort de la réserve (son identifiant), et la note qui le justifie.
  const [sortie, setSortie] = useState<string | null>(null);
  const [noteSortie, setNoteSortie] = useState('');

  const charger = useCallback(() => {
    lireNumerosFournis(token)
      .then((r) => {
        if (Array.isArray(r?.numeros)) { setReserve(r); setErreur(null); } else setErreur(t('Réserve illisible sur cette version de l’API.', 'Reserve unreadable on this API version.'));
      })
      .catch((e: unknown) => {
        setErreur(e instanceof ApiError && e.status === 404
          ? t('La réserve n’existe pas encore sur cette version de l’API.', 'The reserve does not exist yet on this API version.')
          : e instanceof Error ? e.message : t('Lecture impossible', 'Read failed'));
      });
  }, [token, t]);
  useEffect(() => { charger(); }, [charger]);

  async function declarer() {
    if (envoi) return;
    setEnvoi(true);
    setRetour(null);
    try {
      const r = await declarerNumeroFourni(token, numero, note);
      setRetour({ ok: true, texte: r.cree ? t('Numéro branché et ajouté à la réserve.', 'Number connected and added to the reserve.') : t('Ce numéro était déjà dans la réserve.', 'This number was already in the reserve.') });
      setNumero('');
      setNote('');
      charger();
    } catch (e: unknown) {
      setRetour({ ok: false, texte: e instanceof Error ? e.message : t('Déclaration impossible', 'Declaration failed') });
    } finally {
      setEnvoi(false);
    }
  }

  async function sortir(id: string) {
    if (envoi) return;
    setEnvoi(true);
    setRetour(null);
    try {
      const r = await sortirNumeroDeLaReserve(token, id, noteSortie);
      setRetour({ ok: true, texte: t(`+${r.numero} est sorti de la réserve : il ne sera jamais attribué.`, `+${r.numero} is out of the reserve: it will never be assigned.`) });
      setSortie(null);
      setNoteSortie('');
      charger();
    } catch (e: unknown) {
      setRetour({ ok: false, texte: e instanceof ApiError && e.status === 404
        ? t('La sortie de la réserve n’existe pas encore sur cette version de l’API.', 'Taking a number out of the reserve does not exist yet on this API version.')
        : e instanceof Error ? e.message : t('Sortie impossible', 'Could not take it out') });
    } finally {
      setEnvoi(false);
    }
  }

  const statuts: Record<ReserveNumerosOps['numeros'][number]['statut'], string> = {
    libre: t('libre', 'free'), attribue: t('attribué', 'assigned'), resilie: t('résilié', 'terminated'),
    // Sorti de la réserve sans être résilié chez DIDWW : refusé par Meta à l'attribution, sorti à la main d'ici
    // (2026-10-28), ou vu de Meta et pas résilié à la libération. Un abonnement DIDWW court encore : à décider.
    bloque: t('hors réserve (à résilier ou à garder)', 'out of the reserve (cancel or keep)'),
  };
  const ailleurs: Record<'application' | 'api', string> = {
    application: t('utilisé par une application WhatsApp Business : jamais attribué', 'used by a WhatsApp Business app: never assigned'),
    api: t('numéro API d’un espace : jamais attribué', 'API number of a workspace: never assigned'),
  };
  const causes: Record<'transcription_indisponible' | 'code_introuvable', string> = {
    transcription_indisponible: t('transcription indisponible', 'transcription unavailable'),
    code_introuvable: t('aucun code certain', 'no certain code'),
  };

  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="numeros-fournis">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink-900">{t('Numéros fournis', 'Provided numbers')}</h3>
        <Bouton variante="secondaire" taille="petite" onClick={charger}>{t('Rafraîchir', 'Refresh')}</Bouton>
      </div>
      <p className="mb-3 mt-1 text-xs text-ink-500">
        {t(
          'Un numéro acheté chez DIDWW se déclare ici : le serveur le branche sur l’Asterisk et l’ajoute à la réserve. Le dernier code dicté par Meta s’affiche en face de chaque numéro.',
          'A number bought from DIDWW is declared here: the server connects it to the Asterisk and adds it to the reserve. The last code dictated by Meta shows next to each number.',
        )}
      </p>
      {erreur ? (
        <p className="text-xs text-danger">{erreur}</p>
      ) : !reserve ? (
        <Squelette forme="lignes" lignes={3} />
      ) : (
        <div className="grid gap-3">
          <p className="text-xs text-ink-900">
            {t('Numéros libres', 'Free numbers')} <span className="font-medium tabular-nums" data-testid="numeros-libres">{fmtNum(reserve.libres, locale)}</span>
            {!reserve.configure && <span className="text-danger">{' · '}{t('DIDWW n’est pas configuré sur ce serveur', 'DIDWW is not configured on this server')}</span>}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <input className={inputCls} value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="+44 20 7123 4567" aria-label={t('Numéro', 'Number')} />
            <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Note : d’où vient ce numéro', 'Note: where this number comes from')} aria-label={t('Note', 'Note')} />
            <Bouton enCours={envoi} disabled={envoi || numero.trim() === '' || note.trim() === ''} onClick={() => { void declarer(); }}>
              {t('Déclarer', 'Declare')}
            </Bouton>
          </div>
          {retour && <p className={retour.ok ? 'text-xs text-succes-700' : 'text-xs text-danger'}>{retour.texte}</p>}
          <div className="grid gap-1.5">
            {reserve.numeros.length === 0 && <p className="text-xs text-ink-500">{t('Aucun numéro dans la réserve.', 'No number in the reserve.')}</p>}
            {reserve.numeros.map((n) => (
              <div key={n.id} className="grid gap-1 rounded-controle bg-ink-50 px-3 py-2 text-xs" data-testid={`numero-fourni-${n.numero}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-ink-900">+{n.numero}</span>
                  <span className="flex flex-wrap items-center gap-2 text-ink-500">
                    {statuts[n.statut]}{n.tenantId ? ` · ${n.tenantId}` : ''}
                    {n.statut === 'libre' && sortie !== n.id && (
                      <Bouton variante="secondaire" taille="petite" data-testid="sortir-de-la-reserve" onClick={() => { setSortie(n.id); setNoteSortie(''); setRetour(null); }}>
                        {t('Sortir de la réserve', 'Take out of the reserve')}
                      </Bouton>
                    )}
                  </span>
                </div>
                {n.statut === 'libre' && n.ailleurs && (
                  <div className="text-danger" data-testid="numero-ailleurs">{ailleurs[n.ailleurs]}</div>
                )}
                {sortie === n.id && (
                  <div className="flex flex-wrap items-end gap-2">
                    <input className={inputCls} value={noteSortie} onChange={(e) => setNoteSortie(e.target.value)} placeholder={t('Note : pourquoi il sort de la réserve', 'Note: why it leaves the reserve')} aria-label={t('Note de sortie', 'Exit note')} />
                    <Bouton enCours={envoi} disabled={envoi || noteSortie.trim().length < 3} data-testid="confirmer-sortie" onClick={() => { void sortir(n.id); }}>
                      {t('Confirmer la sortie', 'Confirm')}
                    </Bouton>
                    <Bouton variante="secondaire" taille="petite" onClick={() => setSortie(null)}>{t('Annuler', 'Cancel')}</Bouton>
                  </div>
                )}
                {n.dernierCode && (
                  <div className="text-ink-500">
                    {formatDate(n.dernierCode.recuLe, locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}{' · '}
                    {n.dernierCode.code
                      ? <span className="font-mono font-medium text-ink-900" data-testid="dernier-code">{n.dernierCode.code}</span>
                      : <span className="text-danger">{n.dernierCode.cause ? causes[n.dernierCode.cause] : ''}</span>}
                    {n.dernierCode.transcription && <span className="block break-words">« {n.dernierCode.transcription} »</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * SUPPRIMER UN ESPACE, DÉFINITIVEMENT (RC8, `src/ops/suppression-espace.ts`). Le bilan d'abord (ce qui part, ce que
 * Stripe facture encore, les adresses effacées et gardées, les étapes sautées), la saisie exacte du nom, puis le
 * déroulé tel que le serveur l'a joué. 🔴 C'est le SERVEUR qui revérifie le nom et décide de chaque étape : l'écran
 * ne fait que présenter, et n'affiche rien comme fait avant sa réponse.
 */
function SuppressionEspace({ jeton, tenantId, nom, onFermer, onPerdue }: {
  jeton: string;
  tenantId: string;
  nom: string;
  onFermer: (supprime: boolean) => void;
  onPerdue: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [lu, setLu] = useState<{ bilan: BilanSuppressionOps; etapes: EtapePrevueOps[] } | null>(null);
  const [saisie, setSaisie] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [resultat, setResultat] = useState<SuppressionEspaceOps | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    lireSuppressionOps(jeton, tenantId)
      .then((r) => { if (vivant) setLu(r); })
      .catch((e: unknown) => {
        if (!vivant) return;
        if (e instanceof ApiError && e.status === 401) onPerdue();
        else setErreur(e instanceof Error ? e.message : t('Bilan illisible', 'Unreadable summary'));
      });
    return () => { vivant = false; };
  }, [jeton, tenantId, t, onPerdue]);

  const nomOk = lu !== null && saisie.trim() !== '' && saisie.trim() === lu.bilan.nom.trim();

  async function supprimer(): Promise<void> {
    if (!nomOk || enCours) return;
    setEnCours(true);
    setErreur(null);
    try {
      setResultat(await supprimerEspaceOps(jeton, tenantId, saisie));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onPerdue();
      else setErreur(e instanceof Error ? e.message : t('Suppression impossible', 'Deletion failed'));
    } finally {
      setEnCours(false);
    }
  }

  const libelle: Record<EtapeSuppressionNom, string> = {
    verrou: t('Verrou de l’espace', 'Workspace lock'),
    cle_vercel: t('Clé Vercel', 'Vercel key'),
    mba_eteint: t('Agent de Meta éteint', 'Meta agent off'),
    mba_liste: t('Liste de l’agent de Meta', 'Meta agent list'),
    waba_desabonne: t('Compte WhatsApp désabonné', 'WhatsApp account unsubscribed'),
    salesforce: 'Salesforce',
    hubspot: 'HubSpot',
    numero_fourni: t('Numéro fourni', 'Provided number'),
    fichiers: t('Fichiers de la médiathèque', 'Media library files'),
    purge: t('Purge', 'Purge'),
  };
  const etat: Record<string, { texte: string; cls: string }> = {
    a_faire: { texte: t('à faire', 'to do'), cls: 'text-ink-900' },
    fait: { texte: t('fait', 'done'), cls: 'text-succes-700' },
    sautee: { texte: t('sautée', 'skipped'), cls: 'text-ink-500' },
    impossible: { texte: t('impossible', 'impossible'), cls: 'text-danger-700' },
    echec: { texte: t('échec', 'failed'), cls: 'text-danger-700' },
  };
  const stripe = resultat?.stripe ?? lu?.bilan.stripe ?? null;
  const etapes: Array<{ etape: EtapeSuppressionNom; etat: string; detail: string | null }> = resultat?.etapes ?? lu?.etapes ?? [];

  return (
    <Modale
      titre={t('Supprimer l’espace', 'Delete the workspace')}
      sousTitre={nom}
      testId="suppression-modale"
      fermeture={enCours ? 'boutons' : 'partout'}
      onClose={() => { if (!enCours) onFermer(resultat?.supprime === true); }}
      pied={resultat ? (
        <Bouton type="button" variante="secondaire" onClick={() => onFermer(resultat.supprime)}>{t('Fermer', 'Close')}</Bouton>
      ) : (
        <>
          <Bouton type="button" variante="secondaire" disabled={enCours} onClick={() => onFermer(false)}>{t('Annuler', 'Cancel')}</Bouton>
          <Bouton type="button" data-testid="suppression-confirmer" disabled={!nomOk || enCours} enCours={enCours} onClick={() => { void supprimer(); }}>
            {enCours ? t('Suppression…', 'Deleting…') : t('Supprimer définitivement', 'Delete permanently')}
          </Bouton>
        </>
      )}
    >
      <div className="space-y-4 text-sm">
        {erreur && <p className="rounded-controle bg-danger-50 px-3 py-2 text-danger-700" data-testid="suppression-erreur">{erreur}</p>}
        {!lu && !erreur && <Squelette forme="carte" />}

        {resultat && (
          <p className={`rounded-controle px-3 py-2 font-medium ${resultat.supprime ? 'bg-succes-50 text-succes-700' : 'bg-danger-50 text-danger-700'}`} data-testid="suppression-issue">
            {resultat.supprime ? t('Espace supprimé.', 'Workspace deleted.') : t('Espace NON supprimé : voir les étapes.', 'Workspace NOT deleted: see the steps.')}
          </p>
        )}

        {stripe && (stripe.abonnements.length > 0 || stripe.clients.length > 0) && (
          <div className="rounded-controle border border-alerte-300 bg-alerte-50 px-3 py-2" data-testid="suppression-stripe">
            <p className="font-medium text-alerte-900">
              {stripe.abonnements.some((a) => a.vivant) ? t('Stripe : à résilier à la main', 'Stripe: cancel by hand') : 'Stripe'}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {stripe.abonnements.map((a) => (
                <li key={a.id}>
                  {a.produit === 'numero' ? t('Abonnement du numéro', 'Number subscription') : t('Abonnement Pro', 'Pro subscription')}
                  {' '}({a.statut}{a.livemode ? '' : ', test'}) :{' '}
                  <a href={a.lien} target="_blank" rel="noreferrer" className="font-mono text-brand-600 underline">{a.id}</a>
                </li>
              ))}
              {stripe.clients.map((c) => (
                <li key={c.customerId}>
                  {t('Client', 'Customer')}{c.livemode ? '' : ' (test)'} :{' '}
                  <a href={c.lien} target="_blank" rel="noreferrer" className="font-mono text-brand-600 underline">{c.customerId}</a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {lu && !resultat && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs" data-testid="suppression-bilan">
            <dt className="text-ink-500">{t('Créé le', 'Created on')}</dt>
            <dd className="text-ink-900">{formatDate(lu.bilan.creeLe, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })}</dd>
            <dt className="text-ink-500">{t('Utilisateurs, contacts', 'Users, contacts')}</dt>
            <dd className="text-ink-900">{fmtNum(lu.bilan.comptes.utilisateurs, locale)}, {fmtNum(lu.bilan.comptes.contacts, locale)}</dd>
            <dt className="text-ink-500">{t('Conversations, scénarios', 'Conversations, scenarios')}</dt>
            <dd className="text-ink-900">{fmtNum(lu.bilan.comptes.conversations, locale)}, {fmtNum(lu.bilan.comptes.scenarios, locale)}</dd>
            <dt className="text-ink-500">{t('Crédit restant', 'Remaining credit')}</dt>
            <dd className="text-ink-900">{fmtCost(eurosDepuisMicro(lu.bilan.soldeMicroEur), locale, 'EUR')}</dd>
            <dt className="text-ink-500">{t('Adresses effacées', 'Addresses erased')}</dt>
            <dd className="break-all text-ink-900">{lu.bilan.adresses.effacees.join(', ') || <Nd />}</dd>
            <dt className="text-ink-500">{t('Adresses gardées', 'Addresses kept')}</dt>
            <dd className="break-all text-ink-900">{lu.bilan.adresses.gardees.join(', ') || <Nd />}</dd>
          </dl>
        )}

        {etapes.length > 0 && (
          <ol className="space-y-1 text-xs" data-testid={resultat ? 'suppression-deroule' : 'suppression-etapes'}>
            {etapes.map((e) => (
              <li key={e.etape} data-testid={`etape-${e.etape}`}>
                <span className="text-ink-900">{libelle[e.etape]}</span>
                {' : '}
                <span className={`font-medium ${etat[e.etat]?.cls ?? 'text-ink-900'}`}>{etat[e.etat]?.texte ?? e.etat}</span>
                {e.detail && <span className="text-ink-500"> ({e.detail})</span>}
              </li>
            ))}
          </ol>
        )}

        {lu && !resultat && (
          <div>
            <label htmlFor="suppression-nom" className="mb-1 block text-xs font-medium text-ink-900">
              {t('Tapez le nom de l’espace', 'Type the workspace name')}
            </label>
            <input
              id="suppression-nom"
              data-testid="suppression-nom"
              value={saisie}
              onChange={(e) => setSaisie(e.target.value)}
              disabled={enCours}
              autoComplete="off"
              className={inputCls}
            />
          </div>
        )}
      </div>
    </Modale>
  );
}

/** Millisecondes lisibles : « 320 ms », « 1,2 s ». */
function fmtMs(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return fmtSecondes(ms / 1000);
}

/** Secondes lisibles : un « 505,652 s » ne se lit pas, un « 8 min » se lit. */
function fmtSecondes(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
}

/**
 * LE PLAFOND ET LES QUOTAS DE L'API D'UN ESPACE, avec ce qu'il a consommé aujourd'hui (`GET /ops/plafond-api/:tenantId`).
 * En lecture : le réglage s'écrit par `PUT` sur la même route, avec une note, tracé dans le journal d'audit de l'espace.
 * Une consommation `null` est un compteur muet : « inconnue », jamais zéro.
 */
function QuotasApi({ jeton, tenantId, nom, onFermer }: { jeton: string; tenantId: string; nom: string; onFermer: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [etat, setEtat] = useState<PlafondApiOps | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => {
    lirePlafondApiOps(jeton, tenantId)
      .then(setEtat)
      .catch((e: unknown) => setErreur(e instanceof Error ? e.message : t('Lecture impossible', 'Read failed')));
  }, [jeton, tenantId, t]);
  const plafond = (f: FenetrePlafondOps) => (f.effectif === null
    ? t('aucun', 'none')
    : `${fmtNum(f.effectif, locale)}${f.reglage === null ? t(' (défaut)', ' (default)') : ''}`);
  const conso = (n: number | undefined) => (n === undefined ? <Nd /> : fmtNum(n, locale));
  // Un quota désactivé (`effectif` à `null`) ne laisse aucune ligne au compteur : son « 0 » serait faux.
  const compte = (f: FenetrePlafondOps, n: number | undefined) => (f.effectif === null
    ? <Nd titre={t('Quota désactivé : rien n’est compté', 'Quota disabled: nothing is counted')} />
    : conso(n));
  // Les modèles et les réponses ont chacun leur quota (spec offres v2) ; une API d'avant ne rend que les envois.
  const envois = etat ? [
    { cle: 'modeles', nom: t('Modèles du jour', 'Templates today'), f: etat.modelesJour, n: etat.aujourdhui?.modeles },
    { cle: 'reponses', nom: t('Réponses du jour', 'Replies today'), f: etat.reponsesJour, n: etat.aujourdhui?.reponses },
    { cle: 'envois', nom: t('Envois du jour', 'Sends today'), f: etat.envoisJour, n: etat.aujourdhui?.envois },
  ].flatMap((l) => (l.f ? [{ cle: l.cle, nom: l.nom, conso: compte(l.f, l.n), f: l.f }] : [])) : [];
  const lignes = etat ? [
    ...envois,
    { cle: 'fiches', nom: t('Fiches du jour', 'Contacts today'), conso: compte(etat.fichesJour, etat.aujourdhui?.fiches), f: etat.fichesJour },
    { cle: 'minute', nom: t('Appels par minute', 'Calls per minute'), conso: null, f: etat.minute },
    { cle: 'heure', nom: t('Appels par heure', 'Calls per hour'), conso: null, f: etat.heure },
  ] : [];
  return (
    <Modale titre={t('Quotas de l’API', 'API quotas')} sousTitre={nom} testId="quotas-api-modale" onClose={onFermer}>
      {erreur ? (
        <p className="text-xs text-danger">{erreur}</p>
      ) : !etat ? (
        <Squelette forme="lignes" lignes={4} />
      ) : (
        <div className="grid gap-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
                <th className="py-2 font-medium">{t('Fenêtre', 'Window')}</th>
                <th className="py-2 text-right font-medium">{t('Consommé', 'Used')}</th>
                <th className="py-2 text-right font-medium">{t('Plafond', 'Limit')}</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => (
                <tr key={l.cle} className="border-b border-ink-50 last:border-0" data-testid={`quota-${l.cle}`}>
                  <td className="py-2 text-ink-900">{l.nom}</td>
                  <td className="py-2 text-right tabular-nums text-ink-900">{l.conso}</td>
                  <td className="py-2 text-right tabular-nums text-ink-500">{plafond(l.f)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-ink-500">
            {etat.aujourdhui
              ? `${t('Remise à zéro', 'Reset')} ${formatDate(etat.aujourdhui.remiseAZero, locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
              : etat.aujourdhui === null
                ? t('Le compteur n’a pas répondu : consommation inconnue.', 'The counter did not answer: usage unknown.')
                : t('Cette version de l’API ne rend pas encore la consommation.', 'This API version does not return usage yet.')}
          </p>
        </div>
      )}
    </Modale>
  );
}

/**
 * L'OFFRE ENTREPRISE D'UN ESPACE, POSÉE PAR L'EXPLOITATION (demande de Julien du 2026-10-13 ; route du lot 6,
 * `src/http/ops-offre.ts`). L'Entreprise est sur devis : elle se pose ici après signature, avec sa limite
 * d'utilisateurs, et se retire de même pour ramener l'espace en Base. La note est obligatoire (au moins trois
 * caractères, `MIN_NOTE` du serveur), et la trace porte l'adresse de l'exploitant.
 *
 * 🔴 LA CONSERVATION N'EST ENVOYÉE QUE SI ON COCHE « La changer » : absente, la route la laisse telle quelle, parce
 * qu'une valeur plus basse lance la purge irréversible des conversations plus anciennes. Un raccourcissement l'annonce
 * en rouge avant l'enregistrement.
 */
function OffreEspace({ jeton, tenantId, nom, membres, onFermer }: { jeton: string; tenantId: string; nom: string; membres: number; onFermer: () => void }) {
  const t = useT();
  const [etat, setEtat] = useState<OffreEntrepriseOps | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [entreprise, setEntreprise] = useState(false);
  const [sansLimite, setSansLimite] = useState(false);
  const [utilisateurs, setUtilisateurs] = useState('');
  const [changerConservation, setChangerConservation] = useState(false);
  const [conservation, setConservation] = useState('');
  // Spec offres v2 : les contacts et la commission du devis ne partent que si on coche « Régler », comme la conservation.
  const [changerDevis, setChangerDevis] = useState(false);
  const [contacts, setContacts] = useState('');
  const [commission, setCommission] = useState('');
  // Le Business (spec Business) : une seule offre posée à la main, exclusive de l'Entreprise.
  const [business, setBusiness] = useState(false);
  const [utilisateursBusiness, setUtilisateursBusiness] = useState('');
  const [retraitConfirme, setRetraitConfirme] = useState(false);
  const [note, setNote] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const remplir = (r: OffreEntrepriseOps): void => {
    setEtat(r);
    setEntreprise(r.entreprise);
    setSansLimite(r.entreprise && r.utilisateurs === null);
    setUtilisateurs(String(r.utilisateurs ?? r.utilisateursProposes));
    setChangerConservation(false);
    setConservation(r.conservationJours === null ? '' : String(r.conservationJours));
    setChangerDevis(false);
    setContacts(r.contacts == null ? '' : String(r.contacts));
    setCommission(r.commissionPct == null ? '' : String(r.commissionPct));
    setBusiness(r.business === true);
    setUtilisateursBusiness(r.utilisateursBusiness == null ? '' : String(r.utilisateursBusiness));
    setRetraitConfirme(false);
  };

  useEffect(() => {
    let vivant = true;
    lireOffreOps(jeton, tenantId)
      .then((r) => { if (vivant) remplir(r); })
      .catch((e: unknown) => { if (vivant) setErreur(e instanceof Error ? e.message : t('Lecture impossible', 'Read failed')); });
    return () => { vivant = false; };
  }, [jeton, tenantId, t]);

  const limite = sansLimite ? null : (/^[0-9]+$/.test(utilisateurs.trim()) ? Number(utilisateurs.trim()) : NaN);
  const limiteValide = !entreprise || limite === null || (Number.isInteger(limite) && limite >= 1 && limite <= 10_000);
  const nouvelleConservation = changerConservation ? lireConservation(conservation) : undefined;
  const conservationValide = nouvelleConservation !== 'invalide';
  const purge = etat !== null && nouvelleConservation !== undefined && nouvelleConservation !== 'invalide'
    && conservationPeutPurger(etat.conservationJours, nouvelleConservation);
  const devis = entreprise && changerDevis;
  const nouveauxContacts = devis ? lireContactsEntreprise(contacts) : undefined;
  const nouvelleCommission = devis ? lireCommissionEntreprise(commission) : undefined;
  const devisValide = nouveauxContacts !== 'invalide' && nouvelleCommission !== 'invalide';
  const noteValide = note.trim().length >= 3;
  const nouveauxUtilisateursBusiness = business ? lireUtilisateursBusiness(utilisateursBusiness) : undefined;
  const businessValide = nouveauxUtilisateursBusiness !== 'invalide';
  // 🔴 Retirer une offre posée à la main lance la fin d'un numéro fourni que plus rien ne couvre : l'écran le fait confirmer.
  const coupeLeNumero = etat !== null && retraitCoupeLeNumero(
    { entreprise: etat.entreprise, business: etat.business === true }, { entreprise, business },
    etat.alertes?.numeroFourniSansCouverture === true,
  );
  const pret = etat !== null && limiteValide && conservationValide && devisValide && businessValide && noteValide
    && (!coupeLeNumero || retraitConfirme) && !envoi;

  async function enregistrer() {
    if (!pret) return;
    setEnvoi(true);
    setMsg(null);
    try {
      const r = await ecrireOffreOps(jeton, tenantId, {
        entreprise,
        // Hors Entreprise, la limite ne veut rien dire : elle repart à « sans limite ».
        utilisateurs: entreprise ? limite : null,
        ...(nouvelleConservation !== undefined ? { conservationJours: nouvelleConservation } : {}),
        // `pret` a déjà écarté une saisie invalide (le compilateur le sait).
        ...(nouveauxContacts !== undefined ? { contacts: nouveauxContacts } : {}),
        ...(nouvelleCommission !== undefined ? { commissionPct: nouvelleCommission } : {}),
        // Le Business ne part que s'il change, sa limite que s'il est coché (absents = inchangés côté serveur).
        ...(business !== (etat?.business === true) ? { business } : {}),
        ...(business && nouveauxUtilisateursBusiness !== undefined ? { utilisateursBusiness: nouveauxUtilisateursBusiness } : {}),
        note: note.trim(),
      });
      remplir(r);
      setNote('');
      const offre = r.entreprise
        ? t('Espace passé en Entreprise.', 'Workspace moved to Enterprise.')
        : r.business ? t('Espace passé en Business.', 'Workspace moved to Business.')
          : t('Espace hors Entreprise : il suit son offre en ligne (Free ou Pro).', 'Workspace out of Enterprise: it follows its online plan (Free or Pro).');
      const g = r.gestes;
      const suite = [
        g?.creditOffert ? t(`${(g.creditOffert / 1_000_000).toFixed(2)} € de crédit IA offerts.`, `€${(g.creditOffert / 1_000_000).toFixed(2)} of AI credit offered.`) : '',
        g?.finDuNumero ? t(`Numéro fourni : ${g.finDuNumero}.`, `Provided number: ${g.finDuNumero}.`) : '',
        g && g.echecs.length > 0 ? t(`Gestes échoués : ${g.echecs.join(', ')} (journalisés).`, `Failed steps: ${g.echecs.join(', ')} (logged).`) : '',
      ].filter(Boolean).join(' ');
      setMsg({ kind: g && g.echecs.length > 0 ? 'err' : 'ok', text: suite ? `${offre} ${suite}` : offre });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('Enregistrement impossible', 'Unable to save') });
    } finally {
      setEnvoi(false);
    }
  }

  const conservationLue = (j: number | null): string => (j === null
    ? t('défaut de l’instance', 'instance default')
    : j === 0 ? t('jamais purgées', 'never purged') : t(`${j} jours`, `${j} days`));

  return (
    <Modale titre={t('Offre posée à la main', 'Manually set plan')} sousTitre={nom} testId="offre-modale" onClose={onFermer}
      pied={etat ? (
        <Bouton enCours={envoi} disabled={!pret} onClick={() => { void enregistrer(); }} data-testid="offre-enregistrer">
          {t('Enregistrer', 'Save')}
        </Bouton>
      ) : undefined}
    >
      {erreur ? (
        <p className="text-xs text-danger">{erreur}</p>
      ) : !etat ? (
        <Squelette forme="lignes" lignes={4} />
      ) : (
        <div className="grid gap-4 text-sm">
          <p className="text-xs text-ink-500" data-testid="offre-actuelle">
            {etat.entreprise
              ? t(`Actuellement en Entreprise, ${etat.utilisateurs === null ? 'sans limite d’utilisateurs' : `${etat.utilisateurs} utilisateurs au plus`}. Conversations : ${conservationLue(etat.conservationJours)}.`,
                `Currently on Enterprise, ${etat.utilisateurs === null ? 'no user limit' : `${etat.utilisateurs} users at most`}. Conversations: ${conservationLue(etat.conservationJours)}.`)
              : etat.business
                ? t(`Actuellement en Business, ${etat.utilisateursBusiness == null ? 'les cinq utilisateurs de la grille' : `${etat.utilisateursBusiness} utilisateurs au plus`}. Conversations : ${conservationLue(etat.conservationJours)}.`,
                  `Currently on Business, ${etat.utilisateursBusiness == null ? 'the five users of the grid' : `${etat.utilisateursBusiness} users at most`}. Conversations: ${conservationLue(etat.conservationJours)}.`)
                : t(`Actuellement hors Entreprise (offre en ligne). Conversations : ${conservationLue(etat.conservationJours)}.`,
                  `Currently not on Enterprise (online plan). Conversations: ${conservationLue(etat.conservationJours)}.`)}
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={business} onChange={(e) => { setBusiness(e.target.checked); if (e.target.checked) setEntreprise(false); }} data-testid="offre-business" className="h-4 w-4" />
            <span className="font-medium text-ink-900">{t('Offre Business', 'Business plan')}</span>
          </label>
          {business && (
            <div className="grid gap-2 pl-6">
              <label className="grid gap-1">
                <span className="text-xs font-medium text-ink-500">{t('Utilisateurs au plus (vide = les cinq de la grille)', 'Users at most (empty = the five of the grid)')}</span>
                <input className={`${inputCls} w-32`} inputMode="numeric" value={utilisateursBusiness} onChange={(e) => setUtilisateursBusiness(e.target.value)} data-testid="offre-utilisateurs-business" />
                {!businessValide && <span className="text-xs text-danger-700">{t('Un entier de 1 à 10 000, ou vide.', 'A whole number from 1 to 10,000, or empty.')}</span>}
              </label>
              {etat.business !== true && etat.alertes?.proPayeVivant && (
                <p className="rounded-controle bg-alerte-50 px-3 py-2 text-xs text-alerte" data-testid="offre-alerte-pro">
                  {t('Un Pro payé est encore vivant chez Stripe : résiliez-le dans Stripe, sinon le client paiera deux fois.', 'A paid Pro is still live at Stripe: cancel it in Stripe, or the customer pays twice.')}
                </p>
              )}
              {etat.business !== true && etat.alertes?.numeroSeulVivant && (
                <p className="rounded-controle bg-alerte-50 px-3 py-2 text-xs text-alerte" data-testid="offre-alerte-numero">
                  {t('Le numéro est payé à part : le Business l’inclut, son abonnement est arrêté au passage.', 'The number is paid separately: Business includes it, its subscription is stopped on the switch.')}
                </p>
              )}
            </div>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={entreprise} onChange={(e) => { setEntreprise(e.target.checked); if (e.target.checked) setBusiness(false); }} data-testid="offre-entreprise" className="h-4 w-4" />
            <span className="font-medium text-ink-900">{t('Offre Entreprise', 'Enterprise plan')}</span>
          </label>
          {entreprise && (
            <div className="grid gap-2 pl-6">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={sansLimite} onChange={(e) => setSansLimite(e.target.checked)} data-testid="offre-sans-limite" className="h-4 w-4" />
                <span className="text-ink-900">{t('Sans limite d’utilisateurs', 'No user limit')}</span>
              </label>
              {!sansLimite && (
                <label className="grid gap-1">
                  <span className="text-xs font-medium text-ink-500">{t('Utilisateurs au plus', 'Users at most')}</span>
                  <input className={`${inputCls} w-32`} inputMode="numeric" value={utilisateurs} onChange={(e) => setUtilisateurs(e.target.value)} data-testid="offre-utilisateurs" />
                  {!limiteValide && <span className="text-xs text-danger-700">{t('Un entier de 1 à 10 000.', 'A whole number from 1 to 10,000.')}</span>}
                </label>
              )}
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={changerDevis} onChange={(e) => setChangerDevis(e.target.checked)} data-testid="offre-changer-devis" className="h-4 w-4" />
                <span className="text-ink-900">
                  {t(`Régler les contacts et la commission du devis (actuellement : ${etat.contacts == null ? 'contacts sans limite' : `${etat.contacts} contacts`}, ${etat.commissionPct == null ? 'commission par défaut' : `${etat.commissionPct} %`})`,
                    `Set the quote’s contacts and commission (now: ${etat.contacts == null ? 'no contact limit' : `${etat.contacts} contacts`}, ${etat.commissionPct == null ? 'default commission' : `${etat.commissionPct}%`})`)}
                </span>
              </label>
              {changerDevis && (
                <div className="grid gap-2 pl-6">
                  <label className="grid gap-1">
                    <span className="text-xs font-medium text-ink-500">{t('Contacts créés au plus (vide = sans limite)', 'Created contacts at most (empty = no limit)')}</span>
                    <input className={`${inputCls} w-40`} inputMode="numeric" value={contacts} onChange={(e) => setContacts(e.target.value)} data-testid="offre-contacts" />
                    {nouveauxContacts === 'invalide' && <span className="text-xs text-danger-700">{t('Un entier de 1 à 100 000 000, ou vide.', 'A whole number from 1 to 100,000,000, or empty.')}</span>}
                  </label>
                  <label className="grid gap-1">
                    <span className="text-xs font-medium text-ink-500">{t('Commission sur le crédit IA, en % (vide = 10 %)', 'AI credit commission, in % (empty = 10%)')}</span>
                    <input className={`${inputCls} w-24`} inputMode="numeric" value={commission} onChange={(e) => setCommission(e.target.value)} data-testid="offre-commission" />
                    {nouvelleCommission === 'invalide' && <span className="text-xs text-danger-700">{t('Un entier de 0 à 100, ou vide.', 'A whole number from 0 to 100, or empty.')}</span>}
                  </label>
                </div>
              )}
            </div>
          )}
          {coupeLeNumero && (
            <label className="flex items-start gap-2 rounded-controle bg-danger-50 px-3 py-2 text-xs text-danger-700" data-testid="offre-retrait-numero">
              <input type="checkbox" checked={retraitConfirme} onChange={(e) => setRetraitConfirme(e.target.checked)} data-testid="offre-retrait-confirme" className="mt-0.5 h-4 w-4" />
              <span>{t('Le numéro fourni ne sera plus couvert : ses envois sont suspendus tout de suite, puis il est résilié 7 jours plus tard. Je confirme le retrait.', 'The provided number will no longer be covered: its sends are suspended at once, then it is cancelled 7 days later. I confirm the removal.')}</span>
            </label>
          )}
          {etat.entreprise && !entreprise && !business && (
            <p className="rounded-controle bg-danger-50 px-3 py-2 text-xs text-danger-700" data-testid="offre-retour-base">
              {t(`L’espace suivra son offre en ligne. En Base, seuls 1 utilisateur et 1 administrateur restent actifs (il en compte ${membres}) : les autres sont bloqués tout de suite. Et 30 jours après, les conversations de plus de 30 jours sont effacées, sans retour. En Pro : 3 utilisateurs, tous administrateurs, 60 jours.`,
                `The workspace will follow its online plan. On Base, only 1 user and 1 administrator stay active (it has ${membres}): the others are blocked at once. And 30 days later, conversations older than 30 days are erased, for good. On Pro: 3 users, all administrators, 60 days.`)}
            </p>
          )}
          <div className="grid gap-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={changerConservation} onChange={(e) => setChangerConservation(e.target.checked)} data-testid="offre-changer-conservation" className="h-4 w-4" />
              <span className="text-ink-900">{t('Changer la conservation des conversations', 'Change conversation retention')}</span>
            </label>
            {changerConservation && (
              <label className="grid gap-1 pl-6">
                <span className="text-xs font-medium text-ink-500">{t('Jours (0 = jamais purgées, vide = défaut de l’instance)', 'Days (0 = never purged, empty = instance default)')}</span>
                <input className={`${inputCls} w-32`} inputMode="numeric" value={conservation} onChange={(e) => setConservation(e.target.value)} data-testid="offre-conservation" />
                {!conservationValide && <span className="text-xs text-danger-700">{t('Un entier de 0 à 3 650, ou vide.', 'A whole number from 0 to 3,650, or empty.')}</span>}
              </label>
            )}
            {purge && (
              <p className="rounded-controle bg-danger-50 px-3 py-2 text-xs text-danger-700" data-testid="offre-purge">
                {t('Cette conservation peut être plus courte que l’actuelle : les conversations plus anciennes seront effacées au prochain passage de la purge. C’est irréversible.',
                  'This retention may be shorter than the current one: older conversations will be erased at the next purge run. This cannot be undone.')}
              </p>
            )}
          </div>
          <label className="grid gap-1">
            <span className="text-xs font-medium text-ink-900">{t('Note (obligatoire) : pourquoi ce changement', 'Note (required): why this change')}</span>
            <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-testid="offre-note" placeholder={t('Devis signé le…', 'Quote signed on…')} />
          </label>
          {msg && (
            <p data-testid="offre-message" className={`rounded-controle px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-succes-50 text-succes-700' : 'bg-danger-50 text-danger-700'}`}>{msg.text}</p>
          )}
        </div>
      )}
    </Modale>
  );
}

function TenantTable({ tenants, onObserver, onSupprimer, onQuotas, onOffre }: {
  tenants: TenantOverviewRow[];
  onObserver: (id: string, nom: string) => void;
  onSupprimer: (id: string, nom: string) => void;
  onQuotas: (id: string, nom: string) => void;
  onOffre: (id: string, nom: string, membres: number) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const dot = (q: string | null) => (q === 'GREEN' ? succes[400] : q === 'YELLOW' ? alerte[500] : q === 'RED' ? danger[500] : ink[300]);
  const fmtDate = (iso: string | null) => (iso ? formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' }) : <Nd />);
  return (
    <div className="overflow-x-auto rounded-carte border border-ink-200 bg-white">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
            <th className="px-4 py-3 font-medium">{t('Client', 'Client')}</th>
            <th className="px-3 py-3 font-medium">MBA</th>
            <th className="px-3 py-3 font-medium">{t('Numéro', 'Number')}</th>
            <th className="px-3 py-3 text-right font-medium">{t('Users', 'Users')}</th>
            <th className="px-3 py-3 text-right font-medium">{t('Contacts', 'Contacts')}</th>
            <th className="px-3 py-3 text-right font-medium">{t('Messages', 'Messages')}</th>
            <th className="px-3 py-3 text-right font-medium">{t('Templates', 'Templates')}</th>
            <th className="px-3 py-3 font-medium">{t('Dernier envoi', 'Last send')}</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((tn) => (
            <tr key={tn.id} className="border-b border-ink-50 last:border-0">
              <td className="px-4 py-2.5">
                <div className="font-medium text-ink-900">{tn.name}</div>
                <div className="text-xs text-ink-500">{t('créé le', 'created on')} {fmtDate(tn.createdAt)}</div>
                {/* Entrer dans l'espace pour VOIR ce que le client voit. Session en lecture seule, d'une
                    heure : elle ne peut rien modifier et ne marque rien comme lu. */}
                <button
                  onClick={() => onObserver(tn.id, tn.name)}
                  data-testid={`observe-${tn.id}`}
                  className="mt-1 text-xs font-medium text-brand-600 underline decoration-dotted hover:text-brand-700"
                >
                  {t('observer cet espace', 'observe this workspace')}
                </button>
                <button
                  onClick={() => onQuotas(tn.id, tn.name)}
                  data-testid={`quotas-${tn.id}`}
                  className="ml-3 mt-1 text-xs font-medium text-brand-600 underline decoration-dotted hover:text-brand-700"
                >
                  {t('quotas API', 'API quotas')}
                </button>
                <button
                  onClick={() => onOffre(tn.id, tn.name, tn.users)}
                  data-testid={`offre-${tn.id}`}
                  className="ml-3 mt-1 text-xs font-medium text-brand-600 underline decoration-dotted hover:text-brand-700"
                >
                  {t('offre', 'plan')}
                </button>
                {/* Ouvre le bilan : rien n'est supprimé avant la saisie du nom. */}
                <button
                  onClick={() => onSupprimer(tn.id, tn.name)}
                  data-testid={`supprimer-${tn.id}`}
                  className="ml-3 mt-1 text-xs font-medium text-danger-700 underline decoration-dotted hover:text-danger-600"
                >
                  {t('supprimer', 'delete')}
                </button>
              </td>
              <td className="px-3 py-2.5">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tn.mbaEnabled ? 'bg-succes-50 text-succes-700' : 'bg-ink-100 text-ink-500'}`}>
                  {tn.mbaEnabled ? t('actif', 'active') : t('inactif', 'inactive')}
                </span>
              </td>
              <td className="px-3 py-2.5">
                {tn.phone ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: dot(tn.quality) }} title={`${t('qualité', 'quality')} ${tn.quality ?? t('inconnue', 'unknown')}`} />
                    <span className="font-mono text-xs text-ink-900">{tn.phone}</span>
                  </span>
                ) : (
                  <Nd className="text-xs" />
                )}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-900">{fmtNum(tn.users, locale)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-900">{fmtNum(tn.contacts, locale)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-900">{fmtNum(tn.messages, locale)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-900">{fmtNum(tn.templatesUsed, locale)}</td>
              <td className="px-3 py-2.5 text-xs text-ink-500">{fmtDate(tn.lastSendAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
