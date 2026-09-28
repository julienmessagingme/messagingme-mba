import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { forbidNonAdmin, gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { sansPrefixeAct, type ActifsAccordes, type EtatComptePub } from '../meta/pubs';
import {
  TAILLE_VISUEL_PUB_MAX, TYPES_VISUEL_PUB,
  type DepotVideo, type EtatVideo, type ListeAudiencesPub,
} from '../meta/pubs-creation';
import {
  AGE_MAX_ADVANTAGE, AGE_MIN_ADVANTAGE_BAS, AGE_MIN_ADVANTAGE_HAUT, BOUTON_PUB_DEFAUT, BOUTONS_PUB,
} from '../meta/pubs-payloads';
import { estRefusDeMeta } from '../meta/graph';
import type { ConnexionPub } from '../pubs/connexion.pg';
import type { Publicite } from '../pubs/publicites.pg';
import type { BrouillonPub, BrouillonPubComplet, ChampsBrouillon } from '../pubs/brouillons.pg';
import { PublicationRefusee } from '../pubs/creation';
import type { DemandeCreation, IssueCreation } from '../pubs/creation';
import {
  DUREE_VIDEO_PUB_MAX_S, MorceauDeTailleInattendue, TAILLE_VIDEO_PUB_MAX, TETE_VIDEO_OCTETS,
  dureeDeLaTete, dureeTropLongue, estVideoMp4OuMov, lireTete, suiteBornee,
} from '../pubs/video';
import type { Entonnoir } from '../pubs/entonnoir';
import { makeJournal, type AuditSink } from '../audit/journal';
import { journaliser } from '../lib/journal';

/**
 * Les publicités d'un espace : sa connexion (lire l'état, échanger le code de la fenêtre Meta, choisir le compte
 * et la Page, se déconnecter), puis ses campagnes (lister, créer, publier, lire, mettre en pause, reprendre).
 * 🔴 Le jeton n'entre jamais dans ce fichier : `src/pubs/connexion.ts` l'échange, le chiffre et le range, et ne
 * laisse passer que le `tenantId`. Aucune dépendance optionnelle, garde et plafond compris.
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
  publicites: {
    lister(tenantId: string): Promise<Publicite[]>;
    archiver(tenantId: string, id: string, archiver: boolean): Promise<'ok' | 'introuvable' | 'diffuse'>;
  };
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
  /**
   * Le dépôt d'une vidéo chez Meta, morceau par morceau, et son état. Le jeton et le compte publicitaire sont
   * résolus par le câblage, comme pour `creerPub` : la route ne voit que l'espace. Chaque membre lève
   * `PasDeConnexionPub` ou `ConnexionPubIncomplete` quand la connexion ne permet pas de déposer.
   */
  videos: {
    demarrer(tenantId: string, taille: number): Promise<DepotVideo>;
    /** Relaie un morceau EN FLUX : `octets` n'est lu qu'au fil de l'envoi à Meta, jamais tamponné entier. */
    transferer(
      tenantId: string,
      m: { sessionId: string; debut: number; taille: number; octets: AsyncIterable<Uint8Array> },
    ): Promise<{ debut: number; fin: number }>;
    terminer(tenantId: string, sessionId: string): Promise<void>;
    etat(tenantId: string, videoId: string): Promise<EtatVideo>;
  };
  /** Les audiences personnalisées du compte publicitaire connecté, lues chez Meta à chaque demande. */
  audiences(tenantId: string): Promise<ListeAudiencesPub>;
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
 * Un identifiant d'objet Meta (vidéo, session de dépôt, audience) : des chiffres, rien d'autre. Il part dans une
 * adresse ou un champ de formulaire chez Meta : une forme libre y porterait un chemin ou un paramètre de plus.
 */
const idMeta = z.string().regex(/^\d{1,40}$/);

/** Combien d'audiences à inclure, et à exclure, au plus : une frontière d'hygiène, pas une limite de Meta. */
const AUDIENCES_MAX = 20;

/**
 * Le formulaire de création, minimal. 🔴 `budgetTotal` et `fin` sont obligatoires : sans eux, une publicité
 * dépense sans limite ni terme sur le compte du client (Meta l'exige aussi : `lifetime_budget` impose
 * `end_time`). `horsCategorieSpeciale` doit valoir `true` : logement, emploi, crédit ou politique imposent des
 * obligations que cet écran ne porte pas ; on renvoie le client vers le Gestionnaire.
 * Le visuel est une `image` (octets) OU une `video` (déjà déposée chez Meta, par son identifiant) : la route
 * refuse les deux, et aucun. `ageMax` n'est plus qu'une confirmation : avec Advantage+, Meta le fixe à 65, et
 * l'écran d'avant cette règle l'envoie encore.
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
  ageMax: z.number().int().min(18).max(65).optional(),
  audiencesIncluses: z.array(idMeta).max(AUDIENCES_MAX).default([]),
  audiencesExclues: z.array(idMeta).max(AUDIENCES_MAX).default([]),
  // La liste FERMÉE des boutons (`BOUTONS_PUB`) ; absent, c'est le bouton WhatsApp, le seul que l'écran d'avant
  // connaissait et le seul que Meta documente pour cette destination.
  bouton: z.enum(BOUTONS_PUB).default(BOUTON_PUB_DEFAUT),
  destination: z.enum(['scenario', 'agent_meta']),
  workflowId: z.string().uuid().nullable().default(null),
  tagQualification: z.string().trim().min(1).max(64).nullable().default(null),
  horsCategorieSpeciale: z.literal(true),
  image: z.object({
    type: z.enum(TYPES_VISUEL_PUB),
    // La taille est vérifiée sur les octets décodés, pas sur la longueur du base64 : cette borne-ci n'est
    // qu'un premier filet, large de la surcharge de l'encodage.
    base64: z.string().min(1).max(Math.ceil(TAILLE_VISUEL_PUB_MAX * 1.4)),
  }).optional(),
  video: z.object({ id: idMeta }).strict().optional(),
}).strict();

/**
 * Le corps d'un brouillon, permissif là où la création est stricte : aucun champ obligatoire, un brouillon garde
 * un travail incomplet ; la validation stricte reste sur `corpsCreation`, qui engage l'argent du client. Restent
 * bornés, parce que ce sont des frontières : les longueurs, l'énumération de la destination, la forme de
 * l'identifiant de scénario, le type du visuel, et `.strict()`.
 * `image` a trois sens : absente = ne touche pas au visuel enregistré, `null` = l'efface, un objet = le remplace.
 * `video` a les mêmes trois sens, et les audiences deux (absentes = ne pas toucher) : un écran d'avant la migration
 * 0187 ne les envoie pas, et ne doit pas les effacer en enregistrant.
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
  video: z.object({ id: idMeta }).strict().nullable().optional(),
  audiencesIncluses: z.array(idMeta).max(AUDIENCES_MAX).optional(),
  audiencesExclues: z.array(idMeta).max(AUDIENCES_MAX).optional(),
  // Même liste fermée qu'à la création : un brouillon garde un travail incomplet, pas une valeur inventée.
  // Absent = ne pas toucher (migration 0188).
  bouton: z.enum(BOUTONS_PUB).optional(),
}).strict();

/**
 * Les deux listes d'audiences partagent-elles un identifiant ? Inclure et exclure la même audience n'a aucun sens,
 * et Meta trancherait à notre place sans le dire.
 */
function audienceEnDouble(incluses: readonly string[], exclues: readonly string[]): string | null {
  return incluses.find((id) => exclues.includes(id)) ?? null;
}

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
    ...(c.video === undefined ? {} : { video: c.video }),
    ...(c.audiencesIncluses === undefined ? {} : { audiencesIncluses: c.audiencesIncluses }),
    ...(c.audiencesExclues === undefined ? {} : { audiencesExclues: c.audiencesExclues }),
    ...(c.bouton === undefined ? {} : { bouton: c.bouton }),
  };
}

/**
 * Les refus d'un brouillon qui ne portent pas sur les octets : deux visuels à la fois, ou une audience incluse et
 * exclue. `null` si le corps passe.
 */
function refusDuBrouillon(c: z.infer<typeof corpsBrouillon>): string | null {
  if (c.image && c.video) return 'un brouillon porte une image OU une vidéo, pas les deux';
  const double = audienceEnDouble(c.audiencesIncluses ?? [], c.audiencesExclues ?? []);
  if (double !== null) return `l’audience ${double} ne peut pas être à la fois incluse et exclue`;
  return null;
}

/** Le chemin du morceau de vidéo : la seule route qui reçoit des octets bruts, et le parseur le vérifie. */
const CHEMIN_MORCEAU_VIDEO = '/tenants/:tenantId/pubs/videos/:sessionId/morceaux';

/** Où commence et où finit le morceau envoyé, tel que Meta l'a demandé au pas précédent. */
const requeteMorceau = z.object({
  debut: z.coerce.number().int().nonnegative(),
  fin: z.coerce.number().int().positive(),
});

/** Une erreur, ou l'une de ses causes, est-elle de ce type ? `fetch` enveloppe l'erreur d'un corps en flux. */
function causeDe<T>(err: unknown, type: new (...a: never[]) => T): T | null {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i += 1) {
    if (e instanceof type) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** Ce qu'une panne dit au navigateur : rien de ses détails, qui sont au journal. */
const PANNE_OPAQUE = 'la demande n’a pas abouti : réessayez dans un instant.';

/**
 * La réponse d'un échec du dépôt vidéo ou de la lecture des audiences.
 *
 * 🔴 Un refus de META (4xx chez lui) sort en 422, avec son message : Cloudflare remplace le corps de toute réponse
 * 5xx par sa propre page, donc un message destiné au client ne peut pas voyager dans un 502. Seule NOTRE panne
 * (réseau, délai, 5xx de Meta) sort en 502, journalisée ici puisque l'écran n'en verra pas le détail.
 * 🔴 ET LE 502 NE PORTE QU'UNE PHRASE OPAQUE : le message d'une panne est interne (une adresse de Meta avec
 * l'identifiant du compte, une erreur de notre base), il va au journal avec sa cause, jamais dans la réponse.
 */
function repondreEchec(reply: FastifyReply, err: unknown, quoi: string, tenantId: string): FastifyReply {
  if (err instanceof PasDeConnexionPub) return reply.code(409).send({ error: err.message, code: 'pas_connecte' });
  if (err instanceof ConnexionPubIncomplete) return reply.code(409).send({ error: err.message, code: 'connexion_incomplete' });
  if (estRefusDeMeta(err)) {
    // Le sous-code nomme le refus précis chez Meta : il va au journal, où l'on cherche pourquoi un essai a échoué.
    journaliser('warn', `publicités : ${quoi} refusé par Meta`, { tenantId, code: err.code, subcode: err.subcode, err });
    return reply.code(422).send({ error: err.message, code: 'refus_meta' });
  }
  journaliser('error', `publicités : ${quoi} en échec`, { tenantId, err });
  return reply.code(502).send({ error: PANNE_OPAQUE, code: 'panne' });
}

export function registerPubs(app: FastifyInstance, deps: PubsRouteDeps, garde: Guard, limiteCouteuse: PreHandler): void {
  const opts = { preHandler: garde };
  // Les trois écritures appellent Meta (l'échange, le choix, la déconnexion qui révoque) : elles portent le
  // plafond des routes coûteuses, par espace. La lecture appelle Meta aussi mais reste hors de ce plafond (dix
  // par minute et par espace couperaient l'écran) : elle est bornée par un micro-cache de deux minutes
  // (`etatComptePubCache`, `src/pubs/connexion.ts`), le plafond par utilisateur, et le délai de `ClientGraph`.
  const couteux = gardeEtendue(garde, limiteCouteuse);
  const journal = makeJournal(deps.audit);

  /**
   * 🔴 LE CORPS BRUT D'UN MORCEAU DE VIDÉO N'EST JAMAIS LU PAR FASTIFY. Le parseur tourne AVANT les gardes (la
   * phase d'analyse précède les `preHandler`) : s'il lisait le corps, un appelant sans session ferait tamponner
   * des mégaoctets avant d'être refusé. Il ne fait donc que laisser passer, sur la seule route du morceau ; c'est
   * le gestionnaire, une fois l'authentification et l'espace vérifiés, qui lit le flux, borné par les décalages
   * du morceau. Toute autre route qui recevrait des octets bruts les refuse en 415, comme avant ce parseur.
   */
  app.addContentTypeParser('application/octet-stream', (req, _payload, done) => {
    if (req.routeOptions.url !== CHEMIN_MORCEAU_VIDEO) {
      done(Object.assign(new Error('type de contenu non accepté sur cette route'), { statusCode: 415 }), undefined);
      return;
    }
    done(null, undefined);
  });

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
    const refus = refusDuBrouillon(lu.data) ?? (lu.data.image ? refusDuVisuel(lu.data.image.base64) : null);
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
    const refus = refusDuBrouillon(lu.data) ?? (lu.data.image ? refusDuVisuel(lu.data.image.base64) : null);
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
   * LE DÉPÔT D'UNE VIDÉO, EN TROIS GESTES : ouvrir (Meta dit quel morceau envoyer), envoyer chaque morceau (Meta dit
   * le suivant), clore. Le navigateur découpe le fichier comme Meta le demande, et chaque morceau traverse l'API en
   * flux jusqu'à Meta : la vidéo n'est gardée ni en base ni en entier en mémoire. Rien n'est facturable, mais tout
   * est réservé aux admins : c'est un objet créé chez un tiers, sur le compte du client. Ouvrir porte le plafond
   * coûteux (un par vidéo) ; les morceaux, nombreux, portent le plafond par utilisateur de la garde.
   */
  app.post('/tenants/:tenantId/pubs/videos', couteux, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const lu = z.object({ taille: z.number().int().positive() }).strict().safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'taille de vidéo manquante ou invalide' });
    if (lu.data.taille > TAILLE_VIDEO_PUB_MAX) {
      return reply.code(400).send({ error: `cette vidéo dépasse ${Math.round(TAILLE_VIDEO_PUB_MAX / (1024 * 1024))} Mo`, code: 'video_trop_lourde' });
    }
    try {
      return reply.send(await deps.videos.demarrer(tenantId, lu.data.taille));
    } catch (err) {
      return repondreEchec(reply, err, 'ouverture du dépôt vidéo', tenantId);
    }
  });

  app.post(CHEMIN_MORCEAU_VIDEO, opts, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { sessionId } = req.params as { sessionId: string };
    if (!idMeta.safeParse(sessionId).success) return reply.code(400).send({ error: 'session de dépôt invalide' });
    const q = requeteMorceau.safeParse(req.query);
    if (!q.success || q.data.fin <= q.data.debut) return reply.code(400).send({ error: 'morceau de vidéo invalide' });
    // La fin du morceau borne la vidéo entière : un morceau qui finirait au-delà de 100 Mo appartient à un fichier
    // que l'ouverture aurait refusé.
    if (q.data.fin > TAILLE_VIDEO_PUB_MAX) {
      return reply.code(413).send({ error: `cette vidéo dépasse ${Math.round(TAILLE_VIDEO_PUB_MAX / (1024 * 1024))} Mo`, code: 'video_trop_lourde' });
    }
    const { debut } = q.data;
    const taille = q.data.fin - debut;
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/octet-stream') return reply.code(415).send({ error: 'un morceau de vidéo s’envoie en octets bruts' });
    const annonce = req.headers['content-length'];
    if (annonce !== undefined && Number(annonce) !== taille) {
      return reply.code(400).send({ error: 'le morceau ne fait pas la taille annoncée', code: 'morceau_incoherent' });
    }

    // La tête du morceau est lue AVANT d'appeler Meta, pour refuser sans avoir rien envoyé ; le reste suit en flux.
    const source = (req.raw as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    let lu: { tete: Uint8Array; fini: boolean };
    try {
      lu = await lireTete(source, Math.min(taille, TETE_VIDEO_OCTETS));
    } catch {
      // Le navigateur a coupé l'envoi : rien n'est parti chez Meta, et personne n'attend plus cette réponse.
      return reply.code(400).send({ error: 'le morceau est arrivé incomplet', code: 'morceau_incoherent' });
    }
    const { tete, fini } = lu;
    if (tete.byteLength > taille || (fini && tete.byteLength !== taille)) {
      return reply.code(400).send({ error: 'le morceau ne fait pas la taille annoncée', code: 'morceau_incoherent' });
    }
    if (debut === 0) {
      if (!estVideoMp4OuMov(tete)) {
        return reply.code(400).send({ error: 'ce fichier n’est pas une vidéo MP4 ou MOV', code: 'video_format' });
      }
      // La durée n'est lisible ici que si le fichier la porte au début (voir `dureeDeLaTete`) : sinon, c'est le
      // contrôle du navigateur, fait avant l'envoi, qui tient la règle.
      const duree = dureeDeLaTete(tete);
      if (duree !== null && dureeTropLongue(duree)) {
        return reply.code(400).send({
          error: `cette vidéo dure ${Math.round(duree)} secondes : ${DUREE_VIDEO_PUB_MAX_S} au plus`, code: 'video_trop_longue',
        });
      }
    }
    try {
      const suivant = await deps.videos.transferer(tenantId, {
        sessionId, debut, taille, octets: suiteBornee(tete, source, fini, taille),
      });
      return reply.send(suivant);
    } catch (err) {
      const incoherent = causeDe(err, MorceauDeTailleInattendue);
      if (incoherent !== null) return reply.code(400).send({ error: incoherent.message, code: 'morceau_incoherent' });
      return repondreEchec(reply, err, 'envoi d’un morceau de vidéo', tenantId);
    }
  });

  app.post('/tenants/:tenantId/pubs/videos/:sessionId/fin', opts, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { sessionId } = req.params as { sessionId: string };
    if (!idMeta.safeParse(sessionId).success) return reply.code(400).send({ error: 'session de dépôt invalide' });
    try {
      await deps.videos.terminer(tenantId, sessionId);
      return reply.send({ ok: true });
    } catch (err) {
      return repondreEchec(reply, err, 'fin du dépôt vidéo', tenantId);
    }
  });

  /**
   * L'état d'une vidéo chez Meta, que l'écran interroge pendant le traitement (durée non documentée). Hors du
   * plafond coûteux : il est appelé à intervalle régulier, et le plafond par utilisateur de la garde le borne.
   */
  app.get('/tenants/:tenantId/pubs/videos/:videoId', opts, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    const { videoId } = req.params as { videoId: string };
    if (!idMeta.safeParse(videoId).success) return reply.code(400).send({ error: 'identifiant de vidéo invalide' });
    try {
      return reply.send(await deps.videos.etat(tenantId, videoId));
    } catch (err) {
      return repondreEchec(reply, err, 'état d’une vidéo', tenantId);
    }
  });

  /**
   * Les audiences du compte publicitaire : lues chez Meta à chaque ouverture du formulaire, sans cache (une
   * audience créée à l'instant dans le Gestionnaire doit apparaître), donc sous le plafond coûteux.
   */
  app.get('/tenants/:tenantId/pubs/audiences', couteux, async (req, reply) => {
    const tenantId = espaceVerifie(req);
    try {
      return reply.send(await deps.audiences(tenantId));
    } catch (err) {
      return repondreEchec(reply, err, 'lecture des audiences', tenantId);
    }
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

    // Les contrôles que Zod ne sait pas exprimer, et qui feraient chacun une publicité absurde ou refusée.
    // Advantage+ est laissé à Meta (`ciblage`, `src/meta/pubs-payloads.ts`) : il borne l'âge, et on le dit ici
    // avec des mots plutôt que de laisser Meta refuser après avoir créé la campagne.
    if (f.ageMin < AGE_MIN_ADVANTAGE_BAS || f.ageMin > AGE_MIN_ADVANTAGE_HAUT) {
      return reply.code(400).send({
        error: `avec Advantage+, Meta n’accepte qu’un âge minimum entre ${AGE_MIN_ADVANTAGE_BAS} et ${AGE_MIN_ADVANTAGE_HAUT} ans`,
      });
    }
    if (f.ageMax !== undefined && f.ageMax !== AGE_MAX_ADVANTAGE) {
      return reply.code(400).send({ error: `avec Advantage+, Meta fixe l’âge maximum à ${AGE_MAX_ADVANTAGE} ans` });
    }
    if (f.pays.length === 0 && f.villes.length === 0) {
      return reply.code(400).send({ error: 'choisissez au moins un pays ou une ville' });
    }
    if (f.destination === 'scenario' && f.workflowId === null) {
      return reply.code(400).send({ error: 'choisissez le scénario qui répondra aux prospects de cette publicité' });
    }
    const double = audienceEnDouble(f.audiencesIncluses, f.audiencesExclues);
    if (double !== null) {
      return reply.code(400).send({ error: `l’audience ${double} ne peut pas être à la fois incluse et exclue` });
    }
    // Un visuel, et un seul : une image (ses octets) OU une vidéo (déjà chez Meta).
    if ((f.image === undefined) === (f.video === undefined)) {
      return reply.code(400).send({ error: 'choisissez un visuel : une image ou une vidéo, pas les deux' });
    }
    // Les contrôles des octets vivent dans `refusDuVisuel`, partagé avec les brouillons. Une vidéo, elle, a été
    // lue morceau par morceau au dépôt ; son état chez Meta est relu par la création, avant la créa.
    const refus = f.image !== undefined ? refusDuVisuel(f.image.base64) : null;
    if (refus !== null) return reply.code(400).send({ error: refus });

    let issue: IssueCreation;
    try {
      issue = await deps.creerPub(tenantId, {
        formulaire: {
          nom: f.nom, texte: f.texte, titre: f.titre, messagePreRempli: f.messagePreRempli, accueil: f.accueil,
          budgetTotal: f.budgetTotal, debut: f.debut, fin: f.fin,
          pays: f.pays, villes: f.villes, ageMin: f.ageMin,
          audiencesIncluses: f.audiencesIncluses, audiencesExclues: f.audiencesExclues,
          bouton: f.bouton,
        },
        visuel: f.video !== undefined
          ? { sorte: 'video', videoId: f.video.id }
          : { sorte: 'image', base64: f.image?.base64 ?? '' },
        destination: f.destination,
        workflowId: f.destination === 'scenario' ? f.workflowId : null,
        tagQualification: f.tagQualification,
        creePar: req.auth?.userId ?? null,
      });
    } catch (err) {
      if (err instanceof PasDeConnexionPub) return reply.code(409).send({ error: err.message, code: 'pas_connecte' });
      if (err instanceof ConnexionPubIncomplete) return reply.code(409).send({ error: err.message, code: 'connexion_incomplete' });
      // Une panne AVANT la séquence (la connexion illisible, notre base) : son message est interne.
      journaliser('error', 'création de publicité : panne avant tout appel à Meta', { tenantId, err });
      return reply.code(502).send({ error: PANNE_OPAQUE, code: 'panne' });
    }

    if (issue.sorte === 'refusee') {
      // Une précondition que le client peut réparer (vidéo encore en traitement, audience inutilisable) : un état
      // du parcours, pas une panne. En 409 : ce message doit arriver à l'écran, ce qu'un 5xx ne permet pas
      // derrière Cloudflare.
      return reply.code(409).send({ error: issue.raison, code: issue.code });
    }
    /**
     * 🔴 UN REFUS DE META SORT EN 422, AVEC SON MESSAGE, et c'est ce qui rend lisible l'essai réel. En 502, Cloudflare
     * remplaçait le corps par sa propre page : le refus de Meta sur ce que sa documentation ne dit pas (la créa
     * vidéo, un bouton autre que WhatsApp) n'arrivait jamais à l'écran. Même règle que `repondreEchec` : seul un
     * refus de Meta porte un message écrit pour le client ; une panne (réseau, délai, notre base) garde le 502, une
     * phrase opaque, et sa cause au journal.
     */
    if (issue.sorte === 'annulee' || issue.sorte === 'echec_creation') {
      // Journalisé dans les deux cas : c'est la seule trace d'un refus que l'écran a pu fermer trop vite, et la seule
      // cause lisible d'une panne.
      journaliser('warn', 'création de publicité non aboutie', {
        tenantId, issue: issue.sorte, refusMeta: issue.refusMeta, raison: issue.raison,
      });
    }
    if (issue.sorte === 'annulee') {
      // Rien n'existe chez Meta, et ce code le dit.
      return issue.refusMeta
        ? reply.code(422).send({ error: issue.raison, code: 'creation_refusee' })
        : reply.code(502).send({ error: PANNE_OPAQUE, code: 'creation_refusee' });
    }
    await journal(tenantId, req, 'pubs.creee', { kind: 'publicite', id: issue.publiciteId },
      {
        campagneId: issue.campagneId, destination: f.destination, budgetTotal: f.budgetTotal, issue: issue.sorte,
        visuel: f.video !== undefined ? 'video' : 'image',
        audiencesIncluses: f.audiencesIncluses.length, audiencesExclues: f.audiencesExclues.length,
      });
    if (issue.sorte === 'echec_creation') {
      // L'identifiant de la ligne part dans les deux cas : un objet peut subsister chez Meta, et la liste le montre.
      return reply.code(issue.refusMeta ? 422 : 502).send({
        error: issue.refusMeta ? issue.raison : PANNE_OPAQUE,
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

  /**
   * Archiver ou désarchiver : un rangement d'écran, rien ne part chez Meta. Refusé (409) sur une publicité qui
   * peut diffuser, sinon le client rangerait hors de sa vue une campagne qui dépense.
   */
  for (const [chemin, archiver, action] of [
    ['archiver', true, 'pubs.archivee'],
    ['desarchiver', false, 'pubs.desarchivee'],
  ] as const) {
    app.post(`/tenants/:tenantId/pubs/:id/${chemin}`, opts, async (req, reply) => {
      const tenantId = espaceVerifie(req);
      if (forbidNonAdmin(req, reply)) return;
      const { id } = req.params as { id: string };
      const issue = await deps.publicites.archiver(tenantId, id, archiver);
      if (issue === 'introuvable') return reply.code(404).send({ error: 'cette publicité n’existe pas' });
      if (issue === 'diffuse') {
        return reply.code(409).send({ error: 'mettez d’abord cette publicité en pause : elle diffuse encore', code: 'diffuse' });
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
