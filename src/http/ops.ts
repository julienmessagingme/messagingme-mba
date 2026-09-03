import type { FastifyInstance } from 'fastify';
import { makeRequireOps } from '../auth/middleware';
import { estUuid } from './scope';
import type { TenantOverviewRow, QueueLoadRow, QueueGroupLoadRow, QueueLatenceRow, GlobalDailyPoint, JobMortRow } from '../ops/store.pg';
import type { WorkerHeartbeatRow } from '../ops/heartbeat-store.pg';

/**
 * Surface d'exploitation cross-tenant, en LECTURE SEULE À UNE EXCEPTION PRÈS.
 *
 * ⚠️ La session d'observation (`/ops/observe`) ne fait qu'ÉMETTRE un jeton : elle n'écrit rien, et le jeton
 * émis est lui-même incapable d'écrire.
 *
 * 🔴 LE RECHARGEMENT DU SOLDE (`/ops/credits`) EST LA PREMIÈRE ÉCRITURE MÉTIER DE CETTE SURFACE, et c'est
 * assumé plutôt que glissé. Créditer le compte prépayé d'un client est un geste d'EXPLOITATION par nature :
 * il ne doit jamais être accessible depuis un compte de la console, sans quoi un client se rechargerait
 * lui-même. L'autorité séparée de `/ops` (jeton d'exploitation, jamais le JWT client) est exactement la
 * bonne, et le geste est journalisé comme l'observation. Aucune autre écriture ne doit rejoindre cette
 * surface sans la même justification.
 */
export interface OpsRouteDeps {
  /**
   * Ouvre une session d'OBSERVATION dans l'espace d'un client : rend un jeton de session en LECTURE SEULE.
   *
   * Optionnelle : absente, la route n'est pas montée. C'est volontaire : une instance qui n'a pas
   * explicitement câblé cette capacité ne doit pas l'exposer.
   */
  observerTenant?(tenantId: string): Promise<{ token: string; tenantName: string } | null>;
  getTenantOverview(): Promise<TenantOverviewRow[]>;
  getGlobalDaily(days: number): Promise<GlobalDailyPoint[]>;
  getQueueLoad(): Promise<QueueLoadRow[]>;
  /**
   * Les GROUPES qui attendent le plus (équité, SLO 3). Vide quand rien n'attend, ce qui est l'état normal.
   *
   * Optionnelle : absente -> `queuesParGroupe: []`, aucun site de construction cassé. C'est une lecture de
   * confort d'exploitation, pas une garantie : elle ne doit rien faire échouer.
   */
  getQueueLoadParGroupe?(): Promise<QueueGroupLoadRow[]>;
  /**
   * La latence RÉELLE par file sur une fenêtre : le p95 que le document de SLO croyait lire dans la jauge
   * d'âge (constat A4 de l'audit externe du 2026-09-02). Optionnelle et best-effort, comme l'équité : elle
   * sert à VOIR, elle ne garantit rien, et un écran d'exploitation ne tombe pas parce qu'une mesure manque.
   */
  getQueueLatence?(fenetreHeures: number): Promise<QueueLatenceRow[]>;
  /**
   * Les jobs MORTS (file d'échec), les plus anciens d'abord. Lecture pure. Absente -> route non montée.
   *
   * 🔴 Pour un `webhook`, un job mort est un MESSAGE DE CLIENT jamais traité, et c'est le pire cas du dépôt
   * parce qu'il est silencieux : le client a écrit, le scénario n'a pas avancé, personne ne le sait.
   */
  listerJobsMorts?(limite: number): Promise<JobMortRow[]>;
  /** Ré-enfile un job dans sa file d'origine. Doit être la MÊME file que celle des jobs vivants. */
  reenfiler?(queue: string, data: unknown): Promise<void>;
  /** Retire de la file d'échec les jobs RÉ-ENFILÉS. Appelée APRÈS l'enfilement, jamais avant. */
  oublierJobsMorts?(ids: string[]): Promise<number>;
  /** Signal de vie du worker (item 4.9). OPTIONNEL : omis -> `worker: null` dans le payload, aucun site de
   *  construction cassé. Distinct des files (queues) : prouve que le PROCESS worker vit, pas que les files se vident. */
  getWorkerHeartbeat?(): Promise<WorkerHeartbeatRow | null>;
  /**
   * Le solde prépayé d'un workspace, en micro-euros, avec son journal. `null` = espace inconnu.
   *
   * ⚠️ Distinguer « inconnu » de « zéro » n'est pas cosmétique : un opérateur qui lit 0 sur un identifiant mal
   * tapé croit voir un client à sec et le recharge, sur un espace qui n'existe pas.
   */
  soldeAgent?(tenantId: string): Promise<{ soldeMicroEur: number; mouvements: unknown[] } | null>;
  /** Recharge le solde. Rend le nouveau solde, ou `null` si l'espace est inconnu. Absente -> route non montée. */
  rechargerAgent?(tenantId: string, montantMicroEur: number, note: string): Promise<number | null>;
  /**
   * L'ATTENTE DU POOL DE CONNEXIONS (lot 7 du plan post-audit).
   *
   * Deux choses, et il faut les deux : l'état INSTANTANÉ du pool de CE process (l'API), et la COURBE agrégée
   * par minute lue en base, seul canal par lequel le worker peut se montrer (`/ops` est servi par l'API, qui
   * ne voit jamais le pool de l'autre process).
   *
   * Optionnelles, comme le reste de cet écran : absentes -> la carte n'a rien à afficher, tout le reste
   * continue. Une mesure ne doit jamais faire tomber ce qu'elle mesure, ni l'écran qui la montre.
   */
  etatPoolInstantane?(): { process: string; total: number; libres: number; enAttente: number; max: number; maxMsDepuisDemarrage: number };
  lireAttentesPool?(minutes: number): Promise<unknown[]>;
}

/**
 * Monte `/ops/overview` (GET), `/ops/observe` et `/ops/credits`. Protégé par `x-ops-token` == `opsToken`
 * (constant-time). Si `opsToken` est vide, tout répond 401 (surface désactivée par défaut). N'utilise jamais
 * `req.auth` : c'est une autorité SÉPARÉE du JWT tenant.
 */
/** Plafond d'une recharge : 1000 euros. Une virgule mal placée ne doit pas passer en silence, et il
 *  n'existe aucune route de débit pour la rattraper. */
const MAX_RECHARGE_MICRO_EUR = 1_000_000_000;

/** Longueur minimale de la note d'un rechargement. Trois caractères ne prouvent rien, mais ils empêchent le
 *  champ d'être rempli par un espace pour passer la garde. */
const MIN_NOTE = 3;

/** Plafond d'un rejeu en une fois. Rejouer mille traitements d'un coup sur une cause non corrigée, c'est
 *  refaire mille fois la même erreur : on borne pour forcer à regarder entre deux lots. */
const MAX_REJEU = 100;

export function registerOps(app: FastifyInstance, deps: OpsRouteDeps, opsToken: string): void {
  const guard = { preHandler: makeRequireOps(opsToken) };

  app.get('/ops/overview', guard, async (_req, reply) => {
    const [tenants, daily, queues, worker, queuesParGroupe, attentesPool, latences] = await Promise.all([
      deps.getTenantOverview(),
      deps.getGlobalDaily(14),
      deps.getQueueLoad(),
      deps.getWorkerHeartbeat ? deps.getWorkerHeartbeat() : Promise.resolve(null),
      // Best-effort : une lecture d'équité en échec ne doit pas priver l'exploitation de tout le reste de
      // l'écran. Elle sert à VOIR, elle ne garantit rien.
      deps.getQueueLoadParGroupe ? deps.getQueueLoadParGroupe().catch(() => []) : Promise.resolve([]),
      // Même doctrine, et elle compte doublement ici : la table de la migration 0109 peut ne pas exister
      // encore, et un écran d'exploitation qui tombe le jour d'un déploiement est exactement ce qu'on ne veut pas.
      deps.lireAttentesPool ? deps.lireAttentesPool(180).catch(() => []) : Promise.resolve([]),
      // Fenêtre de 24 h : assez longue pour que le p95 ait un sens, assez courte pour qu'il décrive
      // AUJOURD'HUI. Sur sept jours, un incident d'il y a six jours tiendrait encore le chiffre.
      deps.getQueueLatence ? deps.getQueueLatence(24).catch(() => []) : Promise.resolve([]),
    ]);
    const poolInstantane = deps.etatPoolInstantane ? deps.etatPoolInstantane() : null;
    return reply.code(200).send({ tenants, daily, queues, worker, queuesParGroupe, poolInstantane, attentesPool, latences });
  });

  /**
   * Entrer dans l'espace d'un client pour VOIR ce qu'il voit.
   *
   * Protégée par le même jeton d'exploitation que le reste de `/ops`, qui est une autorité SÉPARÉE du JWT
   * client : personne ne peut s'ouvrir cette porte depuis un compte de la console.
   *
   * Le jeton rendu est en lecture seule (garde globale dans `makeRequireAuth`), il ne marque rien comme lu,
   * et il ne relit aucun état en base puisque son porteur n'a pas de compte dans cet espace.
   *
   * 🔴 Invisible côté CLIENT, journalisé côté EXPLOITATION : un accès à toutes les données de tous les
   * clients sans aucune trace nulle part est exactement ce qu'un audit de sécurité reproche en premier.
   */
  /**
   * LES JOBS MORTS : les voir, puis décider de les rejouer.
   *
   * 🔴 DEUXIÈME ÉCRITURE MÉTIER de cette surface, et elle est assumée pour la même raison que la première
   * (le rechargement de solde) : rejouer un traitement mort est un geste d'EXPLOITATION par nature. Il est
   * cross-espace, il suppose qu'on ait corrigé la cause de l'échec, et il ne doit jamais être accessible
   * depuis un compte de la console, sans quoi un client rejouerait des traitements sans savoir pourquoi ils
   * avaient échoué. L'autorité séparée de `/ops` est exactement la bonne.
   *
   * Pourquoi ça manquait. Un job qui épuise ses rejeux part en file d'échec, que RIEN ne consomme. On alerte
   * déjà quand elle se remplit, mais la seule reprise possible était de renvoyer le message à la main, ce qui
   * ne passe pas l'échelle. Pour un `webhook`, un job mort est un MESSAGE DE CLIENT jamais traité : il a
   * écrit, le scénario n'a pas avancé, et personne ne le sait.
   *
   * La LECTURE d'abord, et c'est délibéré : rejouer sans regarder, c'est relancer en masse des traitements
   * qui ont échoué pour une raison qu'on n'a pas corrigée.
   */
  if (deps.listerJobsMorts) {
    app.get('/ops/dlq', guard, async (req, reply) => {
      const brut = (req.query as { limit?: unknown }).limit;
      const limite = typeof brut === 'string' && /^\d+$/.test(brut) ? Number(brut) : 50;
      return reply.code(200).send({ jobs: await deps.listerJobsMorts!(limite) });
    });
  }

  if (deps.listerJobsMorts && deps.reenfiler && deps.oublierJobsMorts) {
    app.post('/ops/dlq/replay', guard, async (req, reply) => {
      const b = (req.body ?? {}) as { queue?: unknown; limit?: unknown };
      // La file est OBLIGATOIRE : un rejeu « tout » relancerait des campagnes et des webhooks d'un coup,
      // sur des causes d'échec différentes qu'on n'a pas toutes corrigées.
      if (typeof b.queue !== 'string' || b.queue.trim() === '') {
        return reply.code(400).send({ error: 'queue requise (la file d’origine, ex. « webhook »)' });
      }
      const queue = b.queue.trim();
      const limite = typeof b.limit === 'number' && Number.isFinite(b.limit) ? Math.trunc(b.limit) : 10;
      if (limite < 1 || limite > MAX_REJEU) {
        return reply.code(400).send({ error: `limit entre 1 et ${MAX_REJEU}` });
      }
      const morts = (await deps.listerJobsMorts!(200)).filter((j) => j.queue === queue).slice(0, limite);
      if (morts.length === 0) return reply.code(200).send({ rejoues: 0, oublies: 0 });

      // 🔴 ENFILER PUIS OUBLIER, et l'ordre est choisi. Un crash entre les deux produit un DOUBLON ;
      // l'ordre inverse produirait une PERTE. Le doublon est rattrapé partout où ça compte (déduplication
      // du message entrant, réclamation atomique d'un destinataire, verrou de run), la perte nulle part.
      const rejoues: string[] = [];
      for (const j of morts) {
        try {
          await deps.reenfiler!(j.queue, j.data);
          rejoues.push(j.id);
        } catch (err) {
          // On s'arrête au premier échec d'enfilement plutôt que d'insister : si la file refuse, elle
          // refusera aussi les suivants, et ce qui a déjà été enfilé doit être oublié proprement.
          // eslint-disable-next-line no-console
          console.error(`ops dlq replay: enfilement impossible pour ${j.id}`, err instanceof Error ? err.message : err);
          break;
        }
      }
      const oublies = await deps.oublierJobsMorts!(rejoues);
      return reply.code(200).send({ rejoues: rejoues.length, oublies });
    });
  }

  app.post('/ops/observe', guard, async (req, reply) => {
    if (!deps.observerTenant) return reply.code(503).send({ error: 'observation non disponible sur cette instance' });
    const tenantId = (req.body as { tenantId?: unknown } | null)?.tenantId;
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      return reply.code(400).send({ error: 'tenantId requis' });
    }
    // Même raison que sur `/ops/credits` : un identifiant mal formé fait LEVER Postgres (`22P02`) au lieu de
    // rendre zéro ligne, donc un 500 dont Cloudflare remplace le corps.
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const r = await deps.observerTenant(tenantId);
    if (!r) return reply.code(404).send({ error: 'espace inconnu' });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_observation', tenantId, tenantName: r.tenantName, at: new Date().toISOString() }));
    return reply.code(200).send({ token: r.token, tenantId, tenantName: r.tenantName });
  });

  /** Le solde prépayé d'un workspace et son journal. Lecture, comme le reste de la surface. */
  app.get('/ops/credits/:tenantId', guard, async (req, reply) => {
    if (!deps.soldeAgent) return reply.code(503).send({ error: 'solde agent non disponible sur cette instance' });
    const { tenantId } = req.params as { tenantId: string };
    // Un identifiant mal formé part tel quel dans un `where id = $1` sur une colonne `uuid` : Postgres LÈVE
    // (`22P02`), donc 500, dont Cloudflare remplace le corps par sa page d'erreur. Une adresse tapée de
    // travers doit rendre 404.
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const r = await deps.soldeAgent(tenantId);
    if (!r) return reply.code(404).send({ error: 'espace inconnu' });
    return reply.code(200).send(r);
  });

  /**
   * RECHARGER le solde prépayé d'un workspace.
   *
   * 🔴 La seule écriture métier de cette surface, et elle est ici parce qu'elle ne peut être nulle part
   * ailleurs : un client ne doit jamais pouvoir créditer son propre compte. Journalisée comme l'observation,
   * pour la même raison : un mouvement d'argent sans trace est ce qu'un audit reproche en premier.
   *
   * Le montant est en MICRO-EUROS, comme tous les compteurs du produit, et il est BORNÉ : une recharge de
   * plusieurs milliers d'euros passée par une virgule mal placée n'a aucune raison d'être acceptée en
   * silence, et se corrige mal (il n'y a pas de route de débit).
   *
   * La NOTE est obligatoire : le jeton d'exploitation est partagé, donc il n'y a aucune identité d'opérateur
   * à enregistrer, et cette phrase est la seule trace de qui a rechargé et pourquoi.
   */
  app.post('/ops/credits/:tenantId', guard, async (req, reply) => {
    if (!deps.rechargerAgent) return reply.code(503).send({ error: 'rechargement non disponible sur cette instance' });
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const corps = (req.body ?? {}) as { montantMicroEur?: unknown; note?: unknown };
    const montant = typeof corps.montantMicroEur === 'number' ? Math.round(corps.montantMicroEur) : NaN;
    if (!Number.isFinite(montant) || montant <= 0 || montant > MAX_RECHARGE_MICRO_EUR) {
      return reply.code(400).send({ error: `montantMicroEur requis, entre 1 et ${MAX_RECHARGE_MICRO_EUR} (soit 1000 euros)` });
    }
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui recharge, et pourquoi' });
    const solde = await deps.rechargerAgent(tenantId, montant, note);
    // Espace inconnu : sans cette garde, la clé étrangère lèverait et l'identifiant mal tapé rendrait un 500
    // remplacé par la page d'erreur de Cloudflare, sur la seule route qui écrit de l'argent.
    if (solde === null) return reply.code(404).send({ error: 'espace inconnu' });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_recharge_agent', tenantId, montantMicroEur: montant, soldeMicroEur: solde, at: new Date().toISOString() }));
    return reply.code(200).send({ tenantId, soldeMicroEur: solde });
  });
}
