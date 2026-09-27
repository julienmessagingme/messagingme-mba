import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidNonAdmin, gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { sansPrefixeAct, type ActifsAccordes, type EtatComptePub } from '../meta/pubs';
import { TAILLE_VISUEL_PUB_MAX, TYPES_VISUEL_PUB } from '../meta/pubs-creation';
import type { ConnexionPub } from '../pubs/connexion.pg';
import type { Publicite } from '../pubs/publicites.pg';
import type { BrouillonPub, BrouillonPubComplet, ChampsBrouillon } from '../pubs/brouillons.pg';
import { PublicationRefusee } from '../pubs/creation';
import type { DemandeCreation, IssueCreation } from '../pubs/creation';
import type { Entonnoir } from '../pubs/entonnoir';
import { makeJournal, type AuditSink } from '../audit/journal';

/**
 * Les publicités d'un espace : sa connexion (lire l'état, échanger le code de la fenêtre Meta, choisir le compte
 * et la Page, se déconnecter), puis ses campagnes (lister, créer, publier, lire, mettre en pause, reprendre).
 * 🔴 Le jeton n'entre jamais dans ce fichier : le câblage l'échange, le chiffre et le range, et ne laisse passer
 * que le `tenantId`. Aucune dépendance optionnelle, garde et plafond compris.
 */
export interface PubsRouteDeps {
  /**
   * `config_id` de la configuration Facebook Login for Business « publicités ». Vide = fonctionnalité éteinte,
   * et l'écran le dit au lieu d'ouvrir une fenêtre qui échouerait.
   */
  configId: string;
  /** App ID Meta (public : sert au `FB.init` du front). */
  appId: string;
  graphVersion: string;
  /** L'état de la connexion, sans le jeton. */
  connexions: { lire(tenantId: string): Promise<ConnexionPub | null> };
  /**
   * Le compte publicitaire peut-il diffuser ? Lu en direct chez Meta. `null` n'est pas « tout va bien » : c'est
   * « je n'ai pas pu demander », et l'écran doit le dire, sinon un compte bloqué passerait pour prêt.
   */
  etatCompte(tenantId: string): Promise<EtatComptePub | null>;
  /** Échange le code (TTL 30 s), chiffre le jeton, le range, et rend ce que ce jeton accorde. */
  connecter(tenantId: string, code: string, userId: string | null): Promise<ActifsAccordes>;
  /** Ce que le jeton déjà rangé accorde. Sert à vérifier un choix, donc relu chez Meta, pas en base. */
  actifsAccordes(tenantId: string): Promise<ActifsAccordes>;
  /** Enregistre le choix après avoir lu chez Meta la devise, le fuseau et l'état de la liaison. */
  choisir(tenantId: string, choix: { comptePubId: string; pageId: string }): Promise<ConnexionPub>;
  /**
   * Efface la connexion, après avoir tenté de retirer notre accès chez Meta. Le booléen va au journal d'audit,
   * pas à l'écran : il sert à mesurer si le retrait fonctionne sur un jeton d'utilisateur système.
   */
  deconnecter(tenantId: string): Promise<{ revoqueChezMeta: boolean }>;
  /** Les publicités de l'espace, la plus récente d'abord. */
  publicites: { lister(tenantId: string): Promise<Publicite[]> };
  /** Les brouillons : un brouillon est un formulaire mémorisé qui ne touche jamais Meta. */
  brouillons: {
    /**
     * Le plus récemment modifié d'abord, sans les octets des visuels : c'est un contrat (un brouillon peut porter
     * 5 Mo d'image). Seule `lire` les lit.
     */
    lister(tenantId: string): Promise<BrouillonPub[]>;
    /** Un brouillon avec son visuel, pour repeupler le formulaire. `null` = inconnu dans cet espace. */
    lire(tenantId: string, id: string): Promise<BrouillonPubComplet | null>;
    creer(tenantId: string, c: ChampsBrouillon): Promise<string>;
    /** `false` = le brouillon n'existe pas dans cet espace, ce que la route rend en 404. */
    mettreAJour(tenantId: string, id: string, c: ChampsBrouillon): Promise<boolean>;
    supprimer(tenantId: string, id: string): Promise<boolean>;
  };
  /**
   * Crée la publicité chez Meta, en pause, et range ce qui en revient. Ne lève pas sur un refus de Meta : tout
   * sort par `IssueCreation`, pour rendre le message de Meta et distinguer « rien de créé » de « quelque chose
   * subsiste ».
   */
  creerPub(tenantId: string, d: Omit<DemandeCreation, 'comptePubId' | 'pageId' | 'numeroWhatsApp'>): Promise<IssueCreation>;
  /** Allume l'automation puis Meta. Lève si Meta refuse : l'ordre est la règle, pas le succès. */
  publierPub(tenantId: string, publiciteId: string): Promise<void>;
  /** Une publicité et son entonnoir. `null` = elle n'existe pas dans cet espace. */
  lirePub(tenantId: string, publiciteId: string): Promise<{ publicite: Publicite; entonnoir: Entonnoir } | null>;
  /**
   * Met la campagne en pause chez Meta, ou la relance. 🔴 L'automation reste allumée dans les deux sens : un
   * prospect qui a cliqué juste avant la pause peut écrire plus tard, et ce lead a été payé.
   */
  basculerPub(tenantId: string, publiciteId: string, actif: boolean): Promise<void>;
  audit: AuditSink;
}

/**
 * 🔴 Notre panne n'est pas un refus de Meta : si l'écriture échoue après l'échange, Meta a émis un jeton sans
 * expiration dont nous perdons le seul exemplaire. Il faut le dire et le tracer, pas l'habiller en « échange
 * refusé par Meta ».
 */
export class JetonNonEnregistre extends Error {
  constructor(readonly cause: unknown) {
    super('jeton publicitaire non enregistré');
    this.name = 'JetonNonEnregistre';
  }
}

/**
 * 🔴 Une connexion existe déjà, et on ne l'écrase pas : le jeton en place n'expire jamais, le remplacer sans le
 * révoquer laisserait un accès vivant dont nous perdrions le seul exemplaire. Reconnecter passe par la
 * déconnexion, qui révoque d'abord ; un appel direct reçoit donc 409.
 */
export class DejaConnectePub extends Error {
  /**
   * `jetonOrphelin` : Meta avait déjà émis un jeton quand on s'en est aperçu (la course) ; le cas ordinaire est
   * refusé avant l'échange. Il ne change pas le message au client : il sert à tracer l'événement côté serveur.
   */
  constructor(readonly jetonOrphelin: boolean) {
    super('une connexion publicitaire existe déjà pour cet espace');
    this.name = 'DejaConnectePub';
  }
}

/** L'espace n'a aucune connexion publicitaire : une demande hors d'état, pas une panne. */
export class PasDeConnexionPub extends Error {
  constructor() {
    super('aucune connexion publicitaire pour cet espace');
    this.name = 'PasDeConnexionPub';
  }
}

/**
 * La connexion est incomplète : compte publicitaire ou Page non choisi. Une erreur nommée plutôt qu'un 400 :
 * c'est un état du parcours, et l'écran doit renvoyer le client finir sa connexion.
 */
export class ConnexionPubIncomplete extends Error {
  constructor() {
    super('la connexion publicitaire est incomplète : choisissez un compte publicitaire et une Page');
    this.name = 'ConnexionPubIncomplete';
  }
}

/** `.strict()` : une clé en trop est refusée, le navigateur ne choisit pas ce qu'il envoie. */
const corpsEchange = z.object({ code: z.string().min(1).max(4096) }).strict();
const corpsChoix = z.object({
  comptePubId: z.string().min(1).max(64),
  pageId: z.string().min(1).max(64),
}).strict();

/**
 * Le formulaire de création, minimal. 🔴 `budgetTotal` et `fin` sont obligatoires : sans eux, une publicité
 * dépense sans limite ni terme sur le compte du client (Meta l'exige aussi : `lifetime_budget` impose
 * `end_time`). `horsCategorieSpeciale` doit valoir `true` : logement, emploi, crédit ou politique imposent des
 * obligations que cet écran ne porte pas ; on renvoie le client vers le Gestionnaire.
 */
const corpsCreation = z.object({
  nom: z.string().trim().min(1).max(120),
  texte: z.string().trim().min(1).max(1000),
  titre: z.string().trim().min(1).max(60),
  messagePreRempli: z.string().trim().min(1).max(200),
  accueil: z.string().trim().min(1).max(500),
  budgetTotal: z.number().positive().max(1_000_000),
  debut: z.string().min(1).max(64),
  fin: z.string().min(1).max(64),
  pays: z.array(z.string().length(2)).max(25).default([]),
  villes: z.array(z.object({
    cle: z.string().min(1).max(64),
    rayon: z.number().int().positive().max(80),
    unite: z.enum(['kilometer', 'mile']),
  })).max(10).default([]),
  ageMin: z.number().int().min(18).max(65),
  ageMax: z.number().int().min(18).max(65),
  destination: z.enum(['scenario', 'agent_meta']),
  workflowId: z.string().uuid().nullable().default(null),
  tagQualification: z.string().trim().min(1).max(64).nullable().default(null),
  horsCategorieSpeciale: z.literal(true),
  image: z.object({
    type: z.enum(TYPES_VISUEL_PUB),
    // La taille est vérifiée sur les octets décodés, pas sur la longueur du base64 : cette borne-ci n'est
    // qu'un premier filet, large de la surcharge de l'encodage.
    base64: z.string().min(1).max(Math.ceil(TAILLE_VISUEL_PUB_MAX * 1.4)),
  }),
}).strict();

/**
 * Le corps d'un brouillon, permissif là où la création est stricte : aucun champ obligatoire, un brouillon garde
 * un travail incomplet ; la validation stricte reste sur `corpsCreation`, qui engage l'argent du client. Restent
 * bornés, parce que ce sont des frontières : les longueurs, l'énumération de la destination, la forme de
 * l'identifiant de scénario, le type du visuel, et `.strict()`.
 * `image` a trois sens : absente = ne touche pas au visuel enregistré, `null` = l'efface, un objet = le remplace.
 */
const corpsBrouillon = z.object({
  nom: z.string().max(120).default(''),
  texte: z.string().max(1000).default(''),
  titre: z.string().max(60).default(''),
  messagePreRempli: z.string().max(200).default(''),
  accueil: z.string().max(500).default(''),
  budgetTotal: z.string().max(32).default(''),
  debut: z.string().max(64).default(''),
  fin: z.string().max(64).default(''),
  pays: z.string().max(200).default(''),
  ageMin: z.string().max(8).default(''),
  ageMax: z.string().max(8).default(''),
  destination: z.enum(['scenario', 'agent_meta']).default('scenario'),
  workflowId: z.string().uuid().nullable().default(null),
  tagQualification: z.string().max(64).default(''),
  image: z.object({
    type: z.enum(TYPES_VISUEL_PUB),
    base64: z.string().min(1).max(Math.ceil(TAILLE_VISUEL_PUB_MAX * 1.4)),
  }).nullable().optional(),
}).strict();

/**
 * Ce que valent vraiment des octets d'image : rend le message de refus, ou `null` si le visuel passe. Une seule
 * fonction pour la création et les brouillons. 🔴 Le type se lit dans les octets, pas dans ce que le client
 * déclare : sur la création, ces octets partent chez un tiers sous l'identité du client ; sur un brouillon, ils
 * sont rendus au navigateur en `data:` URL.
 */
function refusDuVisuel(base64: string): string | null {
  // La taille se vérifie sur les octets décodés, pas sur la longueur du base64 (l'encodage ajoute un tiers).
  const octets = Buffer.from(base64, 'base64');
  if (octets.length === 0) return 'ce visuel est illisible';
  if (!estJpegOuPng(octets)) return 'ce fichier n’est pas une image JPEG ou PNG';
  if (octets.length > TAILLE_VISUEL_PUB_MAX) {
    return `ce visuel dépasse ${Math.round(TAILLE_VISUEL_PUB_MAX / (1024 * 1024))} Mo`;
  }
  return null;
}

/**
 * Du corps validé vers ce que le store attend. Une clé `image` absente doit le rester (spread conditionnel) :
 * `visuel: undefined` serait indiscernable d'un effacement pour un code qui teste `'visuel' in c`.
 */
function versChamps(c: z.infer<typeof corpsBrouillon>): ChampsBrouillon {
  return {
    nom: c.nom, titre: c.titre, texte: c.texte, accueil: c.accueil,
    messagePreRempli: c.messagePreRempli, budgetTotal: c.budgetTotal,
    debut: c.debut, fin: c.fin, pays: c.pays, ageMin: c.ageMin, ageMax: c.ageMax,
    tagQualification: c.tagQualification, destination: c.destination, workflowId: c.workflowId,
    ...(c.image === undefined ? {} : { visuel: c.image }),
  };
}

export function registerPubs(app: FastifyInstance, deps: PubsRouteDeps, garde: Guard, limiteCouteuse: PreHandler): void {
  const opts = { preHandler: garde };
  // Les trois écritures appellent Meta (l'échange, le choix, la déconnexion qui révoque) : elles portent le
  // plafond des routes coûteuses, par espace. La lecture appelle Meta aussi mais reste hors de ce plafond (dix
  // par minute et par espace couperaient l'écran) : elle est bornée par un micro-cache au câblage
  // (`etatComptePubCache`), le plafond par utilisateur, et le délai de `ClientGraph`.
  const couteux = gardeEtendue(garde, limiteCouteuse);
  const journal = makeJournal(deps.audit);

  app.get('/tenants/:tenantId/pubs/connexion', opts, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    const connexion = await deps.connexions.lire(tenantId);
    // Au mieux : une panne chez Meta ne doit pas empêcher d'afficher une connexion lue dans notre base. `null`
    // dit « je n'ai pas pu demander », jamais « tout va bien ».
    const compte = connexion === null ? null : await deps.etatCompte(tenantId).catch(() => null);
    return reply.send({
      configure: deps.configId !== '',
      configId: deps.configId,
      appId: deps.appId,
      graphVersion: deps.graphVersion,
      connexion,
      compte,
    });
  });

  app.post('/tenants/:tenantId/pubs/connexion/echange', couteux, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    if (deps.configId === '') return reply.code(503).send({ error: 'publicités non configurées (META_ADS_CONFIG_ID)' });
    const corps = corpsEchange.safeParse(req.body);
    if (!corps.success) return reply.code(400).send({ error: 'code manquant' });

    let actifs: ActifsAccordes;
    try {
      actifs = await deps.connecter(tenantId, corps.data.code, req.auth?.userId ?? null);
    } catch (err) {
      // On ne demande au client aucun geste chez Meta : un jeton que nous n'avons pas gardé n'est détenu par
      // personne, et les deux gestes possibles cassent quelque chose (retirer les permissions publicitaires emporte
      // la connexion qui marche, retirer l'application fait taire son numéro WhatsApp).
      if (err instanceof DejaConnectePub) {
        return reply.code(409).send({
          error: 'cet espace a déjà une connexion publicitaire. Déconnectez-la d’abord : c’est ce geste qui '
            + 'retire notre accès chez Meta.',
          code: 'deja_connecte',
        });
      }
      if (err instanceof JetonNonEnregistre) {
        return reply.code(500).send({
          // Aucun geste prescrit chez Meta (voir le 409 plus haut) : on dit ce qui s'est passé, et ce qui se fait chez
          // nous.
          error: 'la connexion a été accordée par Meta mais n’a pas pu être enregistrée de notre côté. '
            + 'Réessayez : si le problème persiste, c’est chez nous qu’il faut chercher, pas chez Meta.',
          code: 'jeton_non_enregistre',
        });
      }
      // Le code a 30 secondes de vie et ne sert qu'une fois : l'échec le plus courant est un client qui a
      // laissé la fenêtre ouverte. On rend le message de Meta, c'est son compte, et lui seul peut agir.
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'échange refusé par Meta' });
    }
    await journal(tenantId, req, 'pubs.connectee', { kind: 'pub_connexion', id: tenantId },
      { comptes: actifs.comptesPub.length, pages: actifs.pages.length });
    return reply.send(actifs);
  });

  app.post('/tenants/:tenantId/pubs/connexion/choix', couteux, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const corps = corpsChoix.safeParse(req.body);
    if (!corps.success) return reply.code(400).send({ error: 'choix invalide' });

    /**
     * 🔴 Le choix se vérifie contre ce que le jeton accorde, relu chez Meta : les identifiants viennent du
     * navigateur, et sans ce contrôle un admin enregistrerait le compte publicitaire d'une autre entreprise. Relue
     * en base, la liste serait périmée au premier retrait de droit.
     */
    let actifs: ActifsAccordes;
    try {
      actifs = await deps.actifsAccordes(tenantId);
    } catch (err) {
      // Un espace non connecté n'est pas une panne de Meta : le 502 l'aurait fait chercher du côté d'une
      // panne, quand il lui suffit de se connecter.
      if (err instanceof PasDeConnexionPub) return reply.code(409).send({ error: err.message, code: 'pas_connecte' });
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Meta ne répond pas' });
    }
    // `act_123` et `123` désignent le même compte : un appelant qui recopie l'identifiant vu dans le
    // Gestionnaire de publicités enverrait la forme préfixée. On compare, et on enregistre, la forme nue.
    const comptePubId = sansPrefixeAct(corps.data.comptePubId);
    if (!actifs.comptesPub.some((c) => c.id === comptePubId)) {
      return reply.code(400).send({ error: 'ce compte publicitaire n’est pas accordé par la connexion' });
    }
    if (!actifs.pages.some((p) => p.id === corps.data.pageId)) {
      return reply.code(400).send({ error: 'cette Page n’est pas accordée par la connexion' });
    }

    let connexion: ConnexionPub;
    try {
      connexion = await deps.choisir(tenantId, { comptePubId, pageId: corps.data.pageId });
    } catch (err) {
      // Même cas que plus haut : `choisir` lit le jeton lui aussi, et un autre onglet peut déconnecter pendant le
      // choix.
      if (err instanceof PasDeConnexionPub) return reply.code(409).send({ error: err.message, code: 'pas_connecte' });
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Meta ne répond pas' });
    }
    await journal(tenantId, req, 'pubs.actifs_choisis', { kind: 'pub_connexion', id: tenantId },
      { comptePubId: connexion.comptePubId, pageId: connexion.pageId, pageLiee: connexion.pageLiee });
    return reply.send({ connexion });
  });

  app.get('/tenants/:tenantId/pubs', opts, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    return reply.send({ publicites: await deps.publicites.lister(tenantId) });
  });

  /**
   * Les brouillons : cinq routes qui ne touchent jamais Meta. `/pubs/brouillons` coexiste avec `/pubs/:id`
   * (Fastify fait gagner le segment statique) ; déclarées avant quand même, pour que la lecture dise la même
   * chose. Admin pour les écritures : un brouillon prépare une dépense et porte des mégaoctets de visuel.
   */
  const optsBrouillon = { ...opts, bodyLimit: Math.ceil(TAILLE_VISUEL_PUB_MAX * 1.4) };

  app.get('/tenants/:tenantId/pubs/brouillons', opts, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    return reply.send({ brouillons: await deps.brouillons.lister(tenantId) });
  });

  app.get('/tenants/:tenantId/pubs/brouillons/:id', opts, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    const { id } = req.params as { id: string };
    const b = await deps.brouillons.lire(tenantId, id);
    if (b === null) return reply.code(404).send({ error: 'ce brouillon n’existe pas' });
    return reply.send({ brouillon: b });
  });

  app.post('/tenants/:tenantId/pubs/brouillons', optsBrouillon, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const lu = corpsBrouillon.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'brouillon invalide' });
    // Même lecture des octets qu'à la création : un brouillon n'est pas une porte dérobée pour écrire n'importe
    // quoi en base.
    const refus = lu.data.image ? refusDuVisuel(lu.data.image.base64) : null;
    if (refus !== null) return reply.code(400).send({ error: refus });
    const id = await deps.brouillons.creer(tenantId, versChamps(lu.data));
    return reply.code(201).send({ id });
  });

  app.put('/tenants/:tenantId/pubs/brouillons/:id', optsBrouillon, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const lu = corpsBrouillon.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'brouillon invalide' });
    // `image` absente ne passe pas ici : il n'y a pas d'octets neufs à juger, et ceux qui sont déjà en base ont
    // été lus à leur écriture. Seul un visuel fourni se vérifie.
    const refus = lu.data.image ? refusDuVisuel(lu.data.image.base64) : null;
    if (refus !== null) return reply.code(400).send({ error: refus });
    const trouve = await deps.brouillons.mettreAJour(tenantId, id, versChamps(lu.data));
    if (!trouve) return reply.code(404).send({ error: 'ce brouillon n’existe pas' });
    return reply.code(204).send();
  });

  app.delete('/tenants/:tenantId/pubs/brouillons/:id', opts, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const trouve = await deps.brouillons.supprimer(tenantId, id);
    if (!trouve) return reply.code(404).send({ error: 'ce brouillon n’existe pas' });
    return reply.code(204).send();
  });

  /**
   * Créer une publicité : tout est créé en pause chez Meta, cette route ne fait dépenser personne. `bodyLimit`
   * dédié (le visuel transite en base64). Plafond coûteux et admin : elle engage l'argent du client chez un tiers.
   */
  const optsCreation = { ...couteux, bodyLimit: Math.ceil(TAILLE_VISUEL_PUB_MAX * 1.4) };
  app.post('/tenants/:tenantId/pubs', optsCreation, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const corps = corpsCreation.safeParse(req.body);
    if (!corps.success) {
      return reply.code(400).send({ error: 'formulaire incomplet ou invalide', detail: corps.error.issues[0]?.message });
    }
    const f = corps.data;

    // Les trois contrôles que Zod ne sait pas exprimer, et qui feraient chacun une publicité absurde.
    if (f.ageMin > f.ageMax) return reply.code(400).send({ error: 'l’âge minimum dépasse l’âge maximum' });
    if (f.pays.length === 0 && f.villes.length === 0) {
      return reply.code(400).send({ error: 'choisissez au moins un pays ou une ville' });
    }
    if (f.destination === 'scenario' && f.workflowId === null) {
      return reply.code(400).send({ error: 'choisissez le scénario qui répondra aux prospects de cette publicité' });
    }
    // Les contrôles des octets vivent dans `refusDuVisuel`, partagé avec les brouillons.
    const refus = refusDuVisuel(f.image.base64);
    if (refus !== null) return reply.code(400).send({ error: refus });

    let issue: IssueCreation;
    try {
      issue = await deps.creerPub(tenantId, {
        formulaire: {
          nom: f.nom, texte: f.texte, titre: f.titre, messagePreRempli: f.messagePreRempli, accueil: f.accueil,
          budgetTotal: f.budgetTotal, debut: f.debut, fin: f.fin,
          pays: f.pays, villes: f.villes, ageMin: f.ageMin, ageMax: f.ageMax,
        },
        imageBase64: f.image.base64,
        destination: f.destination,
        workflowId: f.destination === 'scenario' ? f.workflowId : null,
        tagQualification: f.tagQualification,
        creePar: req.auth?.userId ?? null,
      });
    } catch (err) {
      if (err instanceof PasDeConnexionPub) return reply.code(409).send({ error: err.message, code: 'pas_connecte' });
      if (err instanceof ConnexionPubIncomplete) return reply.code(409).send({ error: err.message, code: 'connexion_incomplete' });
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Meta ne répond pas' });
    }

    if (issue.sorte === 'annulee') {
      // Rien n'existe chez Meta, et ce statut le dit. On rend le message de Meta tel quel : c'est son compte.
      return reply.code(502).send({ error: issue.raison, code: 'creation_refusee' });
    }
    await journal(tenantId, req, 'pubs.creee', { kind: 'publicite', id: issue.publiciteId },
      { campagneId: issue.campagneId, destination: f.destination, budgetTotal: f.budgetTotal, issue: issue.sorte });
    if (issue.sorte === 'echec_creation') {
      return reply.code(502).send({
        error: issue.raison,
        code: 'creation_incomplete',
        publiciteId: issue.publiciteId,
      });
    }
    return reply.send({ publiciteId: issue.publiciteId, campagneId: issue.campagneId });
  });

  /**
   * 🔴 Publier : le seul geste de ce module qui fait dépenser de l'argent, et une impression payée ne se
   * rembourse pas. L'ordre (l'automation avant Meta) vit dans `publierLaPublicite`, pas ici.
   */
  app.post('/tenants/:tenantId/pubs/:id/publier', couteux, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    try {
      await deps.publierPub(tenantId, id);
    } catch (err) {
      // Un refus n'est pas une panne de Meta : 409, et le message dit ce qu'il faut réparer. Un 502 enverrait le
      // client chercher un problème chez Meta, qui n'a même pas été appelé.
      if (err instanceof PublicationRefusee) return reply.code(409).send({ error: err.message, code: 'publication_refusee' });
      if (err instanceof PasDeConnexionPub) return reply.code(409).send({ error: err.message, code: 'pas_connecte' });
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Meta ne répond pas' });
    }
    await journal(tenantId, req, 'pubs.publiee', { kind: 'publicite', id }, {});
    return reply.send({ ok: true });
  });

  /**
   * La page d'une publicité : son statut chez Meta, son entonnoir, ses prospects non pris en charge. Hors du
   * plafond coûteux : c'est l'ouverture d'un écran, et elle ne lit que nos tables (le suivi relit Meta en fond).
   */
  app.get('/tenants/:tenantId/pubs/:id', opts, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    const { id } = req.params as { id: string };
    const vue = await deps.lirePub(tenantId, id);
    if (vue === null) return reply.code(404).send({ error: 'cette publicité n’existe pas' });
    return reply.send(vue);
  });

  /**
   * Mettre en pause ou relancer. 🔴 La pause doit rester possible même quand tout va mal : c'est le bouton d'arrêt
   * d'une dépense, et toute condition de plus (état local, suivi, connexion) créerait un cas où le client voit sa
   * campagne dépenser sans pouvoir l'arrêter.
   */
  for (const [chemin, actif, action] of [
    ['pause', false, 'pubs.pausee'],
    ['reprendre', true, 'pubs.reprise'],
  ] as const) {
    app.post(`/tenants/:tenantId/pubs/:id/${chemin}`, couteux, async (req, reply) => {
      const tenantId = espaceVerifie(req);
      if (forbidNonAdmin(req, reply)) return;
      const { id } = req.params as { id: string };
      try {
        await deps.basculerPub(tenantId, id, actif);
      } catch (err) {
        if (err instanceof PasDeConnexionPub) return reply.code(409).send({ error: err.message, code: 'pas_connecte' });
        return reply.code(502).send({ error: err instanceof Error ? err.message : 'Meta ne répond pas' });
      }
      await journal(tenantId, req, action, { kind: 'publicite', id }, {});
      return reply.send({ ok: true });
    });
  }

  // `couteux` et non `opts` : elle révoque chez Meta, donc appelle l'extérieur. C'est la seule route du module
  // qui détruit quelque chose chez nous.
  app.delete('/tenants/:tenantId/pubs/connexion', couteux, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { revoqueChezMeta } = await deps.deconnecter(tenantId);
    await journal(tenantId, req, 'pubs.deconnectee', { kind: 'pub_connexion', id: tenantId }, { revoqueChezMeta });
    return reply.send({ ok: true, revoqueChezMeta });
  });
}

/**
 * Ces octets sont-ils un JPEG ou un PNG ? Lu sur la signature, que le client ne peut pas changer dans son
 * formulaire. Pas un décodeur (Meta refusera un fichier corrompu) : la garde ferme l'envoi d'un SVG (document
 * exécutable) ou d'autre chose sous une étiquette `image/png`.
 */
function estJpegOuPng(o: Buffer): boolean {
  // JPEG : FF D8 FF. PNG : 89 50 4E 47 0D 0A 1A 0A.
  if (o.length >= 3 && o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return true;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return o.length >= png.length && png.every((b, i) => o[i] === b);
}
