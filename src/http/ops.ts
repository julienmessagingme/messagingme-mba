import type { FastifyInstance } from 'fastify';
import { makeRequireOps } from '../auth/middleware';
import type { SurveillanceOps } from '../ops/tentatives';
import { estUuid } from './scope';
import { valideGrille, BORNES_GRILLE, type GrillePrix } from '../stats/prix';
import { journaliser } from '../lib/journal';
import type { SortAncienAcces } from '../meta/pubs';
import type { TenantOverviewRow, QueueLoadRow, QueueGroupLoadRow, QueueLatenceRow, GlobalDailyPoint, JobMortRow } from '../ops/store.pg';
import type { WorkerHeartbeatRow } from '../ops/heartbeat-store.pg';
import type { BilanRisque } from '../engagement/balayage';

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
 *
 * 🔴 LA GRILLE DE PRIX (`/ops/prix`) EST LA SECONDE, ET ELLE PORTE LA MÊME JUSTIFICATION (lot 8 du
 * 2026-09-23, migration 0168). Elle vivait dans les Paramètres du client, donc derrière un JWT que le client
 * possède : il fixait lui-même ce qu'on lui facture. Elle est désormais UNIQUE pour tous les espaces et ne
 * se change que d'ici. ⚠️ Elle est cross-espace par NATURE, et c'est ce qui la distingue des deux autres
 * écritures : `/ops/credits` et `/ops/verrou` visent un espace, celle-ci n'en vise aucun.
 */
/**
 * CE QUI EST ARRIVÉ À L'ANCIEN JETON quand un dépôt en remplace un. Un jeton d'utilisateur système
 * n'expire JAMAIS, donc chacune de ces valeurs appelle un geste différent :
 *
 * - `aucun` : il n'y avait pas de connexion. Rien à faire.
 * - `retire` : l'ancien portait une AUTRE entité Meta, ses permissions ont été retirées. Rien à faire.
 * - `meme_entite` : l'ancien et le neuf sont le MÊME utilisateur système sous la même application.
 *   On n'a DÉLIBÉRÉMENT rien retiré : `DELETE /me/permissions` aurait aussi désarmé le jeton neuf.
 *   🔴 L'ancienne chaîne reste donc VALIDE : pour la tuer, régénérer le jeton de l'utilisateur
 *   système chez Meta, ce qui invalide toutes ses émissions précédentes.
 * - `indetermine` : Meta n'a pas dit qui portait l'un des deux jetons, donc on n'a pas comparé et
 *   on n'a rien retiré. Même geste que `meme_entite` si l'ancienne chaîne doit disparaître.
 * - `echec` : on a essayé de retirer et Meta a refusé. Un accès reste vivant, à retirer à la main
 *   dans les paramètres du portefeuille (les PERMISSIONS publicitaires, jamais l'application,
 *   qui porte le numéro WhatsApp).
 */
/**
 * ⚠️ UN ALIAS, PAS UNE SECONDE LISTE. Les cinq valeurs ont été écrites deux fois à la main pendant
 * quelques heures. Le compilateur couplait les deux copies dans les sens dangereux, donc ce n'était
 * pas un piège armé, mais c'était deux endroits à tenir alignés. La source est `SortAncienAcces`,
 * là où la décision se prend ; ce qui reste ICI est la PROSE, qui dit le geste à faire pour chaque
 * valeur, et c'est bien sa place : `/ops` est la surface où quelqu'un lit ce verdict et agit.
 */
export type SortAncienJetonPub = SortAncienAcces;

/** Ce que la route d'exploitation rend après avoir déposé un jeton publicitaire. */
export interface ConnexionPubDeposee {
  comptePubId: string;
  compteNom: string | null;
  pageId: string;
  pageNom: string | null;
  devise: string | null;
  fuseau: string | null;
  pageLiee: string | null;
  /** Ce qui est arrivé à l'ancien jeton. Cf. `SortAncienJetonPub`. */
  ancienRevoque: SortAncienJetonPub;
}

export interface OpsRouteDeps {
  /**
   * DÉPOSER UN JETON PUBLICITAIRE CRÉÉ À LA MAIN. Absent -> la route répond 503.
   *
   * 🔴 POURQUOI CETTE ROUTE EXISTE, ET POURQUOI ELLE EST DANS `/ops`. Le parcours de connexion de
   * l'écran Publicités ne peut PAS servir le portefeuille Meta qui possède notre application : Meta
   * exige que le portefeuille du client soit distinct de celui de l'app, et grèse ce portefeuille dans
   * la fenêtre (mesuré le 2026-09-23). Or c'est précisément celui de MessagingMe, où vivent notre
   * numéro WhatsApp, notre Page et notre compte publicitaire. Sans cette porte, NOUS ne pourrions
   * jamais faire nos propres publicités avec notre propre produit.
   *
   * ⚠️ ELLE EST CROSS-ESPACE, comme le rechargement de crédit, et c'est délibéré : `/ops` s'authentifie
   * par un JETON d'exploitation, pas par une session. Le jeton publicitaire déposé est chiffré par le
   * câblage, jamais gardé en clair, et n'est JAMAIS renvoyé dans la réponse.
   */
  deposerJetonPub?(tenantId: string, jeton: string, comptePubId: string, pageId: string): Promise<ConnexionPubDeposee>;

  /**
   * Les compteurs d'usage de l'API publique. ABSENT -> `/ops/usage` rend une liste vide.
   *
   * ⚠️ OPTIONNEL ICI, ET OBLIGATOIRE SUR LES ROUTES `/v1` : la différence n'est pas une inattention. Une
   * route publique qui oublierait de compter perdrait une mesure en silence ; `/ops`, lui, est monté par
   * des tests qui n'ont aucun usage à montrer, et une liste vide y est une réponse honnête.
   */
  usage?: { compteurs(): unknown[] };
  /**
   * LA GRILLE DE PRIX GLOBALE (migration 0168). Absentes -> les deux routes rendent 503 plutôt que de
   * laisser croire au geste, comme le verrou d'espace et la révocation de clé.
   */
  lireGrillePrix?(): Promise<GrillePrix>;
  /** `par` = la NOTE : le jeton d'exploitation est partagé, c'est la seule trace de qui a changé un prix. */
  ecrireGrillePrix?(grille: GrillePrix, par: string): Promise<void>;
  /**
   * POSE OU RETIRE LE VERROU D'UN ESPACE (`tenants.status`). Rend `false` si l'espace est inconnu.
   *
   * 🔴 IL N'EXISTAIT AUCUN MOYEN DE POSER CE VERROU (mesuré le 2026-09-14) : il était lu par la garde de
   * session, et écrit par personne. Aucune route, aucun script, aucun écran. Un interrupteur sans bouton.
   *
   * ⚠️ Optionnel : une instance qui ne l'a pas câblé répond 503 plutôt que de laisser croire au geste.
   *
   * ⚠️ ELLE NE CONSERVE PAS LA NOTE : seul le statut s'écrit en base. Le POURQUOI d'un verrou vit dans une
   * seule trace, la ligne `ops_verrou_espace` que la route écrit, et qu'un test lit.
   */
  verrouillerEspace?(tenantId: string, verrouille: boolean, note: string): Promise<boolean>;
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
   * RÉVOQUE la clé de modèle d'un espace : chez Vercel, puis chez nous (2026-09-09).
   *
   * 🔴 À FAIRE AVANT DE SUPPRIMER UN ESPACE, le jour où ça existera. `agent_gateway_keys.tenant_id` porte un
   * `on delete cascade` : sans révocation préalable, notre ligne part avec l'espace et la clé survit chez
   * Vercel avec son identifiant PERDU, donc facturable et irrévocable. C'est pour ça que ce geste est ici,
   * sur la surface d'exploitation, et pas sur un écran client : ce n'est pas au client de nettoyer.
   *
   * Rend `false` quand l'espace n'avait pas de clé, ce qui est le cas le plus fréquent et n'est pas une erreur.
   */
  revoquerCleModele?(tenantId: string): Promise<boolean>;
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
  /**
   * LANCE LE BALAYAGE DU RISQUE DE DÉSENGAGEMENT d'un espace, tout de suite (lot 7 de l'API publique). Rend son
   * bilan, ou `null` si l'espace est inconnu. Absent -> la route répond 503.
   */
  balayerRisque?(tenantId: string): Promise<BilanRisque | null>;
}

/**
 * Monte `/ops/overview`, `/ops/usage`, `/ops/verrou`, `/ops/dlq`, `/ops/observe` et `/ops/credits`. ⚠️ Cette liste a
 * vécu incomplète (elle ignorait `/ops/dlq`) : une énumération écrite à la main dérive au premier ajout,
 * et celle-ci décrit une surface d'exploitation, donc ce qu'un porteur du jeton peut atteindre.
 * Protégé par `x-ops-token` == `opsToken`
 * (constant-time). Si `opsToken` est vide, tout répond 401 (surface désactivée par défaut). N'utilise jamais
 * `req.auth` : c'est une autorité SÉPARÉE du JWT tenant.
 */
/** Plafond d'une recharge : 1000 euros. Une virgule mal placée ne doit pas passer en silence, et il
 *  n'existe aucune route de débit pour la rattraper. */
const MAX_RECHARGE_MICRO_EUR = 1_000_000_000;

/** Longueur minimale de la note d'une écriture d'exploitation : rechargement de crédit ET verrou d'espace.
 *  Trois caractères ne prouvent rien, mais ils empêchent le champ d'être rempli par un espace pour passer
 *  la garde. ⚠️ Elle sert désormais à DEUX routes : la nommer « note d'un rechargement » était vrai le jour
 *  où elle a été écrite, et faux dès la seconde. */
const MIN_NOTE = 3;

/** Plafond d'un rejeu en une fois. Rejouer mille traitements d'un coup sur une cause non corrigée, c'est
 *  refaire mille fois la même erreur : on borne pour forcer à regarder entre deux lots. */
const MAX_REJEU = 100;

export function registerOps(
  app: FastifyInstance,
  deps: OpsRouteDeps,
  opsToken: string,
  /**
   * Surveillance des refus. ABSENTE -> comportement d'avant : le 401 part sans laisser de trace. Optionnelle
   * parce que les tests montent `/ops` sans avoir de canal d'alerte, et qu'une surveillance manquante ne doit
   * jamais empêcher la garde de fonctionner.
   */
  surveillance?: SurveillanceOps,
): void {
  const opts = { preHandler: makeRequireOps(opsToken, surveillance) };

  /**
   * L'USAGE DE L'API PUBLIQUE, agrégé par minute (plan du 2026-09-14, tâche 5).
   *
   * 🔴 IL N'Y AVAIT RIEN AVANT, ET C'EST MESURÉ : la seule trace d'usage était un `api_keys.last_used_at`
   * ÉCRASÉ à chaque appel. Impossible de répondre à « qui consomme quoi », ni de savoir si un seuil
   * mordrait sur un vrai client. ⚠️ L'audit du 2026-09-13 affirmait que `/ops` montrait déjà les erreurs
   * de livraison : c'est FAUX, vérifié route par route.
   *
   * 🔴 EN OBSERVATION : ces compteurs ne refusent rien aujourd'hui. Ils existent pour qu'un seuil soit un
   * jour arbitré sur des chiffres plutôt que deviné.
   *
   * ⚠️ LU EN MÉMOIRE, PAS EN BASE, et c'est une décision : une ligne SQL par requête ferait amplifier par
   * la journalisation la charge qu'elle observe. Corollaire à connaître : ces compteurs décrivent CE
   * process, donc avec deux instances d'API on en verrait deux moitiés.
   */
  app.get('/ops/usage', opts, async (_req, reply) => {
    return reply.code(200).send({ compteurs: deps.usage ? deps.usage.compteurs() : [] });
  });

  /**
   * L'ARRÊT D'URGENCE D'UN ESPACE (plan du 2026-09-14, tâche 7).
   *
   * 🔴 CE QU'IL FERME, ET CE QU'IL NE FERME PAS. Il ferme les PORTES : la console (garde de session) et
   * l'API publique (garde de clé, `/v1` et `/mcp`). Il n'arrête PAS les campagnes déjà enfilées, qui sont
   * du travail EN VOL dans le worker. Le runbook de `DEPLOY.md` dit comment les mettre en pause : sans
   * cela, on croit avoir coupé et les messages continuent de partir.
   *
   * ⚠️ LA NOTE EST EXIGÉE, comme sur le rechargement de crédit : une écriture d'exploitation sans trace de
   * qui l'a faite et pourquoi ne se relit pas six mois plus tard.
   */
  app.post('/ops/verrou/:tenantId', opts, async (req, reply) => {
    if (!deps.verrouillerEspace) return reply.code(503).send({ error: 'verrou non disponible sur cette instance' });
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const corps = (req.body ?? {}) as { verrouille?: unknown; note?: unknown };
    if (typeof corps.verrouille !== 'boolean') return reply.code(400).send({ error: 'verrouille (booléen) requis' });
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui verrouille, et pourquoi' });

    const fait = await deps.verrouillerEspace(tenantId, corps.verrouille, note);
    if (!fait) return reply.code(404).send({ error: 'espace inconnu' });
    journaliser('warn', 'ops_verrou_espace', { tenantId, verrouille: corps.verrouille, note, at: new Date().toISOString() });
    return reply.code(200).send({ tenantId, verrouille: corps.verrouille });
  });

  app.get('/ops/overview', opts, async (_req, reply) => {
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
    app.get('/ops/dlq', opts, async (req, reply) => {
      const brut = (req.query as { limit?: unknown }).limit;
      const limite = typeof brut === 'string' && /^\d+$/.test(brut) ? Number(brut) : 50;
      return reply.code(200).send({ jobs: await deps.listerJobsMorts!(limite) });
    });
  }

  if (deps.listerJobsMorts && deps.reenfiler && deps.oublierJobsMorts) {
    app.post('/ops/dlq/replay', opts, async (req, reply) => {
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

  app.post('/ops/observe', opts, async (req, reply) => {
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
  app.get('/ops/credits/:tenantId', opts, async (req, reply) => {
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
  /**
   * RÉVOQUER la clé de modèle d'un espace.
   *
   * ⚠️ `DELETE` et non `POST` : c'est une suppression, et la surface d'exploitation doit se lire comme ce
   * qu'elle fait. Journalisé en `warn` comme le rechargement : le jeton est partagé, donc cette ligne est la
   * seule trace qu'un geste irréversible a eu lieu.
   */
  app.delete('/ops/cle-modele/:tenantId', opts, async (req, reply) => {
    if (!deps.revoquerCleModele) return reply.code(503).send({ error: 'revocation non disponible sur cette instance' });
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    try {
      const revoquee = await deps.revoquerCleModele(tenantId);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_revoque_cle_modele', tenantId, revoquee, at: new Date().toISOString() }));
      return reply.code(200).send({ tenantId, revoquee });
    } catch (err) {
      // 4xx et jamais 5xx : Cloudflare remplacerait le corps, et l'opérateur a besoin de savoir que la clé
      // est TOUJOURS là (donc qu'il faut réessayer) plutôt que de croire à un succès silencieux.
      journaliser('error', 'ops_revocation_impossible', { err, tenantId });
      return reply.code(422).send({ error: 'Vercel n’a pas confirmé la suppression ; la clé est toujours active, réessayez' });
    }
  });

  app.post('/ops/credits/:tenantId', opts, async (req, reply) => {
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

  /**
   * DÉPÔT D'UN JETON PUBLICITAIRE D'UTILISATEUR SYSTÈME (2026-09-23).
   *
   * 🔴 LE JETON ARRIVE DANS LE CORPS, ET C'EST LA SEULE FOIS. Il n'est ni journalisé, ni renvoyé, ni
   * écrit ailleurs qu'en base, chiffré. La trace qui part en console ne porte que les identifiants des
   * actifs choisis, jamais le secret : une tentative ratée est presque toujours un jeton voisin du vrai.
   *
   * ⚠️ LE JETON EST VÉRIFIÉ CHEZ META AVANT D'ÊTRE GARDÉ, par le même chemin que la connexion par
   * l'écran : si le compte ou la Page ne sont pas accordés, on refuse plutôt que de ranger un jeton qui
   * ne sert à rien et qu'on croirait bon.
   */
  app.post('/ops/pubs/connexion/:tenantId', opts, async (req, reply) => {
    if (!deps.deposerJetonPub) return reply.code(503).send({ error: 'dépôt de jeton publicitaire non disponible sur cette instance' });
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const corps = (req.body ?? {}) as { jeton?: unknown; comptePubId?: unknown; pageId?: unknown; note?: unknown };
    const jeton = typeof corps.jeton === 'string' ? corps.jeton.trim() : '';
    const comptePubId = typeof corps.comptePubId === 'string' ? corps.comptePubId.trim() : '';
    const pageId = typeof corps.pageId === 'string' ? corps.pageId.trim() : '';
    if (jeton.length < 20) return reply.code(400).send({ error: 'jeton requis' });
    if (comptePubId === '' || pageId === '') return reply.code(400).send({ error: 'comptePubId et pageId requis' });
    // ⚠️ NOTE OBLIGATOIRE, comme les trois autres écritures de `/ops`. Ce dépôt REMPLACE la connexion
    // publicitaire d'un client : une écriture d'exploitation sans trace de qui l'a faite et pourquoi ne
    // se relit pas six mois plus tard.
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui dépose ce jeton, et pourquoi' });
    let depose: ConnexionPubDeposee;
    try {
      depose = await deps.deposerJetonPub(tenantId, jeton, comptePubId, pageId);
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : 'jeton refusé' });
    }
    // ⚠️ `journaliser` ET PAS UN `console.log` RECOPIÉ : le helper du dépôt envoie un `warn` sur
    // stderr, quand la copie partait sur stdout en se déclarant `warn`. Deux vérités pour une ligne.
    journaliser('warn', 'ops_jeton_pub_depose', {
      tenantId, comptePubId: depose.comptePubId, pageId: depose.pageId,
      ancienRevoque: depose.ancienRevoque, note, at: new Date().toISOString(),
    });
    return reply.code(200).send({ tenantId, connexion: depose });
  });

  /**
   * LE BALAYAGE DU RISQUE DE DÉSENGAGEMENT, À LA DEMANDE, POUR UN ESPACE (lot 7 de l'API publique, spec § 19).
   *
   * 🔴 UNE ÉCRITURE MÉTIER DE PLUS SUR CETTE SURFACE, ET ELLE PORTE SA JUSTIFICATION : c'est le balayage de nuit,
   * lancé maintenant, pour l'essai réel du lot et le dépannage. Il écrit le risque des fiches, émet les signaux et
   * peut DÉCLENCHER les automations « risque élevé » (avec le même plafond de 200 par passage et par espace que la
   * nuit) : un geste d'exploitation, qu'aucun compte de la console ne doit pouvoir faire. Rejoué, il ne redéclenche
   * rien : un passage en élevé déjà écrit n'en est plus un.
   *
   * ⚠️ LA NOTE EST EXIGÉE, comme sur les autres écritures : le jeton est partagé, c'est la seule trace de qui a
   * lancé le balayage et pourquoi. ⚠️ Il tourne DANS la requête : sur un gros espace, compter en dizaines de
   * secondes. Un espace verrouillé n'est pas sauté ici (c'est un geste explicite), contrairement à la nuit.
   */
  app.post('/ops/risque/:tenantId', opts, async (req, reply) => {
    if (!deps.balayerRisque) return reply.code(503).send({ error: 'balayage du risque non disponible sur cette instance' });
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const corps = (req.body ?? {}) as { note?: unknown };
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui lance le balayage, et pourquoi' });
    const bilan = await deps.balayerRisque(tenantId);
    if (bilan === null) return reply.code(404).send({ error: 'espace inconnu' });
    journaliser('warn', 'ops_balayage_risque', { ...bilan, note, at: new Date().toISOString() });
    return reply.code(200).send({ bilan });
  });

  /**
   * LA GRILLE DE PRIX, UNE POUR TOUS LES ESPACES (migration 0168).
   *
   * ⚠️ AUCUN `:tenantId`, ET CE N'EST PAS UN OUBLI : il n'y a qu'une grille. Une route par espace aurait
   * laissé croire à un prix négociable client par client, c'est-à-dire exactement ce que l'arbitrage a
   * retiré.
   */
  app.get('/ops/prix', opts, async (_req, reply) => {
    if (!deps.lireGrillePrix) return reply.code(503).send({ error: 'grille de prix non disponible sur cette instance' });
    return reply.code(200).send({ prix: await deps.lireGrillePrix(), bornes: BORNES_GRILLE });
  });

  /**
   * CHANGER LA GRILLE. Seconde écriture métier de la surface (cf. le docblock du fichier).
   *
   * 🔴 LES SIX CHAMPS D'UN COUP, ET LA VALIDATION REFUSE AU LIEU DE CORRIGER. Ramener une valeur hors bornes
   * DANS les bornes enregistrerait un prix que personne n'a choisi, et des clients bâtiraient un budget
   * dessus sans jamais savoir que la saisie avait été réécrite. La réponse NOMME le champ fautif.
   *
   * ⚠️ LES BORNES SONT CELLES DES CHECK DE LA BASE, par `valideGrille`, et c'est le même `BORNES_GRILLE` que
   * l'écran affiche. Accepter plus large rendrait un 500 (Postgres refuse la ligne) sur un geste ordinaire ;
   * accepter plus étroit refuserait un réglage légitime sans raison lisible.
   *
   * 🔴 LA NOTE EST OBLIGATOIRE, COMME SUR LE RECHARGEMENT, ET POUR LA MÊME RAISON : le jeton d'exploitation
   * est PARTAGÉ, donc il n'y a aucune identité d'opérateur à enregistrer. Cette phrase est la seule trace de
   * qui a changé un prix et pourquoi. Un prix qui change sans trace est ce qu'un audit reproche en premier.
   */
  app.patch('/ops/prix', opts, async (req, reply) => {
    if (!deps.ecrireGrillePrix) return reply.code(503).send({ error: 'grille de prix non disponible sur cette instance' });
    const corps = (req.body ?? {}) as { note?: unknown };
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui change le prix, et pourquoi' });
    const v = valideGrille(req.body);
    if (!v.ok) return reply.code(400).send({ error: `champ invalide : ${v.champ}`, champ: v.champ, bornes: BORNES_GRILLE });
    await deps.ecrireGrillePrix(v.grille, note);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_grille_prix', prix: v.grille, note, at: new Date().toISOString() }));
    return reply.code(200).send({ prix: v.grille });
  });
}
