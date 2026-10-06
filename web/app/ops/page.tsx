'use client';

import { useCallback, useEffect, useState } from 'react';
import { DailyChart } from '@/components/DailyChart';
import { getOpsOverview, getOpsStockage, observerTenant, lireGrillePrixOps, ecrireGrillePrixOps, loginOps, loginOpsGoogle, estEtapeSecondFacteur, type OpsOverview,
  lireNumerosFournis, declarerNumeroFourni, type ReserveNumerosOps,
  type TenantOverviewRow, type QueueLoadRow, type QueueGroupLoadRow, type QueueLatenceRow, type LatenceHttpRow, type WorkerHeartbeat, type PoolInstantane,
  type PoolAttentePoint, type GrillePrix, type EtapeSecondFacteur, type SessionOpsOuverte, type TacheFondRow, type MesureStockage } from '@/lib/api';
import { ApiError } from '@/lib/http';
import { GrillePrixChamps } from '@/components/GrillePrixChamps';
import { enChamps, depuisChamps } from '@/lib/grille-saisie';
import { formatDate } from '@/lib/day';
import { fmtNum } from '@/lib/format';
import { ordonnerLatences, enAlerte, SEUIL_P95_MS, EFFECTIF_MIN, CODE_ABANDON } from '@/lib/latence-http';
import { tacheEnAlerte, fichiersEnBase, fmtOctets, SEUIL_TACHE_LENTE_MS, SEUIL_FICHIERS_EN_BASE_OCTETS } from '@/lib/ops-mesures';
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

  useEffect(() => {
    // Relue ici et pas au rendu : le stockage du navigateur n'existe pas côté serveur. `getSessionOps` efface au
    // passage l'ancien jeton partagé, qui n'ouvre plus rien.
    setSession(getSessionOps());
    setPret(true);
  }, []);

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

  useEffect(() => {
    if (session) void load(session.token);
  }, [session, load]);

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
            <p className="text-sm text-ink-500">
              {t('Vue cross-tenant, au nom de', 'Cross-tenant view, as')} <span className="font-medium text-ink-900" data-testid="ops-exploitant">{session.email}</span>
            </p>
          </div>
          <Bouton variante="secondaire" onClick={quitter}>{t('Quitter', 'Exit')}</Bouton>
        </div>

        {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
        {loading && !data ? (
          <Squelette forme="carte" />
        ) : data ? (
          <>
            <div className="grid grid-cols-3 gap-4">
              <Stat label={t('Clients', 'Clients')} value={fmtNum(data.tenants.length, locale)} />
              <Stat label={t('Messages', 'Messages')} value={fmtNum(totalMessages, locale)} />
              <Stat label={t('Contacts', 'Contacts')} value={fmtNum(totalContacts, locale)} />
            </div>

            <WorkerCard workers={data.workers ?? (data.worker ? [data.worker] : [])} />

            <QueueCard queues={data.queues} />
            <LatenceCard lignes={data.latences ?? []} />
            <LatenceHttpCard lignes={data.latencesHttp ?? []} />
            <TachesFondCard taches={data.tachesFond ?? []} />
            <StockageCard jeton={session.token} />
            <PoolCard instantane={data.poolInstantane ?? null} points={data.attentesPool ?? []} />
            <EquiteCard groupes={data.queuesParGroupe ?? []} />

            {dailyFrom && dailyTo && data.daily.length > 0 && (
              <div className="rounded-carte border border-ink-200 bg-white p-5">
                <DailyChart
                  title={t('Messages échangés (tous clients)', 'Messages exchanged (all clients)')}
                  subtitle={t('par jour, 14 derniers jours', 'per day, last 14 days')}
                  from={dailyFrom}
                  to={dailyTo}
                  series={[{ label: t('Messages', 'Messages'), color: brand[400], points: data.daily }]}
                />
              </div>
            )}

            <GrillePrixCard token={session.token} />

            <NumerosFournisCard token={session.token} />

            <TenantTable onObserver={(id, nom) => { void observer(id, nom); }} tenants={data.tenants} />
          </>
        ) : null}
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
   */
  const SEUIL_S = 30;
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
                  className={l.attenteP95Secondes >= SEUIL_S ? 'font-medium text-danger' : 'text-ink-500'}
                  title={t('attente au 95e centile', '95th percentile wait')}
                >
                  p95 {fmtSecondes(l.attenteP95Secondes)}
                </span>
                <span
                  data-testid={`latence-bout-en-bout-${l.queue}`}
                  className={l.boutEnBoutP95Secondes >= SEUIL_S ? 'font-medium text-danger' : 'text-ink-500'}
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

  const statuts: Record<ReserveNumerosOps['numeros'][number]['statut'], string> = {
    libre: t('libre', 'free'), attribue: t('attribué', 'assigned'), resilie: t('résilié', 'terminated'),
    // Refusé par Meta (déjà actif ailleurs) : sorti de la réserve, à résilier ou à garder, à toi de voir.
    bloque: t('bloqué (refusé par Meta)', 'blocked (refused by Meta)'),
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
              <div key={n.id} className="grid gap-1 rounded-controle bg-ink-50 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-ink-900">+{n.numero}</span>
                  <span className="text-ink-500">{statuts[n.statut]}{n.tenantId ? ` · ${n.tenantId}` : ''}</span>
                </div>
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

function TenantTable({ tenants, onObserver }: { tenants: TenantOverviewRow[]; onObserver: (id: string, nom: string) => void }) {
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
