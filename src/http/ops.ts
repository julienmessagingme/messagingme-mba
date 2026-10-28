import type { FastifyInstance } from 'fastify';
import { auteurOps, type PreHandler } from '../auth/middleware';
import { estUuid } from './scope';
import { valideGrille, BORNES_GRILLE, type GrillePrix } from '../stats/prix';
import { journaliser } from '../lib/journal';
import type { SortAncienAcces } from '../meta/pubs';
import type { TenantOverviewRow, QueueLoadRow, QueueGroupLoadRow, QueueLatenceRow, GlobalDailyPoint, JobMortRow } from '../ops/store.pg';
import type { WorkerHeartbeatRow } from '../ops/heartbeat-store.pg';
import type { TacheMesureRow } from '../ops/mesure-taches';
import type { MesureStockage } from '../ops/stockage.pg';
import type { ConsommationEquipe } from '../agent/llm/consommation-equipe';
import type { LatenceHttpRow } from '../ops/latence-http';
import type { BilanRisque } from '../engagement/balayage';
import { dlqName, seuilLatenceSecondes } from '../queue/names';
import { z } from 'zod';
import { evaluerSante, SEUILS_SANTE } from '../ops/sante';
import type { PointCapaciteHeure } from '../ops/pool-attentes.pg';
import type { PointFileHeure } from '../ops/mesures-files.pg';
import type { MemoireWorker, PointMemoireHeure } from '../ops/memoire-workers.pg';
import type { LecteurCockpit } from '../ops/cockpit';
import { messageDe } from '../lib/erreur';
import { makeTraceOps, type AuditSink } from '../audit/journal';

/**
 * Surface d'exploitation entre espaces, en lecture sauf quelques écritures d'exploitation par nature.
 * 🔴 Aucune de ces écritures (solde, grille de prix, verrou, rejeu, dépôt de jeton, balayage du risque) ne doit
 * être accessible depuis un compte de la console : l'autorité est la session d'exploitation nominative
 * (`makeRequireOps`), jamais une session d'espace (sinon un client se rechargerait ou fixerait ses prix).
 * Chaque écriture signe sa ligne de journal de l'adresse de son auteur (`par`, lue par `auteurOps`) ; celles qui
 * l'avaient gardent leur note obligatoire, qui dit POURQUOI. La session d'observation n'émet qu'un jeton incapable
 * d'écrire, qui porte l'adresse de l'observateur.
 */
/**
 * Ce qui est arrivé à l'ancien jeton quand un dépôt le remplace (un jeton d'utilisateur système n'expire jamais).
 * Alias de `SortAncienAcces`, où la décision se prend ; ici, le geste à faire :
 * - `aucun` : pas de connexion, rien à faire ;
 * - `retire` : l'ancien portait une autre entité Meta, ses permissions ont été retirées ;
 * - `meme_entite` : même utilisateur système, rien retiré (`DELETE /me/permissions` désarmerait aussi le neuf) ;
 *   l'ancienne chaîne reste valide, la tuer demande de régénérer le jeton chez Meta ;
 * - `indetermine` : Meta n'a pas dit qui portait l'un des jetons, rien retiré (même geste si besoin) ;
 * - `echec` : le retrait a été refusé, un accès reste vivant : retirer à la main les permissions publicitaires
 *   (jamais l'application, qui porte le numéro WhatsApp).
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

/** Les lectures et gestes d'exploitation cross-espace. */
export interface ExploitationOps {
  getTenantOverview(): Promise<TenantOverviewRow[]>;
  getGlobalDaily(days: number): Promise<GlobalDailyPoint[]>;
  getQueueLoad(): Promise<QueueLoadRow[]>;
  /**
   * Les groupes qui attendent le plus (équité). Vide quand rien n'attend. Lecture de confort : son échec rend
   * `queuesParGroupe: []` et ne fait rien échouer.
   */
  getQueueLoadParGroupe(): Promise<QueueGroupLoadRow[]>;
  /**
   * La latence réelle par file sur une fenêtre (le p95 que la jauge d'âge ne donne pas). Au mieux : elle sert à
   * voir, et l'écran ne tombe pas si elle échoue.
   */
  getQueueLatence(fenetreHeures: number): Promise<QueueLatenceRow[]>;
  /**
   * Les jobs morts (file d'échec), les plus anciens d'abord. Lecture pure. 🔴 Pour un `webhook`, un job mort est
   * un message de client jamais traité, en silence.
   */
  listerJobsMorts(limite: number): Promise<JobMortRow[]>;
  /** Retire de la file d'échec les jobs ré-enfilés. Appelée après l'enfilement, jamais avant. */
  oublierJobsMorts(ids: string[]): Promise<number>;
}

export interface OpsRouteDeps {
  /**
   * Déposer un jeton publicitaire créé à la main. Le parcours de l'écran Publicités ne peut pas servir le
   * portefeuille Meta qui possède notre application (Meta exige un portefeuille distinct) : sans cette porte, nous
   * ne pourrions pas faire nos propres publicités. Le jeton est chiffré par `src/pubs/connexion.ts` et jamais renvoyé.
   */
  deposerJetonPub(tenantId: string, jeton: string, comptePubId: string, pageId: string): Promise<ConnexionPubDeposee>;

  exploitation: ExploitationOps;
  /**
   * Les compteurs d'usage de l'API publique ; absent -> `/ops/usage` rend une liste vide. Optionnel ici (les tests
   * montent `/ops` sans usage), obligatoire sur les routes `/v1`, où l'oublier perdrait une mesure en silence.
   */
  usage?: { compteurs(): Promise<unknown[]> };
  /** La grille de prix globale. */
  lireGrillePrix(): Promise<GrillePrix>;
  reglages: {
    /** `par` = la note signée (`noteSignee`) : qui a changé le prix, et pourquoi, gardés avec la grille. */
    setGrillePrixGlobale(grille: GrillePrix, par: string): Promise<void>;
  };
  /**
   * Pose ou retire le verrou d'un espace (`tenants.status`). Rend `false` si l'espace est inconnu. La note n'est
   * pas conservée en base : le pourquoi vit dans la ligne `ops_verrou_espace` que la route écrit.
   */
  verrouillerEspace(tenantId: string, verrouille: boolean, note: string): Promise<boolean>;
  /**
   * Ouvre une session d'observation dans l'espace d'un client : rend un jeton de session en lecture seule, qui
   * porte l'adresse de l'observateur.
   */
  observerTenant(tenantId: string, observateur: string): Promise<{ token: string; tenantName: string } | null>;
  /** Ré-enfile un job dans sa file d'origine. Doit être la même file que celle des jobs vivants. */
  file: { enqueue(queue: string, data: unknown): Promise<unknown> };
  /** Signal de vie du worker. `null` -> `worker: null` dans le payload. Distinct des files (queues) : prouve que
  *  le process worker vit, pas que les files se vident. */
  heartbeat: { lister(): Promise<WorkerHeartbeatRow[]> };
  /**
   * Le solde prépayé d'un espace, en micro-euros, avec son journal. `null` = espace inconnu, distinct de zéro :
   * un opérateur qui lirait 0 sur un identifiant mal tapé rechargerait un espace qui n'existe pas.
   */
  soldeAgent(tenantId: string): Promise<{ soldeMicroEur: number; mouvements: unknown[] } | null>;
  /**
   * Recharge le solde. Rend le nouveau solde, ou `null` si l'espace est inconnu. `note` est signée
   * (`noteSignee`) : le journal des mouvements garde qui a rechargé.
   */
  rechargerAgent(tenantId: string, montantMicroEur: number, note: string): Promise<number | null>;
  /**
   * Révoque la clé de modèle d'un espace, chez Vercel puis chez nous. 🔴 À faire avant de supprimer un espace :
   * `agent_gateway_keys.tenant_id` est en `on delete cascade`, et sans révocation la clé survivrait chez Vercel,
   * facturable et irrévocable. `false` = l'espace n'avait pas de clé (cas fréquent, pas une erreur).
   */
  revoquerCleModele?(tenantId: string): Promise<boolean>;
  /**
   * L'attente du pool de connexions : l'état instantané du pool de ce process (l'API), et la courbe agrégée par
   * minute lue en base, seul canal par lequel le worker se montre. Au mieux : une lecture en échec laisse la
   * carte vide.
   */
  etatPoolInstantane(): { process: string; total: number; libres: number; enAttente: number; max: number; maxMsDepuisDemarrage: number };
  attentesPool: { lireDernieresMinutes(minutes: number): Promise<unknown[]> };
  /** La latence HTTP par route normalisée et code de retour, toutes copies confondues. Au mieux, comme le pool. */
  latencesHttp: { lire(heures: number): Promise<LatenceHttpRow[]> };
  /** La durée et les lignes des tâches de fond des workers (migration 0207). Au mieux, comme la latence. */
  mesuresTaches: { lire(heures: number): Promise<TacheMesureRow[]> };
  /** Les deux lectures propres à l'onglet Santé (refonte de /ops, lot 1). Au mieux, comme le pool. */
  sante: {
    connexionsBase(): Promise<{ utilisees: number; max: number }>;
    signauxMeta(): Promise<{ dernierMessage: string | null; dernierAccuse: string | null }>;
    /** Le dernier relevé de mémoire de chaque worker (lot 2), frais seulement. */
    memoires(): Promise<MemoireWorker[]>;
  };
  /** L'onglet Capacité : l'historique heure par heure du pool, des copies d'API, des files et de la mémoire des workers. Au mieux. */
  capacite: {
    parHeure(jours: number): Promise<PointCapaciteHeure[]>;
    files(jours: number): Promise<PointFileHeure[]>;
    memoires(jours: number): Promise<PointMemoireHeure[]>;
  };
  /** Cockpit, l'outil de mesure de Scaleway (lot 2) : `null` tant que `COCKPIT_TOKEN` n'est pas posé. */
  cockpit: LecteurCockpit | null;
  /**
   * Les octets en base, fichiers compris. Coûteux (le catalogue entier) : servi par sa propre route, jamais par
   * la vue d'ensemble, que l'écran recharge à chaque ouverture et sur demande.
   */
  stockage: { mesurer(): Promise<MesureStockage> };
  /**
   * Le budget d'équipe de la passerelle d'IA chez Vercel (lot 14) : lu chez Vercel à chaque ouverture de sa carte, jamais
   * par la vue d'ensemble. `null` = jeton de compte non configuré.
   */
  vercel: { lire(): Promise<ConsommationEquipe | null> };
  /**
   * Lance le balayage du risque de désengagement d'un espace, tout de suite. Rend son bilan, ou `null` si
   * l'espace est inconnu.
   */
  balayerRisque(tenantId: string): Promise<BilanRisque | null>;
  /**
   * Réinitialise le second facteur d'une personne, par son adresse : son identité et le nombre d'espaces où elle a
   * un compte, ou `null` si l'adresse est inconnue. 🔴 Seul chemin pour une personne présente dans plusieurs
   * espaces (un admin d'espace n'affaiblit pas un compte chez un autre client). Le câblage écrit
   * `mfa.reinitialise` dans chacun de ses espaces, avec l'adresse de l'exploitant (`par`) pour acteur.
   */
  reinitialiserMfa(email: string, par: string): Promise<{ identityId: string; espaces: number } | null>;
  /**
   * Le journal des actions de l'espace touché (lot 5) : chaque geste d'exploitation sur un espace y laisse sa ligne,
   * l'adresse de l'exploitant pour acteur, sans la note (`makeTraceOps`).
   */
  audit: AuditSink;
}

/**
 * La note d'une écriture, signée de son auteur : ce qui se garde en base (grille de prix, mouvement de crédit)
 * dit ensemble qui et pourquoi, dans les colonnes qui portaient déjà la note.
 */
export function noteSignee(auteur: string, note: string): string {
  return `${auteur} : ${note}`;
}

/** Plafond d'une recharge : 1000 euros. Une virgule mal placée ne doit pas passer en silence, et il
*  n'existe aucune route de débit pour la rattraper. */
const MAX_RECHARGE_MICRO_EUR = 1_000_000_000;

/** Longueur minimale de la note d'une écriture d'exploitation : elle empêche de passer la garde avec un espace.
*  Sert à toutes les écritures de `/ops`, et le réglage du plafond de l'API l'importe (`ops-plafond-api.ts`). */
export const MIN_NOTE = 3;

/** Plafond d'un rejeu en une fois. Rejouer mille traitements d'un coup sur une cause non corrigée, c'est
 *  refaire mille fois la même erreur : on borne pour forcer à regarder entre deux lots. */
const MAX_REJEU = 100;

/**
 * Routes `/ops`, derrière `garde` : la garde d'exploitation (`makeRequireOps`, construite une fois par
 * `buildServer`). 🔴 Autorité séparée de la session d'espace : `req.auth` n'est jamais lu, l'auteur d'une
 * écriture se lit par `auteurOps`.
 */
export function registerOps(app: FastifyInstance, deps: OpsRouteDeps, garde: PreHandler): void {
  const opts = { preHandler: garde };
  const tracer = makeTraceOps(deps.audit);

  /**
   * L'usage de l'API publique, agrégé par minute : qui consomme quoi, pour arbitrer un jour un seuil sur des
   * chiffres. En observation : ces compteurs ne refusent rien. Lus dans le compteur partagé (lot B, 2026-09-28) :
   * c'est le TOTAL de toutes les copies de l'API, et non plus la moitié que voyait la copie interrogée. Leur coût,
   * une écriture par appel accepté, est borné par le plafond de l'espace.
   */
  app.get('/ops/usage', opts, async (_req, reply) => {
    return reply.code(200).send({ compteurs: deps.usage ? await deps.usage.compteurs() : [] });
  });

  /**
   * L'arrêt d'urgence d'un espace. 🔴 Il ferme les portes (console, `/v1` et `/mcp`), pas les campagnes déjà
   * enfilées, en vol dans le worker : `DEPLOY.md` dit comment les mettre en pause, sinon les messages continuent
   * de partir. Note exigée.
   */
  app.post('/ops/verrou/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const corps = (req.body ?? {}) as { verrouille?: unknown; note?: unknown };
    if (typeof corps.verrouille !== 'boolean') return reply.code(400).send({ error: 'verrouille (booléen) requis' });
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi ce verrou' });

    const fait = await deps.verrouillerEspace(tenantId, corps.verrouille, note);
    if (!fait) return reply.code(404).send({ error: 'espace inconnu' });
    journaliser('warn', 'ops_verrou_espace', { tenantId, verrouille: corps.verrouille, par: auteurOps(req), note, at: new Date().toISOString() });
    await tracer(tenantId, auteurOps(req), 'ops.verrou', { verrouille: corps.verrouille });
    return reply.code(200).send({ tenantId, verrouille: corps.verrouille });
  });

  app.get('/ops/overview', opts, async (_req, reply) => {
    const [tenants, daily, queues, workers, queuesParGroupe, attentesPool, latences, latencesHttp, tachesFond] = await Promise.all([
      deps.exploitation.getTenantOverview(),
      deps.exploitation.getGlobalDaily(14),
      deps.exploitation.getQueueLoad(),
      deps.heartbeat.lister(),
      // Au mieux : une lecture d'équité en échec ne doit pas priver l'exploitation du reste de l'écran. Elle sert à
      // voir, elle ne garantit rien.
      deps.exploitation.getQueueLoadParGroupe().catch(() => []),
      // Même doctrine : la table peut ne pas exister encore, et l'écran d'exploitation ne doit pas tomber un jour de
      // déploiement.
      deps.attentesPool.lireDernieresMinutes(180).catch(() => []),
      // Fenêtre de 24 h : assez longue pour que le p95 ait un sens, assez courte pour qu'il décrive aujourd'hui.
      // Sur sept jours, un incident d'il y a six jours tiendrait encore le chiffre.
      deps.exploitation.getQueueLatence(24).catch(() => []),
      // La même fenêtre que les files, et la même doctrine : table absente ou lecture en échec, la carte reste vide.
      deps.latencesHttp.lire(24).catch(() => []),
      // Les tâches de fond, même fenêtre, même doctrine.
      deps.mesuresTaches.lire(24).catch(() => []),
    ]);
    const poolInstantane = deps.etatPoolInstantane();
    return reply.code(200).send({
      tenants, daily, queues, workers, queuesParGroupe, poolInstantane, attentesPool,
      // Chaque ligne porte SON seuil (`seuilLatenceSecondes`) : l'écran ne tient aucune liste de files.
      latences: latences.map((l) => ({ ...l, seuilSecondes: seuilLatenceSecondes(l.queue) })),
      latencesHttp, tachesFond,
      // La révision de CETTE copie de l'API, posée à la construction de l'image (`Dockerfile`, `ARG REVISION`).
      revision: process.env.REVISION || 'inconnue',
    });
  });

  /**
   * L'onglet Santé (refonte de /ops, lot 1) : une pastille par brique, jugée par `evaluerSante`, la jauge de capacité,
   * les derniers signaux de Meta et les incidents des 24 h. Chaque lecture est au mieux : une mesure en échec laisse
   * sa brique sans valeur, jamais l'écran vide. Les seuils partent avec la réponse : l'écran n'en tient aucun.
   */
  app.get('/ops/sante', opts, async (_req, reply) => {
    // Une lecture en échec rend `null`, jamais une liste vide : sous saturation, « illisible » n'est pas « aucun trafic ».
    const auMieux = <T>(lecture: Promise<T>): Promise<T | null> => lecture.catch(() => null);
    const [workers, latencesFiles, chargeFiles, latencesHeure, latences24h, connexions, meta, memoires, mesuresCockpit] = await Promise.all([
      auMieux(deps.heartbeat.lister()),
      // Le dernier quart d'heure : un pic résolu ne garde pas la pastille rouge une heure.
      auMieux(deps.exploitation.getQueueLatence(0.25)),
      auMieux(deps.exploitation.getQueueLoad()),
      auMieux(deps.latencesHttp.lire(1)),
      deps.latencesHttp.lire(24).catch(() => []),
      auMieux(deps.sante.connexionsBase()),
      deps.sante.signauxMeta().catch(() => ({ dernierMessage: null, dernierAccuse: null })),
      auMieux(deps.sante.memoires()),
      deps.cockpit ? deps.cockpit.mesures().catch(() => null) : Promise.resolve(null),
    ]);
    const cockpit = deps.cockpit ? { configure: true as const, mesures: mesuresCockpit } : { configure: false as const };
    const bilan = evaluerSante({ workers, latencesFiles, chargeFiles, latencesHttp: latencesHeure, connexions, memoires, cockpit });
    const ilYa24h = Date.now() - 24 * 3600 * 1000;
    const charge = chargeFiles ?? [];
    const estDlq = (q: string): boolean => charge.some((c) => dlqName(c.queue) === q);
    return reply.code(200).send({
      ...bilan,
      // L'onglet Santé ne charge pas la vue d'ensemble : il lit la révision ici.
      revision: process.env.REVISION || 'inconnue',
      connexions,
      meta,
      incidents: {
        erreurs5xx: latences24h.filter((l) => l.code >= 500).reduce((s, l) => s + l.requetes, 0),
        // Les jobs en échec que pg-boss garde encore (sept jours, `deleteAfterSeconds`), pas ceux des 24 h ; la copie
        // d'un job mort dans sa file d'échec y compte aussi. Les clés gardent leur nom pour la console déjà publiée.
        tachesEnEchec: charge.filter((c) => !estDlq(c.queue)).reduce((s, c) => s + c.failed, 0),
        fileEchec: charge.filter((c) => estDlq(c.queue)).reduce((s, c) => s + c.backlog, 0),
        // Un démarrage récent : un déploiement ou un redémarrage, que l'écran ne sait pas distinguer.
        demarrages: (workers ?? [])
          .filter((w) => w.bootedAt !== null && Date.parse(w.bootedAt) > ilYa24h)
          .map((w) => ({ role: w.role, demarreLe: w.bootedAt })),
      },
      seuils: SEUILS_SANTE,
    });
  });

  /** L'onglet Capacité : trente jours au plus (la rétention des mesures), heure par heure. */
  const requeteCapacite = z.object({ jours: z.coerce.number().int().min(1).max(30).default(30) });
  app.get('/ops/capacite', opts, async (req, reply) => {
    const lu = requeteCapacite.safeParse(req.query ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'jours : un entier de 1 à 30' });
    const { jours } = lu.data;
    const [heures, files, memoires, series] = await Promise.all([
      deps.capacite.parHeure(jours).catch(() => []),
      deps.capacite.files(jours).catch(() => []),
      deps.capacite.memoires(jours).catch(() => []),
      deps.cockpit ? deps.cockpit.historique(jours).catch(() => null) : Promise.resolve(null),
    ]);
    // Cockpit : `series` vaut `null` quand il n'a rien rendu ; l'écran le dit (« mesure indisponible »).
    const cockpit = deps.cockpit ? { configure: true, series } : { configure: false };
    return reply.code(200).send({ jours, heures, files, memoires, cockpit, seuils: SEUILS_SANTE });
  });

  /** Les octets en base : lus une fois à l'ouverture de l'écran, pas à chaque chargement de la vue d'ensemble (voir `PgStockageStore`). */
  app.get('/ops/stockage', opts, async (_req, reply) => reply.code(200).send(await deps.stockage.mesurer()));

  /** La jauge du budget d'équipe Vercel. Une lecture en échec rend 502 et son message, qui ne porte jamais le corps. */
  app.get('/ops/vercel', opts, async (_req, reply) => {
    try {
      const c = await deps.vercel.lire();
      return reply.code(200).send(c === null ? { configure: false } : { configure: true, ...c });
    } catch (err) {
      journaliser('warn', 'ops_vercel_illisible', { err });
      return reply.code(502).send({ error: messageDe(err) });
    }
  });

  /**
   * Les jobs morts : les voir, puis décider de les rejouer. Un job qui épuise ses rejeux part en file d'échec, que
   * rien ne consomme ; rejouer est un geste d'exploitation, qui suppose la cause corrigée. La lecture d'abord :
   * rejouer sans regarder relancerait en masse des échecs non corrigés.
   */
  app.get('/ops/dlq', opts, async (req, reply) => {
    const brut = (req.query as { limit?: unknown }).limit;
    const limite = typeof brut === 'string' && /^\d+$/.test(brut) ? Number(brut) : 50;
    return reply.code(200).send({ jobs: await deps.exploitation.listerJobsMorts(limite) });
  });

  app.post('/ops/dlq/replay', opts, async (req, reply) => {
    const b = (req.body ?? {}) as { queue?: unknown; limit?: unknown };
    // La file est obligatoire : un rejeu « tout » relancerait des campagnes et des webhooks d'un coup, sur des
    // causes d'échec différentes qu'on n'a pas toutes corrigées.
    if (typeof b.queue !== 'string' || b.queue.trim() === '') {
      return reply.code(400).send({ error: 'queue requise (la file d’origine, ex. « webhook »)' });
    }
    const queue = b.queue.trim();
    const limite = typeof b.limit === 'number' && Number.isFinite(b.limit) ? Math.trunc(b.limit) : 10;
    if (limite < 1 || limite > MAX_REJEU) {
      return reply.code(400).send({ error: `limit entre 1 et ${MAX_REJEU}` });
    }
    const morts = (await deps.exploitation.listerJobsMorts(200)).filter((j) => j.queue === queue).slice(0, limite);
    if (morts.length === 0) return reply.code(200).send({ rejoues: 0, oublies: 0 });

    // 🔴 Enfiler puis oublier : un crash entre les deux produit un doublon, l'ordre inverse une perte. Le doublon
    // est rattrapé partout où ça compte (déduplication de l'entrant, claim atomique d'un destinataire, verrou de
    // run), la perte nulle part.
    const rejoues: string[] = [];
    for (const j of morts) {
      try {
        await deps.file.enqueue(j.queue, j.data);
        rejoues.push(j.id);
      } catch (err) {
        // On s'arrête au premier échec d'enfilement plutôt que d'insister : si la file refuse, elle
        // refusera aussi les suivants, et ce qui a déjà été enfilé doit être oublié proprement.
        // eslint-disable-next-line no-console
        console.error(`ops dlq replay: enfilement impossible pour ${j.id}`, messageDe(err));
        break;
      }
    }
    const oublies = await deps.exploitation.oublierJobsMorts(rejoues);
    journaliser('warn', 'ops_dlq_rejeu', { queue, rejoues: rejoues.length, oublies, par: auteurOps(req), at: new Date().toISOString() });
    return reply.code(200).send({ rejoues: rejoues.length, oublies });
  });

  /**
   * Entrer dans l'espace d'un client pour voir ce qu'il voit : jeton rendu en lecture seule, qui ne marque rien
   * comme lu et porte l'adresse de l'observateur. 🔴 Visible du client dans son journal des actions (lot 5), et journalisé côté exploitation.
   */
  app.post('/ops/observe', opts, async (req, reply) => {
    const tenantId = (req.body as { tenantId?: unknown } | null)?.tenantId;
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      return reply.code(400).send({ error: 'tenantId requis' });
    }
    // Même raison que sur `/ops/credits` : un identifiant mal formé fait lever Postgres (`22P02`) au lieu de
    // rendre zéro ligne, donc un 500.
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const par = auteurOps(req);
    const r = await deps.observerTenant(tenantId, par);
    if (!r) return reply.code(404).send({ error: 'espace inconnu' });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_observation', tenantId, tenantName: r.tenantName, par, at: new Date().toISOString() }));
    // Le client voit que Messaging Me a regardé son espace : une observation ne modifie rien, elle se trace quand même.
    await tracer(tenantId, par, 'ops.espace_observe');
    return reply.code(200).send({ token: r.token, tenantId, tenantName: r.tenantName });
  });

  /** Le solde prépayé d'un workspace et son journal. Lecture, comme le reste de la surface. */
  app.get('/ops/credits/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    // Identifiant mal formé : 404, sinon Postgres lèverait `22P02` sur la colonne `uuid` (500).
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const r = await deps.soldeAgent(tenantId);
    if (!r) return reply.code(404).send({ error: 'espace inconnu' });
    return reply.code(200).send(r);
  });

  /**
   * Révoquer la clé de modèle d'un espace. `DELETE` : c'est une suppression. Journalisé en `warn`, avec son
   * auteur : cette ligne est la seule trace d'un geste irréversible.
   */
  app.delete('/ops/cle-modele/:tenantId', opts, async (req, reply) => {
    if (!deps.revoquerCleModele) return reply.code(503).send({ error: 'revocation non disponible sur cette instance' });
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    try {
      const revoquee = await deps.revoquerCleModele(tenantId);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_revoque_cle_modele', tenantId, revoquee, par: auteurOps(req), at: new Date().toISOString() }));
      // Rien n'est tracé sans clé révoquée : la ligne dirait le contraire de ce qui s'est passé.
      if (revoquee) await tracer(tenantId, auteurOps(req), 'ops.cle_modele_revoquee');
      return reply.code(200).send({ tenantId, revoquee });
    } catch (err) {
      // 4xx et jamais 5xx : Cloudflare remplacerait le corps, et l'opérateur doit savoir que la clé est toujours là
      // (donc qu'il faut réessayer) plutôt que de croire à un succès silencieux.
      journaliser('error', 'ops_revocation_impossible', { err, tenantId });
      return reply.code(422).send({ error: 'Vercel n’a pas confirmé la suppression ; la clé est toujours active, réessayez' });
    }
  });

  app.post('/ops/credits/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const corps = (req.body ?? {}) as { montantMicroEur?: unknown; note?: unknown };
    const montant = typeof corps.montantMicroEur === 'number' ? Math.round(corps.montantMicroEur) : NaN;
    if (!Number.isFinite(montant) || montant <= 0 || montant > MAX_RECHARGE_MICRO_EUR) {
      return reply.code(400).send({ error: `montantMicroEur requis, entre 1 et ${MAX_RECHARGE_MICRO_EUR} (soit 1000 euros)` });
    }
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi cette recharge' });
    const par = auteurOps(req);
    const solde = await deps.rechargerAgent(tenantId, montant, noteSignee(par, note));
    // Espace inconnu : sans cette garde, la clé étrangère lèverait et l'identifiant mal tapé rendrait un 500
    // remplacé par la page d'erreur de Cloudflare, sur la seule route qui écrit de l'argent.
    if (solde === null) return reply.code(404).send({ error: 'espace inconnu' });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_recharge_agent', tenantId, montantMicroEur: montant, soldeMicroEur: solde, par, note, at: new Date().toISOString() }));
    await tracer(tenantId, par, 'ops.credit_ajoute', { montantMicroEur: montant });
    return reply.code(200).send({ tenantId, soldeMicroEur: solde });
  });

  /**
   * Dépôt d'un jeton publicitaire d'utilisateur système. 🔴 Le jeton arrive dans le corps, une seule fois : ni
   * journalisé, ni renvoyé, écrit en base chiffré seulement ; la trace ne porte que les identifiants des actifs.
   * Il est vérifié chez Meta avant d'être gardé, par le même chemin que la connexion par l'écran.
   */
  app.post('/ops/pubs/connexion/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const corps = (req.body ?? {}) as { jeton?: unknown; comptePubId?: unknown; pageId?: unknown; note?: unknown };
    const jeton = typeof corps.jeton === 'string' ? corps.jeton.trim() : '';
    const comptePubId = typeof corps.comptePubId === 'string' ? corps.comptePubId.trim() : '';
    const pageId = typeof corps.pageId === 'string' ? corps.pageId.trim() : '';
    if (jeton.length < 20) return reply.code(400).send({ error: 'jeton requis' });
    if (comptePubId === '' || pageId === '') return reply.code(400).send({ error: 'comptePubId et pageId requis' });
    // Note obligatoire, comme les autres écritures de `/ops` : ce dépôt remplace la connexion publicitaire d'un
    // client.
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi ce dépôt' });
    let depose: ConnexionPubDeposee;
    try {
      depose = await deps.deposerJetonPub(tenantId, jeton, comptePubId, pageId);
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : 'jeton refusé' });
    }
    // `journaliser`, pas un `console.log` recopié : le helper envoie un `warn` sur stderr.
    journaliser('warn', 'ops_jeton_pub_depose', {
      tenantId, comptePubId: depose.comptePubId, pageId: depose.pageId,
      ancienRevoque: depose.ancienRevoque, par: auteurOps(req), note, at: new Date().toISOString(),
    });
    await tracer(tenantId, auteurOps(req), 'ops.pub_connectee', { comptePubId: depose.comptePubId, pageId: depose.pageId });
    return reply.code(200).send({ tenantId, connexion: depose });
  });

  /**
   * Le balayage du risque de désengagement, à la demande, pour un espace : celui de la nuit, lancé maintenant. Il
   * écrit le risque des fiches, émet les signaux et peut déclencher les automations « risque élevé » ; rejoué, il
   * ne redéclenche rien. Plafond partagé avec la nuit : 200 par jour (Paris) et par espace (`dejaDeclenches`), et
   * l'automation part à l'ouverture de l'espace (`departLe`). Note exigée. Il tourne dans la requête ; un espace
   * verrouillé n'est pas sauté ici, contrairement à la nuit.
   */
  app.post('/ops/risque/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const corps = (req.body ?? {}) as { note?: unknown };
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi ce balayage' });
    const bilan = await deps.balayerRisque(tenantId);
    if (bilan === null) return reply.code(404).send({ error: 'espace inconnu' });
    journaliser('warn', 'ops_balayage_risque', { ...bilan, par: auteurOps(req), note, at: new Date().toISOString() });
    await tracer(tenantId, auteurOps(req), 'ops.risque_balaye', { evalues: bilan.evalues, transitions: bilan.transitions, declenches: bilan.declenches });
    return reply.code(200).send({ bilan });
  });

  /**
   * La grille de prix, une pour tous les espaces : pas de `:tenantId`, un prix n'est pas négociable client par
   * client.
   */
  app.get('/ops/prix', opts, async (_req, reply) => {
    return reply.code(200).send({ prix: await deps.lireGrillePrix(), bornes: BORNES_GRILLE });
  });

  /**
   * Changer la grille. Les six champs d'un coup, et la validation refuse au lieu de corriger (ramener une valeur
   * dans les bornes enregistrerait un prix que personne n'a choisi) ; la réponse nomme le champ fautif. Les bornes
   * sont celles des CHECK en base (`valideGrille`, `BORNES_GRILLE`). 🔴 Note obligatoire : elle dit pourquoi, et
   * part signée de son auteur dans `grille_prix.modifie_par`.
   */
  app.patch('/ops/prix', opts, async (req, reply) => {
    const corps = (req.body ?? {}) as { note?: unknown };
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi ce changement de prix' });
    const v = valideGrille(req.body);
    if (!v.ok) return reply.code(400).send({ error: `champ invalide : ${v.champ}`, champ: v.champ, bornes: BORNES_GRILLE });
    const par = auteurOps(req);
    await deps.reglages.setGrillePrixGlobale(v.grille, noteSignee(par, note));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_grille_prix', prix: v.grille, par, note, at: new Date().toISOString() }));
    return reply.code(200).send({ prix: v.grille });
  });

  /**
   * Réinitialiser le second facteur d'une personne qui a perdu son téléphone et ses codes. L'adresse voyage dans
   * le corps, jamais dans l'adresse de la route (journaux d'accès). Note obligatoire ; la ligne de journal porte
   * l'identité de la personne, pas son adresse, et l'adresse de l'exploitant qui a agi (`par`).
   */
  app.post('/ops/mfa/reinitialiser', opts, async (req, reply) => {
    const corps = (req.body ?? {}) as { email?: unknown; note?: unknown };
    const email = typeof corps.email === 'string' ? corps.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return reply.code(400).send({ error: 'email requis' });
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi cette réinitialisation' });
    const par = auteurOps(req);
    const fait = await deps.reinitialiserMfa(email, par);
    if (!fait) return reply.code(404).send({ error: 'adresse inconnue' });
    journaliser('warn', 'ops_mfa_reinitialise', { identityId: fait.identityId, espaces: fait.espaces, par, note, at: new Date().toISOString() });
    return reply.code(200).send({ reinitialise: true, espaces: fait.espaces });
  });
}
