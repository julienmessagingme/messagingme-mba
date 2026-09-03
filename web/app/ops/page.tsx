'use client';

import { useCallback, useEffect, useState } from 'react';
import { DailyChart } from '@/components/DailyChart';
import { getOpsOverview, observerTenant, type OpsOverview, type TenantOverviewRow, type QueueLoadRow,
  type QueueGroupLoadRow, type QueueLatenceRow, type WorkerHeartbeat, type PoolInstantane, type PoolAttentePoint } from '@/lib/api';
import { formatDate } from '@/lib/day';
import { fmtNum } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n';
import { saveSession } from '@/lib/session';

const KEY = 'mba.ops';

export default function OpsPage() {
  const t = useT();
  const { locale } = useLocale();
  const [token, setToken] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [data, setData] = useState<OpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const tok = localStorage.getItem(KEY);
    if (tok) setToken(tok);
  }, []);

  const load = useCallback(async (tok: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await getOpsOverview(tok));
    } catch (e) {
      setData(null);
      const msg = e instanceof Error ? e.message : t('Erreur', 'Error');
      setError(msg);
      if (/401|autoris/i.test(msg)) { localStorage.removeItem(KEY); setToken(null); }
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (token) void load(token);
  }, [token, load]);

  /**
   * Ouvre une session d'OBSERVATION dans l'espace d'un client, puis y bascule.
   *
   * On écrit la session de la console AVEC la marque d'observation : l'AppShell la lit pour afficher un
   * bandeau permanent. Sans lui, on oublierait qu'on regarde chez quelqu'un d'autre, et on prendrait ses
   * chiffres pour les siens.
   *
   * ⚠️ La session en cours est ÉCRASÉE. C'est assumé : on entre chez un client, on n'ouvre pas deux mondes
   * côte à côte. Se reconnecter normalement restaure la sienne.
   */
  async function observer(tenantId: string, nom: string): Promise<void> {
    if (!token) return;
    if (!window.confirm(t(
      `Observer l'espace « ${nom} » ? Vous verrez ce que ce client voit, sans pouvoir rien modifier. Votre session actuelle sera remplacée.`,
      `Observe the "${nom}" workspace? You will see what this customer sees, without being able to change anything. Your current session will be replaced.`,
    ))) return;
    try {
      const r = await observerTenant(token, tenantId);
      saveSession({ token: r.token, email: `observation:${nom}`, role: 'admin', tenantId: r.tenantId, observation: nom });
      window.location.href = '/inbox';
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Observation impossible', 'Observation failed'));
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const tok = input.trim();
    if (!tok) return;
    localStorage.setItem(KEY, tok);
    setToken(tok);
  }
  function logout() {
    localStorage.removeItem(KEY);
    setToken(null);
    setData(null);
    setInput('');
  }

  if (!token) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#F7F8FB] p-4">
        <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">{t("Console d'exploitation", 'Operations console')}</h1>
          <p className="mt-1 text-sm text-ink-500">{t("Accès cross-tenant en lecture seule. Saisis le jeton d'exploitation.", 'Read-only cross-tenant access. Enter the operations token.')}</p>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="OPS token"
            className="mt-4 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <button type="submit" className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600">
            {t('Accéder', 'Access')}
          </button>
        </form>
      </main>
    );
  }

  const totalMessages = data?.tenants.reduce((a, tn) => a + tn.messages, 0) ?? 0;
  const totalContacts = data?.tenants.reduce((a, tn) => a + tn.contacts, 0) ?? 0;
  const dailyFrom = data?.daily[0]?.date;
  const dailyTo = data?.daily[data.daily.length - 1]?.date;

  return (
    <main className="min-h-screen bg-[#F7F8FB] px-4 py-8 sm:px-6">
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t("Console d'exploitation", 'Operations console')}</h1>
            <p className="text-sm text-ink-500">{t('Vue cross-tenant, lecture seule.', 'Cross-tenant view, read-only.')}</p>
          </div>
          <button onClick={logout} className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-600 hover:bg-ink-100">{t('Quitter', 'Exit')}</button>
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading && !data ? (
          <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : data ? (
          <>
            <div className="grid grid-cols-3 gap-4">
              <Stat label={t('Clients', 'Clients')} value={fmtNum(data.tenants.length, locale)} />
              <Stat label={t('Messages', 'Messages')} value={fmtNum(totalMessages, locale)} />
              <Stat label={t('Contacts', 'Contacts')} value={fmtNum(totalContacts, locale)} />
            </div>

            <WorkerCard worker={data.worker} />

            <QueueCard queues={data.queues} />
            <LatenceCard lignes={data.latences ?? []} />
            <PoolCard instantane={data.poolInstantane ?? null} points={data.attentesPool ?? []} />
            <EquiteCard groupes={data.queuesParGroupe ?? []} />

            {dailyFrom && dailyTo && data.daily.length > 0 && (
              <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
                <DailyChart
                  title={t('Messages échangés (tous clients)', 'Messages exchanged (all clients)')}
                  subtitle={t('par jour, 14 derniers jours', 'per day, last 14 days')}
                  from={dailyFrom}
                  to={dailyTo}
                  series={[{ label: t('Messages', 'Messages'), color: '#009AFE', points: data.daily }]}
                />
              </div>
            )}

            <TenantTable onObserver={(id, nom) => { void observer(id, nom); }} tenants={data.tenants} />
          </>
        ) : null}
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tracking-tight text-ink-900">{value}</div>
    </div>
  );
}

/** Au-delà de ce délai sans battement, le worker est présumé mort (interval côté serveur = 20 s ; ~4 battements
 *  manqués). En dessous, un simple hoquet réseau/DB ne doit pas afficher une fausse panne. */
const WORKER_STALE_S = 90;

/** Signal de vie du worker (item 4.9). Le worker est le SEUL process qui envoie les messages : un crash-loop
 *  passait inaperçu (mba-api répond 200). Vert = battement récent ; rouge = silencieux/absent = à investiguer. */
function WorkerCard({ worker }: { worker: WorkerHeartbeat | null }) {
  const t = useT();
  const { locale } = useLocale();
  const alive = worker !== null && worker.ageSeconds <= WORKER_STALE_S;
  const color = worker === null ? '#B8BEC9' : alive ? '#17C74E' : '#FF4D4F';
  const label = worker === null ? t('Aucun signal', 'No signal') : alive ? t('Actif', 'Alive') : t('Silencieux', 'Silent');
  const age = (s: number) => (s < 60 ? t(`il y a ${s} s`, `${s} s ago`) : t(`il y a ${Math.floor(s / 60)} min`, `${Math.floor(s / 60)} min ago`));
  const fmtDate = (iso: string) => formatDate(iso, locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold tracking-tight text-ink-900">{t('Worker (envoi des messages)', 'Worker (message sending)')}</h3>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-sm font-medium text-ink-900">{label}</span>
        </span>
        {worker ? (
          <>
            <span className="text-xs text-ink-500">{t('Dernier battement', 'Last heartbeat')} : <span className="tabular-nums text-ink-700">{age(worker.ageSeconds)}</span></span>
            {worker.bootedAt && <span className="text-xs text-ink-500">{t('Démarré', 'Booted')} : <span className="text-ink-700">{fmtDate(worker.bootedAt)}</span></span>}
            {worker.instance && <span className="font-mono text-[11px] text-ink-400">{worker.instance}</span>}
          </>
        ) : (
          <span className="text-xs text-ink-500">{t('Le worker n’a jamais signalé de vie (jamais démarré, ou table absente).', 'The worker has never reported liveness (never started, or table missing).')}</span>
        )}
      </div>
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
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm" data-testid="ops-equite">
      <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Qui attend le plus', 'Who is waiting longest')}</h3>
      <p className="mb-3 text-xs text-ink-400">
        {t(
          'Groupe = l’espace client pour les campagnes, le contact pour les entrants. Au-delà de 5 min, l’objectif d’équité est dépassé.',
          'Group = the workspace for campaigns, the contact for inbound. Beyond 5 min, the fairness objective is breached.',
        )}
      </p>
      <div className="space-y-1.5">
        {groupes.map((g) => (
          <div key={`${g.queue}:${g.groupe}`} className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2 text-xs">
            <span className="flex min-w-0 gap-2">
              <span className="font-mono text-ink-700">{g.queue}</span>
              <span className="truncate font-mono text-ink-400" title={g.groupe}>{g.groupe}</span>
            </span>
            <span className="flex shrink-0 gap-3 tabular-nums">
              <span className="text-ink-500">{fmtNum(g.backlog, locale)} {t('en file', 'queued')}</span>
              <span className={g.ageMaxSecondes >= SEUIL_S ? 'font-medium text-coral' : 'text-ink-500'}>
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
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm" data-testid="ops-pool">
      <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Pool de connexions', 'Connection pool')}</h3>
      <p className="mb-3 text-xs text-ink-400">
        {t(
          'Ce qui compte n’est pas la place restante, c’est de savoir si quelqu’un a ATTENDU une connexion, et combien de temps. Chaque acquisition est mesurée : aucun pic n’est raté.',
          'What matters is not the remaining room, it is whether anyone WAITED for a connection, and for how long. Every acquisition is measured: no spike is missed.',
        )}
      </p>

      {instantane && (
        <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-ink-50 px-3 py-2 text-xs tabular-nums">
          <span className="font-mono text-ink-700">{instantane.process}</span>
          <span className="text-ink-500">{fmtNum(instantane.total, locale)}/{fmtNum(instantane.max, locale)} {t('connexions', 'connections')}</span>
          <span className="text-ink-500">{fmtNum(instantane.libres, locale)} {t('libres', 'idle')}</span>
          {/* Le seul chiffre qui alarme : une requête en attente, c'est le pool saturé À CET INSTANT. */}
          <span className={instantane.enAttente > 0 ? 'font-medium text-coral' : 'text-ink-500'}>
            {fmtNum(instantane.enAttente, locale)} {t('en attente', 'waiting')}
          </span>
          <span className="text-ink-400">{t('pic depuis le démarrage', 'peak since start')} : {fmtNum(instantane.maxMsDepuisDemarrage, locale)} ms</span>
        </div>
      )}

      {points.length === 0 ? (
        <p className="text-xs text-ink-400">
          {t('Aucune minute enregistrée pour l’instant.', 'No minute recorded yet.')}
        </p>
      ) : (
        [...parProcess.entries()].map(([processus, liste]) => (
          <div key={processus} className="mt-3">
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="font-mono text-ink-600">{processus}</span>
              <span className="text-ink-400">
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
                  className={`w-1 shrink-0 rounded-t ${p.maxAttenteMs >= SEUIL_ATTENTE_MS ? 'bg-coral' : 'bg-ink-300'}`}
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
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold tracking-tight text-ink-900">{t('Files de traitement (pg-boss)', 'Processing queues (pg-boss)')}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {queues.map((q) => (
          <div key={q.queue} className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2">
            <span className="font-mono text-xs text-ink-700">{q.queue}</span>
            <span className="flex gap-3 text-xs tabular-nums">
              <span title={t('en attente', 'pending')} className="text-ink-600">{fmtNum(q.backlog, locale)} {t('en file', 'queued')}</span>
              <span title={t('actifs', 'active')} className="text-brand-600">{fmtNum(q.active, locale)} {t('actifs', 'active')}</span>
              <span title={t('échoués', 'failed')} className={q.failed > 0 ? 'font-medium text-coral' : 'text-ink-400'}>{fmtNum(q.failed, locale)} {t('échoués', 'failed')}</span>
              {/* 🔴 L'AGE du plus vieux job prêt, et pas seulement leur nombre : mille jobs avalés en trois
                  secondes vont bien, dix qui attendent depuis un quart d'heure vont mal. C'est ce chiffre
                  que les objectifs de service regardent (docs/SLO-2026-09-01.md). Le seuil d'alerte est
                  celui de la file la plus exigeante, l'entrant : au-delà d'une minute, un client attend. */}
              {q.ageMaxSecondes !== undefined && q.ageMaxSecondes > 0 && (
                <span
                  data-testid={`file-age-${q.queue}`}
                  title={t('âge du plus vieux job prêt', 'age of the oldest ready job')}
                  className={q.ageMaxSecondes >= 60 ? 'font-medium text-coral' : 'text-ink-400'}
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
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Latence réelle des files (24 h)', 'Actual queue latency (24 h)')}</h3>
      <p className="mb-3 mt-1 text-xs text-ink-500">
        {t(
          'Calculée sur les jobs terminés : les jobs échoués n’y figurent pas, ils se lisent sur la carte ci-dessus. À ne pas confondre avec l’âge, qui est une photo de l’instant.',
          'Computed over completed jobs: failed jobs are absent here, read them on the card above. Not to be confused with the age, which is a snapshot.',
        )}
      </p>
      {utiles.length === 0 ? (
        <p className="text-xs text-ink-400">{t('Aucun job terminé sur la fenêtre.', 'No job completed in this window.')}</p>
      ) : (
        <div className="grid gap-2">
          {utiles.map((l) => (
            <div key={l.queue} className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2">
              <span className="font-mono text-xs text-ink-700">{l.queue}</span>
              <span className="flex gap-3 text-xs tabular-nums">
                {/* L'effectif EN PREMIER : un p95 sur trois jobs ne veut rien dire. */}
                <span className="text-ink-400" title={t('jobs terminés sur la fenêtre', 'jobs completed in window')}>
                  {fmtNum(l.echantillons, locale)} {t('jobs', 'jobs')}
                </span>
                <span className="text-ink-600" title={t('attente médiane avant prise', 'median wait before pickup')}>
                  p50 {fmtSecondes(l.attenteP50Secondes)}
                </span>
                <span
                  data-testid={`latence-p95-${l.queue}`}
                  className={l.attenteP95Secondes >= SEUIL_S ? 'font-medium text-coral' : 'text-ink-600'}
                  title={t('attente au 95e centile', '95th percentile wait')}
                >
                  p95 {fmtSecondes(l.attenteP95Secondes)}
                </span>
                <span
                  data-testid={`latence-bout-en-bout-${l.queue}`}
                  className={l.boutEnBoutP95Secondes >= SEUIL_S ? 'font-medium text-coral' : 'text-ink-500'}
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
                  className={l.boutEnBoutMaxSecondes >= 120 ? 'font-medium text-coral' : 'text-ink-400'}
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

/** Secondes lisibles : un « 505,652 s » ne se lit pas, un « 8 min » se lit. */
function fmtSecondes(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
}

function TenantTable({ tenants, onObserver }: { tenants: TenantOverviewRow[]; onObserver: (id: string, nom: string) => void }) {
  const t = useT();
  const { locale } = useLocale();
  const dot = (q: string | null) => (q === 'GREEN' ? '#17C74E' : q === 'YELLOW' ? '#E8A400' : q === 'RED' ? '#FF4D4F' : '#B8BEC9');
  const fmtDate = (iso: string | null) => (iso ? formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');
  return (
    <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white shadow-sm">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
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
                <div className="text-[11px] text-ink-400">{t('créé le', 'created on')} {fmtDate(tn.createdAt)}</div>
                {/* Entrer dans l'espace pour VOIR ce que le client voit. Session en lecture seule, d'une
                    heure : elle ne peut rien modifier et ne marque rien comme lu. */}
                <button
                  onClick={() => onObserver(tn.id, tn.name)}
                  data-testid={`observe-${tn.id}`}
                  className="mt-1 text-[11px] font-medium text-brand-600 underline decoration-dotted hover:text-brand-700"
                >
                  {t('observer cet espace', 'observe this workspace')}
                </button>
              </td>
              <td className="px-3 py-2.5">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tn.mbaEnabled ? 'bg-mint-50 text-mint-700' : 'bg-ink-100 text-ink-500'}`}>
                  {tn.mbaEnabled ? t('actif', 'active') : t('inactif', 'inactive')}
                </span>
              </td>
              <td className="px-3 py-2.5">
                {tn.phone ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: dot(tn.quality) }} title={`${t('qualité', 'quality')} ${tn.quality ?? t('inconnue', 'unknown')}`} />
                    <span className="font-mono text-xs text-ink-700">{tn.phone}</span>
                  </span>
                ) : (
                  <span className="text-xs text-ink-400">—</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{fmtNum(tn.users, locale)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{fmtNum(tn.contacts, locale)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{fmtNum(tn.messages, locale)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{fmtNum(tn.templatesUsed, locale)}</td>
              <td className="px-3 py-2.5 text-xs text-ink-500">{fmtDate(tn.lastSendAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
