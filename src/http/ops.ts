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
import { messageDe } from '../lib/erreur';

/**
 * Surface d'exploitation entre espaces, en lecture sauf quelques écritures d'exploitation par nature.
 * 🔴 Aucune de ces écritures (solde, grille de prix, verrou, rejeu, dépôt de jeton, balayage du risque) ne doit
 * être accessible depuis un compte de la console : l'autorité est le jeton d'exploitation, jamais le JWT client
 * (sinon un client se rechargerait ou fixerait ses prix). Chacune exige une note, seule trace de qui et pourquoi,
 * le jeton étant partagé. La session d'observation n'émet qu'un jeton incapable d'écrire.
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
   * ne pourrions pas faire nos propres publicités. Le jeton est chiffré par le câblage et jamais renvoyé.
   */
  deposerJetonPub(tenantId: string, jeton: string, comptePubId: string, pageId: string): Promise<ConnexionPubDeposee>;

  exploitation: ExploitationOps;
  /**
   * Les compteurs d'usage de l'API publique ; absent -> `/ops/usage` rend une liste vide. Optionnel ici (les tests
   * montent `/ops` sans usage), obligatoire sur les routes `/v1`, où l'oublier perdrait une mesure en silence.
   */
  usage?: { compteurs(): unknown[] };
  /** La grille de prix globale. */
  lireGrillePrix(): Promise<GrillePrix>;
  reglages: {
    /** `par` = la note : le jeton d'exploitation est partagé, c'est la seule trace de qui a changé un prix. */
    setGrillePrixGlobale(grille: GrillePrix, par: string): Promise<void>;
  };
  /**
   * Pose ou retire le verrou d'un espace (`tenants.status`). Rend `false` si l'espace est inconnu. La note n'est
   * pas conservée en base : le pourquoi vit dans la ligne `ops_verrou_espace` que la route écrit.
   */
  verrouillerEspace(tenantId: string, verrouille: boolean, note: string): Promise<boolean>;
  /**
   * Ouvre une session d'observation dans l'espace d'un client : rend un jeton de session en lecture seule.
   */
  observerTenant(tenantId: string): Promise<{ token: string; tenantName: string } | null>;
  /** Ré-enfile un job dans sa file d'origine. Doit être la même file que celle des jobs vivants. */
  file: { enqueue(queue: string, data: unknown): Promise<unknown> };
  /** Signal de vie du worker. `null` -> `worker: null` dans le payload. Distinct des files (queues) : prouve que
  *  le process worker vit, pas que les files se vident. */
  heartbeat: { get(): Promise<WorkerHeartbeatRow | null> };
  /**
   * Le solde prépayé d'un espace, en micro-euros, avec son journal. `null` = espace inconnu, distinct de zéro :
   * un opérateur qui lirait 0 sur un identifiant mal tapé rechargerait un espace qui n'existe pas.
   */
  soldeAgent(tenantId: string): Promise<{ soldeMicroEur: number; mouvements: unknown[] } | null>;
  /** Recharge le solde. Rend le nouveau solde, ou `null` si l'espace est inconnu. */
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
  /**
   * Lance le balayage du risque de désengagement d'un espace, tout de suite. Rend son bilan, ou `null` si
   * l'espace est inconnu.
   */
  balayerRisque(tenantId: string): Promise<BilanRisque | null>;
  /**
   * Réinitialise le second facteur d'une personne, par son adresse : son identité et le nombre d'espaces où elle a
   * un compte, ou `null` si l'adresse est inconnue. 🔴 Seul chemin pour une personne présente dans plusieurs
   * espaces (un admin d'espace n'affaiblit pas un compte chez un autre client). Le câblage écrit
   * `mfa.reinitialise` dans chacun de ses espaces, sans acteur.
   */
  reinitialiserMfa(email: string): Promise<{ identityId: string; espaces: number } | null>;
}

/**
 * Routes `/ops`, protégées par `x-ops-token` == `opsToken` (comparaison en temps constant) ; `opsToken` vide =
 * tout répond 401. 🔴 Autorité séparée du JWT d'espace : `req.auth` n'est jamais lu.
 */
/** Plafond d'une recharge : 1000 euros. Une virgule mal placée ne doit pas passer en silence, et il
*  n'existe aucune route de débit pour la rattraper. */
const MAX_RECHARGE_MICRO_EUR = 1_000_000_000;

/** Longueur minimale de la note d'une écriture d'exploitation : elle empêche de passer la garde avec un espace.
*  Sert à toutes les écritures de `/ops`, et le réglage du plafond de l'API l'importe (`ops-plafond-api.ts`). */
export const MIN_NOTE = 3;

/** Plafond d'un rejeu en une fois. Rejouer mille traitements d'un coup sur une cause non corrigée, c'est
 *  refaire mille fois la même erreur : on borne pour forcer à regarder entre deux lots. */
const MAX_REJEU = 100;

export function registerOps(
  app: FastifyInstance,
  deps: OpsRouteDeps,
  opsToken: string,
  /**
   * Surveillance des refus ; absente, le 401 part sans trace. Optionnelle (les tests montent `/ops` sans canal
   * d'alerte) : une surveillance manquante ne doit jamais empêcher la garde de fonctionner.
   */
  surveillance?: SurveillanceOps,
): void {
  const opts = { preHandler: makeRequireOps(opsToken, surveillance) };

  /**
   * L'usage de l'API publique, agrégé par minute : qui consomme quoi, pour arbitrer un jour un seuil sur des
   * chiffres. En observation : ces compteurs ne refusent rien. Lus en mémoire et non en base (une ligne SQL par
   * requête amplifierait la charge observée) : ils décrivent ce process, deux instances en verraient deux moitiés.
   */
  app.get('/ops/usage', opts, async (_req, reply) => {
    return reply.code(200).send({ compteurs: deps.usage ? deps.usage.compteurs() : [] });
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
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui verrouille, et pourquoi' });

    const fait = await deps.verrouillerEspace(tenantId, corps.verrouille, note);
    if (!fait) return reply.code(404).send({ error: 'espace inconnu' });
    journaliser('warn', 'ops_verrou_espace', { tenantId, verrouille: corps.verrouille, note, at: new Date().toISOString() });
    return reply.code(200).send({ tenantId, verrouille: corps.verrouille });
  });

  app.get('/ops/overview', opts, async (_req, reply) => {
    const [tenants, daily, queues, worker, queuesParGroupe, attentesPool, latences] = await Promise.all([
      deps.exploitation.getTenantOverview(),
      deps.exploitation.getGlobalDaily(14),
      deps.exploitation.getQueueLoad(),
      deps.heartbeat.get(),
      // Au mieux : une lecture d'équité en échec ne doit pas priver l'exploitation du reste de l'écran. Elle sert à
      // voir, elle ne garantit rien.
      deps.exploitation.getQueueLoadParGroupe().catch(() => []),
      // Même doctrine : la table peut ne pas exister encore, et l'écran d'exploitation ne doit pas tomber un jour de
      // déploiement.
      deps.attentesPool.lireDernieresMinutes(180).catch(() => []),
      // Fenêtre de 24 h : assez longue pour que le p95 ait un sens, assez courte pour qu'il décrive aujourd'hui.
      // Sur sept jours, un incident d'il y a six jours tiendrait encore le chiffre.
      deps.exploitation.getQueueLatence(24).catch(() => []),
    ]);
    const poolInstantane = deps.etatPoolInstantane();
    return reply.code(200).send({ tenants, daily, queues, worker, queuesParGroupe, poolInstantane, attentesPool, latences });
  });

  /**
   * Entrer dans l'espace d'un client pour voir ce qu'il voit (`/ops/observe`), par le jeton d'exploitation : jeton
   * rendu en lecture seule, qui ne marque rien comme lu. 🔴 Invisible côté client, journalisé côté exploitation.
   */
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
    return reply.code(200).send({ rejoues: rejoues.length, oublies });
  });

  app.post('/ops/observe', opts, async (req, reply) => {
    const tenantId = (req.body as { tenantId?: unknown } | null)?.tenantId;
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      return reply.code(400).send({ error: 'tenantId requis' });
    }
    // Même raison que sur `/ops/credits` : un identifiant mal formé fait lever Postgres (`22P02`) au lieu de
    // rendre zéro ligne, donc un 500.
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const r = await deps.observerTenant(tenantId);
    if (!r) return reply.code(404).send({ error: 'espace inconnu' });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_observation', tenantId, tenantName: r.tenantName, at: new Date().toISOString() }));
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
   * Révoquer la clé de modèle d'un espace. `DELETE` : c'est une suppression. Journalisé en `warn` : le jeton est
   * partagé, cette ligne est la seule trace d'un geste irréversible.
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
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui dépose ce jeton, et pourquoi' });
    let depose: ConnexionPubDeposee;
    try {
      depose = await deps.deposerJetonPub(tenantId, jeton, comptePubId, pageId);
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : 'jeton refusé' });
    }
    // `journaliser`, pas un `console.log` recopié : le helper envoie un `warn` sur stderr.
    journaliser('warn', 'ops_jeton_pub_depose', {
      tenantId, comptePubId: depose.comptePubId, pageId: depose.pageId,
      ancienRevoque: depose.ancienRevoque, note, at: new Date().toISOString(),
    });
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
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui lance le balayage, et pourquoi' });
    const bilan = await deps.balayerRisque(tenantId);
    if (bilan === null) return reply.code(404).send({ error: 'espace inconnu' });
    journaliser('warn', 'ops_balayage_risque', { ...bilan, note, at: new Date().toISOString() });
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
   * sont celles des CHECK en base (`valideGrille`, `BORNES_GRILLE`). 🔴 Note obligatoire : seule trace de qui a
   * changé un prix, le jeton étant partagé.
   */
  app.patch('/ops/prix', opts, async (req, reply) => {
    const corps = (req.body ?? {}) as { note?: unknown };
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui change le prix, et pourquoi' });
    const v = valideGrille(req.body);
    if (!v.ok) return reply.code(400).send({ error: `champ invalide : ${v.champ}`, champ: v.champ, bornes: BORNES_GRILLE });
    await deps.reglages.setGrillePrixGlobale(v.grille, note);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_grille_prix', prix: v.grille, note, at: new Date().toISOString() }));
    return reply.code(200).send({ prix: v.grille });
  });

  /**
   * Réinitialiser le second facteur d'une personne qui a perdu son téléphone et ses codes. L'adresse voyage dans
   * le corps, jamais dans l'adresse de la route (journaux d'accès). Note obligatoire ; la ligne de journal porte
   * l'identité, pas l'adresse.
   */
  app.post('/ops/mfa/reinitialiser', opts, async (req, reply) => {
    const corps = (req.body ?? {}) as { email?: unknown; note?: unknown };
    const email = typeof corps.email === 'string' ? corps.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return reply.code(400).send({ error: 'email requis' });
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui réinitialise, et pourquoi' });
    const fait = await deps.reinitialiserMfa(email);
    if (!fait) return reply.code(404).send({ error: 'adresse inconnue' });
    journaliser('warn', 'ops_mfa_reinitialise', { identityId: fait.identityId, espaces: fait.espaces, note, at: new Date().toISOString() });
    return reply.code(200).send({ reinitialise: true, espaces: fait.espaces });
  });
}
