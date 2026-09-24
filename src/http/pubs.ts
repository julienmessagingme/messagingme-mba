import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidNonAdmin, gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { scopeTenant } from './scope';
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
 * LES PUBLICITÉS D'UN ESPACE : sa connexion (lot 2, spec § 3.1), puis ses campagnes (lot 3, § 3.2 et § 3.5).
 *
 * La connexion : lire l'état, échanger le code rendu par la fenêtre Meta, choisir le compte et la Page, se
 * déconnecter. Les campagnes : lister, créer, publier, lire une page, mettre en pause, reprendre.
 *
 * ⚠️ LE COMPTE DES ROUTES N'EST PAS ÉCRIT ICI, et ce n'est pas un oubli : cette phrase a dit « quatre
 * routes » jusqu'au lot 3, où il y en avait déjà neuf. Un nombre en prose devient faux au premier ajout,
 * sans que rien ne le signale ; la liste des `app.get` / `app.post` ci-dessous fait foi.
 *
 * 🔴 LE JETON N'ENTRE JAMAIS DANS CE FICHIER, exactement comme dans `EmbeddedSignupRouteDeps` : le câblage
 * l'échange, le chiffre et le range, et ne laisse passer que le `tenantId`. Un jeton qui n'entre pas dans une
 * route ne peut ni fuiter dans un journal, ni partir dans un corps de réponse, ni être lu dans une trace de
 * pile.
 *
 * 🔴 AUCUNE DÉPENDANCE OPTIONNELLE, garde et plafond compris. Le dépôt a payé ce motif deux fois : la garde
 * d'authentification déclarée `guard?`, puis `estDesabonne?`, qui a fait écrire à des contacts désabonnés.
 * Un câblage qui en oublie une ne compile pas.
 */
export interface PubsRouteDeps {
  /**
   * `config_id` de la configuration Facebook Login for Business « publicités ». VIDE = fonctionnalité
   * éteinte, et l'écran le dit au lieu d'ouvrir une fenêtre qui échouerait.
   */
  configId: string;
  /** App ID Meta (public : sert au `FB.init` du front). */
  appId: string;
  graphVersion: string;
  /** L'état de la connexion, SANS le jeton. */
  lire(tenantId: string): Promise<ConnexionPub | null>;
  /**
   * Le compte publicitaire peut-il diffuser ? Lu EN DIRECT chez Meta, `null` si on ne sait pas.
   *
   * 🔴 `null` N'EST PAS « TOUT VA BIEN » : c'est « je n'ai pas pu demander » (pas de connexion, ou Meta
   * muet). L'écran doit le dire ainsi, sinon un compte bloqué passerait pour prêt.
   */
  etatCompte(tenantId: string): Promise<EtatComptePub | null>;
  /** Échange le code (TTL 30 s), chiffre le jeton, le range, et rend ce que ce jeton accorde. */
  connecter(tenantId: string, code: string, userId: string | null): Promise<ActifsAccordes>;
  /** Ce que le jeton DÉJÀ rangé accorde. Sert à vérifier un choix, donc relu chez Meta, pas en base. */
  actifsAccordes(tenantId: string): Promise<ActifsAccordes>;
  /** Enregistre le choix après avoir lu chez Meta la devise, le fuseau et l'état de la liaison. */
  choisir(tenantId: string, choix: { comptePubId: string; pageId: string }): Promise<ConnexionPub>;
  /**
   * Efface la connexion, APRÈS avoir tenté de retirer notre accès chez Meta.
   *
   * ⚠️ LE BOOLÉEN NE VA PLUS À L'ÉCRAN, il va au JOURNAL D'AUDIT (décision de Julien du 2026-09-23). Le
   * client n'est pas averti : un jeton que nous n'avons pas gardé n'est détenu par personne, et les deux
   * gestes qu'on pourrait lui prescrire chez Meta cassent chacun quelque chose. Ce que le booléen sert
   * désormais, c'est à MESURER si le retrait fonctionne sur un jeton d'utilisateur système.
   */
  deconnecter(tenantId: string): Promise<{ revoqueChezMeta: boolean }>;
  /** Les publicités de l'espace, la plus récente d'abord. */
  listerPubs(tenantId: string): Promise<Publicite[]>;
  /**
   * Les BROUILLONS de l'espace, le plus récemment modifié d'abord, SANS les octets des visuels.
   *
   * 🔴 « SANS LES OCTETS » EST UN CONTRAT, PAS UN DÉTAIL : un brouillon peut porter 5 Mo d'image, et les
   * transporter tous à chaque ouverture de l'écran transformerait la liste en téléchargement. Seule
   * `lireBrouillon` a le droit de les lire.
   */
  listerBrouillons(tenantId: string): Promise<BrouillonPub[]>;
  /** Un brouillon AVEC son visuel, pour repeupler le formulaire. `null` = inconnu dans cet espace. */
  lireBrouillon(tenantId: string, id: string): Promise<BrouillonPubComplet | null>;
  creerBrouillon(tenantId: string, c: ChampsBrouillon): Promise<string>;
  /** `false` = le brouillon n'existe pas dans cet espace, ce que la route rend en 404. */
  majBrouillon(tenantId: string, id: string, c: ChampsBrouillon): Promise<boolean>;
  supprimerBrouillon(tenantId: string, id: string): Promise<boolean>;
  /**
   * Crée la publicité chez Meta, EN PAUSE, et range ce qui en revient.
   *
   * ⚠️ ELLE NE LÈVE PAS SUR UN REFUS DE META : tout sort par `IssueCreation`, parce que la route doit rendre
   * le message de Meta au client, et distinguer « rien n'a été créé » de « quelque chose subsiste ».
   */
  creerPub(tenantId: string, d: Omit<DemandeCreation, 'comptePubId' | 'pageId' | 'numeroWhatsApp'>): Promise<IssueCreation>;
  /** Allume l'automation PUIS Meta. Lève si Meta refuse : l'ordre est la règle, pas le succès. */
  publierPub(tenantId: string, publiciteId: string): Promise<void>;
  /** Une publicité et son entonnoir. `null` = elle n'existe pas dans cet espace. */
  lirePub(tenantId: string, publiciteId: string): Promise<{ publicite: Publicite; entonnoir: Entonnoir } | null>;
  /**
   * Met la CAMPAGNE en pause chez Meta, ou la relance.
   *
   * 🔴 L'AUTOMATION RESTE ALLUMÉE dans les deux sens, et c'est une décision de la spec (§ 3.5). Un prospect
   * qui a cliqué juste avant la pause peut écrire plusieurs minutes plus tard : éteindre l'automation en
   * même temps ferait tomber ce lead dans le vide, alors qu'il a été payé.
   */
  basculerPub(tenantId: string, publiciteId: string, actif: boolean): Promise<void>;
  audit: AuditSink;
}

/**
 * 🔴 NOTRE PANNE N'EST PAS UN REFUS DE META, et les confondre coûte deux fois. La route enveloppait
 * l'appel à Meta ET l'écriture en base dans un seul `catch` à 502 : une table absente rendait à l'admin le
 * texte brut d'une erreur Postgres sous le message « échange refusé par Meta », sans aucune trace serveur,
 * et surtout SANS DIRE que Meta venait d'émettre un jeton sans expiration dont nous perdions le seul
 * exemplaire. Relevé en relecture à froid le 2026-09-23.
 */
export class JetonNonEnregistre extends Error {
  constructor(readonly cause: unknown) {
    super('jeton publicitaire non enregistré');
    this.name = 'JetonNonEnregistre';
  }
}

/**
 * 🔴 UNE CONNEXION EXISTE DÉJÀ, et on ne l'écrase pas. Le jeton en place n'expire jamais : le remplacer
 * sans l'avoir révoqué laisserait un accès vivant dont nous perdrions le seul exemplaire. Pour reconnecter,
 * il faut passer par la déconnexion, qui révoque d'abord. Un appel DIRECT à la route reçoit donc 409, et
 * pas seulement celui qui passe par le bouton : l'invariant ne dépend plus de l'écran.
 */
export class DejaConnectePub extends Error {
  /**
   * `jetonOrphelin` : Meta avait DÉJÀ émis un jeton quand on s'en est aperçu (la course). Le cas
   * ordinaire est refusé AVANT l'échange, donc à `false`.
   *
   * ⚠️ IL NE CHANGE PAS LE MESSAGE RENDU AU CLIENT : on ne lui demande aucun geste chez Meta, et la
   * raison est écrite sur le `catch` de la route. Il sert à TRACER l'événement côté serveur.
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
 * LA CONNEXION EST INCOMPLÈTE : le compte publicitaire ou la Page n'a pas été choisi. On ne peut pas créer.
 *
 * ⚠️ Une erreur NOMMÉE plutôt qu'un 400 générique : c'est un état du parcours, pas une saisie fautive, et
 * l'écran doit envoyer le client finir sa connexion au lieu de lui faire relire son formulaire.
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
 * LE FORMULAIRE DE CRÉATION (lot 3, spec § 3.2). Minimal, et chaque borne a une raison.
 *
 * 🔴 `budgetTotal` ET `fin` SONT OBLIGATOIRES, ET C'EST LE GARDE-FOU DU PRODUIT. Sans eux, une publicité
 * dépense sans limite et sans terme sur le compte du client. Meta exige d'ailleurs la même chose
 * (`lifetime_budget` impose `end_time`) : la contrainte technique et la décision produit disent la même
 * chose, ce qui n'est pas un hasard.
 *
 * 🔴 `horsCategorieSpeciale` DOIT VALOIR `true`. Une publicité de logement, d'emploi, de crédit ou de
 * politique impose un ciblage restreint et des obligations légales que cet écran ne sait pas porter. On ne
 * la refuse pas au client : on l'envoie dans le Gestionnaire, qui les porte.
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
    // La taille est vérifiée sur les OCTETS décodés, pas sur la longueur du base64 : cette borne-ci n'est
    // qu'un premier filet, large de la surcharge de l'encodage.
    base64: z.string().min(1).max(Math.ceil(TAILLE_VISUEL_PUB_MAX * 1.4)),
  }),
}).strict();

/**
 * LE CORPS D'UN BROUILLON, ET IL EST DÉLIBÉRÉMENT PERMISSIF LÀ OÙ LA CRÉATION EST STRICTE.
 *
 * 🔴 AUCUN CHAMP N'EST OBLIGATOIRE, ET C'EST TOUT L'INTÉRÊT. Un brouillon sert à garder un travail
 * INCOMPLET : exiger un budget positif ou une date valide refuserait précisément les brouillons qu'on veut
 * pouvoir poser. La validation stricte reste au seul endroit où elle protège quelque chose, `corpsCreation`,
 * c'est-à-dire l'appel qui engage l'argent du client chez Meta.
 *
 * ⚠️ CE QUI RESTE BORNÉ MALGRÉ TOUT, parce que ce sont des frontières et pas de l'hygiène : les LONGUEURS
 * (une table n'est pas un champ libre de taille infinie), l'ÉNUMÉRATION de la destination, la FORME de
 * l'identifiant de scénario, le TYPE du visuel, et `.strict()` qui refuse toute clé inconnue. Un brouillon
 * permissif sur son contenu n'est pas une porte dérobée pour écrire n'importe quoi en base.
 *
 * ⚠️ `image` A TROIS SENS ICI, et il en faut trois : ABSENTE = ne touche pas au visuel déjà enregistré,
 * `null` = efface-le, un objet = remplace-le. Sans le premier, chaque enregistrement d'une modification de
 * texte effacerait l'image, ce qui viderait de son sens la décision de la garder.
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
 * CE QUE VALENT VRAIMENT DES OCTETS D'IMAGE. Rend le message de refus, ou `null` si le visuel passe.
 *
 * 🔴 UNE SEULE FONCTION POUR LES DEUX ROUTES, ET C'EST LA CORRECTION D'UNE ASYMÉTRIE. La création
 * portait ces trois contrôles EN LIGNE ; les routes de brouillon, écrites après, n'en portaient aucun et
 * se contentaient d'une borne de LONGUEUR sur la chaîne base64, c'est-à-dire sur une taille ENCODÉE et
 * sur un type seulement DÉCLARÉ. Relevé par une relecture à froid avant tout déploiement.
 *
 * ⚠️ LE PLAN NOMMAIT CETTE GARDE et le code ne la tenait pas : « le plafond est celui du formulaire,
 * vérifié côté serveur COMME À LA CRÉATION ». C'est le motif « une capacité câblée sur un consommateur
 * sur deux », déjà payé plusieurs fois ici. Recopier les trois contrôles dans la seconde route aurait
 * refermé le trou du jour ; les factoriser empêche le prochain.
 *
 * 🔴 LE TYPE SE LIT DANS LES OCTETS, PAS DANS CE QUE LE CLIENT DÉCLARE. Le champ `type` du corps est une
 * chaîne que le navigateur choisit : la valider contre une énumération ne prouve rien sur le CONTENU. Sur
 * la création, ces octets partent chez un tiers sous l'identité du client ; sur un brouillon, ils sont
 * relus plus tard et rendus au navigateur en `data:` URL. Les deux chemins méritent la même lecture.
 */
function refusDuVisuel(base64: string): string | null {
  // ⚠️ LA TAILLE SE VÉRIFIE SUR LES OCTETS DÉCODÉS, pas sur la longueur du base64 : l'encodage ajoute un
  // tiers, donc une borne posée sur la chaîne refuserait des images conformes ou en laisserait passer de
  // trop grandes selon le remplissage. C'est la même erreur de catégorie que compter des `.length` UTF-16
  // pour un plafond en octets (cf. `lireCorpsBorne`). Cette justification a suivi le décodage quand il a
  // été factorisé ici : laissée au point d'appel, elle expliquait un contrôle qui n'y était plus.
  const octets = Buffer.from(base64, 'base64');
  if (octets.length === 0) return 'ce visuel est illisible';
  if (!estJpegOuPng(octets)) return 'ce fichier n’est pas une image JPEG ou PNG';
  if (octets.length > TAILLE_VISUEL_PUB_MAX) {
    return `ce visuel dépasse ${Math.round(TAILLE_VISUEL_PUB_MAX / (1024 * 1024))} Mo`;
  }
  return null;
}

/**
 * Du corps validé vers ce que le store attend.
 *
 * 🔴 UNE CLÉ `image` ABSENTE DOIT LE RESTER, d'où le spread conditionnel et non un `visuel: c.image`.
 * Écrire `visuel: undefined` poserait la propriété avec la valeur `undefined`, ce qui est indiscernable
 * d'un effacement pour un code qui teste `'visuel' in c` et fragile pour celui qui teste `=== undefined`.
 * Le seul énoncé qui tient dans les deux lectures est de ne pas poser la clé du tout.
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
  // LES TROIS ÉCRITURES appellent Meta (l'échange, le choix, et la déconnexion depuis qu'elle révoque) :
  // elles portent toutes le plafond des routes coûteuses, par espace.
  //
  // ⚠️ LA LECTURE APPELLE META ELLE AUSSI DEPUIS LE 2026-09-23, et cette phrase disait le contraire.
  // Elle reste hors du plafond coûteux DÉLIBÉRÉMENT : c'est l'ouverture d'un écran, et dix par minute
  // et par ESPACE couperaient la page dès que deux personnes la consultent. Ce qui la borne est
  // ailleurs, et c'est ce qui rend l'arbitrage tenable : un micro-cache côté câblage
  // (`src/index.ts`, `etatComptePubCache`) fait qu'un rafraîchissement n'appelle pas Meta, le plafond
  // par UTILISATEUR (300/min) s'applique comme sur toute route gardée, et l'appel lui-même porte un
  // plafond de durée (`ClientGraph`), sans quoi un Meta muet retiendrait le gestionnaire pour toujours.
  const couteux = gardeEtendue(garde, limiteCouteuse);
  const journal = makeJournal(deps.audit);

  app.get('/tenants/:tenantId/pubs/connexion', opts, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    const connexion = await deps.lire(tenantId);
    // ⚠️ BEST-EFFORT, ET C'EST DÉLIBÉRÉ : cet état vient de Meta, et une panne chez eux ne doit pas
    // empêcher d'AFFICHER une connexion qu'on lit, elle, dans notre base. `null` dit « je n'ai pas pu
    // demander », jamais « tout va bien ».
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
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    if (forbidNonAdmin(req, reply)) return;
    if (deps.configId === '') return reply.code(503).send({ error: 'publicités non configurées (META_ADS_CONFIG_ID)' });
    const corps = corpsEchange.safeParse(req.body);
    if (!corps.success) return reply.code(400).send({ error: 'code manquant' });

    let actifs: ActifsAccordes;
    try {
      actifs = await deps.connecter(tenantId, corps.data.code, req.auth?.userId ?? null);
    } catch (err) {
      // 🔴 ON NE DEMANDE AU CLIENT AUCUN GESTE CHEZ META, ET C'EST UNE DÉCISION, PAS UN OUBLI.
      // Deux raisons qui se renforcent. D'abord le produit : un jeton que nous n'avons pas gardé n'est
      // détenu par PERSONNE, donc il n'y a rien à fermer (décision de Julien du 2026-09-23). Ensuite le
      // danger : lui faire retirer les permissions publicitaires retirerait aussi celles de la connexion
      // qui MARCHE, puisque le retrait porte sur le couple (application, entité) et non sur un jeton ; et
      // lui faire retirer l'application ferait taire son numéro WhatsApp. Les deux gestes cassent quelque
      // chose pour fermer un accès que nul ne peut exercer.
      if (err instanceof DejaConnectePub) {
        return reply.code(409).send({
          error: 'cet espace a déjà une connexion publicitaire. Déconnectez-la d’abord : c’est ce geste qui '
            + 'retire notre accès chez Meta.',
          code: 'deja_connecte',
        });
      }
      if (err instanceof JetonNonEnregistre) {
        return reply.code(500).send({
          // 🔴 AUCUN GESTE PRESCRIT CHEZ META, pour les deux raisons écrites plus bas sur le 409 : le
          // jeton perdu n'est détenu par personne, et les deux gestes possibles cassent quelque chose
          // (les permissions publicitaires emportent la connexion voisine, l'application emporte le
          // numéro WhatsApp). On dit donc ce qui s'est passé, et ce qui se fait CHEZ NOUS.
          error: 'la connexion a été accordée par Meta mais n’a pas pu être enregistrée de notre côté. '
            + 'Réessayez : si le problème persiste, c’est chez nous qu’il faut chercher, pas chez Meta.',
          code: 'jeton_non_enregistre',
        });
      }
      // Le code a 30 secondes de vie et ne sert qu'une fois : l'échec le plus courant est un client qui a
      // laissé la fenêtre ouverte. On rend le message de Meta, c'est SON compte, et lui seul peut agir.
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'échange refusé par Meta' });
    }
    await journal(tenantId, req, 'pubs.connectee', { kind: 'pub_connexion', id: tenantId },
      { comptes: actifs.comptesPub.length, pages: actifs.pages.length });
    return reply.send(actifs);
  });

  app.post('/tenants/:tenantId/pubs/connexion/choix', couteux, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const corps = corpsChoix.safeParse(req.body);
    if (!corps.success) return reply.code(400).send({ error: 'choix invalide' });

    /**
     * 🔴 LE CHOIX SE VÉRIFIE CONTRE CE QUE LE JETON ACCORDE, ET CETTE LISTE SE RELIT CHEZ META.
     * Les identifiants viennent du navigateur : sans ce contrôle, un admin pourrait enregistrer le compte
     * publicitaire d'une autre entreprise, que nos appels utiliseraient ensuite en son nom. La relire en
     * base au lieu de chez Meta la rendrait périmée au premier retrait de droit côté client.
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
    // `act_123` et `123` désignent le MÊME compte : un appelant qui recopie l'identifiant vu dans le
    // Gestionnaire de publicités enverrait la forme préfixée, et se verrait refuser un compte qu'il a
    // pourtant accordé. On compare, et on enregistre, la forme nue.
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
      // ⚠️ LE MÊME CAS QUE PLUS HAUT, ET IL ÉTAIT TRAITÉ D'UN SEUL CÔTÉ : `choisir` lit le jeton lui aussi,
      // donc un autre onglet qui déconnecte pendant qu'on valide son choix faisait rendre 502 avec NOTRE
      // phrase sous un statut qui accuse Meta.
      if (err instanceof PasDeConnexionPub) return reply.code(409).send({ error: err.message, code: 'pas_connecte' });
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Meta ne répond pas' });
    }
    await journal(tenantId, req, 'pubs.actifs_choisis', { kind: 'pub_connexion', id: tenantId },
      { comptePubId: connexion.comptePubId, pageId: connexion.pageId, pageLiee: connexion.pageLiee });
    return reply.send({ connexion });
  });

  app.get('/tenants/:tenantId/pubs', opts, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    return reply.send({ publicites: await deps.listerPubs(tenantId) });
  });

  /**
   * LES BROUILLONS. Cinq routes qui ne touchent JAMAIS Meta : un brouillon est un formulaire mémorisé.
   *
   * ⚠️ `/pubs/brouillons` COEXISTE AVEC `/pubs/:id`, et c'est Fastify qui les départage : un segment
   * STATIQUE l'emporte sur un segment paramétré, quel que soit l'ordre d'enregistrement. On les déclare
   * quand même avant, pour que la lecture du fichier dise la même chose que le routeur.
   *
   * ⚠️ ADMIN POUR LES ÉCRITURES, comme partout dans ce module. Un brouillon ne dépense rien, mais il
   * prépare une dépense et il porte le visuel : le laisser ouvert à tout le monde ferait de cette table
   * le seul endroit du produit où un compte non admin écrit des mégaoctets.
   */
  const optsBrouillon = { ...opts, bodyLimit: Math.ceil(TAILLE_VISUEL_PUB_MAX * 1.4) };

  app.get('/tenants/:tenantId/pubs/brouillons', opts, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    return reply.send({ brouillons: await deps.listerBrouillons(tenantId) });
  });

  app.get('/tenants/:tenantId/pubs/brouillons/:id', opts, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    const { id } = req.params as { id: string };
    const b = await deps.lireBrouillon(tenantId, id);
    if (b === null) return reply.code(404).send({ error: 'ce brouillon n’existe pas' });
    return reply.send({ brouillon: b });
  });

  app.post('/tenants/:tenantId/pubs/brouillons', optsBrouillon, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const lu = corpsBrouillon.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'brouillon invalide' });
    // Même lecture des octets qu'à la création : un brouillon n'est pas une porte dérobée pour écrire
    // n'importe quoi en base, et le plan le posait comme l'une des deux gardes du stockage du visuel.
    const refus = lu.data.image ? refusDuVisuel(lu.data.image.base64) : null;
    if (refus !== null) return reply.code(400).send({ error: refus });
    const id = await deps.creerBrouillon(tenantId, versChamps(lu.data));
    return reply.code(201).send({ id });
  });

  app.put('/tenants/:tenantId/pubs/brouillons/:id', optsBrouillon, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const lu = corpsBrouillon.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'brouillon invalide' });
    // ⚠️ `image` ABSENTE ne passe pas ici, et c'est correct : il n'y a pas d'octets neufs à juger, et
    // ceux qui sont déjà en base ont été lus à leur écriture. Seul un visuel FOURNI se vérifie.
    const refus = lu.data.image ? refusDuVisuel(lu.data.image.base64) : null;
    if (refus !== null) return reply.code(400).send({ error: refus });
    const trouve = await deps.majBrouillon(tenantId, id, versChamps(lu.data));
    if (!trouve) return reply.code(404).send({ error: 'ce brouillon n’existe pas' });
    return reply.code(204).send();
  });

  app.delete('/tenants/:tenantId/pubs/brouillons/:id', opts, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const trouve = await deps.supprimerBrouillon(tenantId, id);
    if (!trouve) return reply.code(404).send({ error: 'ce brouillon n’existe pas' });
    return reply.code(204).send();
  });

  /**
   * CRÉER UNE PUBLICITÉ. Tout est créé EN PAUSE chez Meta : cette route ne fait dépenser personne.
   *
   * 🔴 `bodyLimit` DÉDIÉ, comme l'import de documents : le visuel transite en base64, donc environ un tiers
   * de plus que sa taille réelle. Sans lui, le plafond global d'un mégaoctet refuserait toute image un peu
   * grande avec une erreur qui ne parle ni d'image ni de taille.
   *
   * ⚠️ Plafond des routes coûteuses ET réservée aux admins : elle engage l'argent du client chez un tiers.
   */
  const optsCreation = { ...couteux, bodyLimit: Math.ceil(TAILLE_VISUEL_PUB_MAX * 1.4) };
  app.post('/tenants/:tenantId/pubs', optsCreation, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
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
    // Les trois contrôles des octets vivent dans `refusDuVisuel`, partagé avec les routes de brouillon :
    // deux copies d'une même garde finissent toujours par diverger, et c'est arrivé ici.
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
      // 🔴 RIEN N'EXISTE CHEZ META, et c'est ce que ce statut dit. On rend le message de Meta tel quel :
      // c'est SON compte, et lui seul peut agir sur ce qu'il refuse. Pas de repli silencieux.
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
   * PUBLIER. C'est le SEUL geste de ce module qui fait dépenser de l'argent, et il est irréversible au sens
   * où une impression payée ne se rembourse pas.
   *
   * 🔴 L'ORDRE EST DANS `publierLaPublicite`, PAS ICI : l'automation s'allume AVANT Meta. Le rappeler dans
   * cette route ferait deux endroits où le savoir, et le second finirait par mentir.
   */
  app.post('/tenants/:tenantId/pubs/:id/publier', couteux, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    try {
      await deps.publierPub(tenantId, id);
    } catch (err) {
      // ⚠️ UN REFUS N'EST PAS UNE PANNE DE META : 409, et le message dit ce qu'il faut réparer. Un 502
      // enverrait le client chercher un problème chez Meta, qui n'a même pas été appelé.
      if (err instanceof PublicationRefusee) return reply.code(409).send({ error: err.message, code: 'publication_refusee' });
      if (err instanceof PasDeConnexionPub) return reply.code(409).send({ error: err.message, code: 'pas_connecte' });
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Meta ne répond pas' });
    }
    await journal(tenantId, req, 'pubs.publiee', { kind: 'publicite', id }, {});
    return reply.send({ ok: true });
  });

  /**
   * LA PAGE D'UNE PUBLICITÉ : son statut chez Meta, son entonnoir, ses prospects non pris en charge.
   *
   * ⚠️ HORS du plafond coûteux, comme la lecture de la connexion : c'est l'ouverture d'un écran, et elle ne
   * lit que NOS tables (le suivi, lui, relit Meta toutes les quinze minutes, en fond).
   */
  app.get('/tenants/:tenantId/pubs/:id', opts, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    const { id } = req.params as { id: string };
    const vue = await deps.lirePub(tenantId, id);
    if (vue === null) return reply.code(404).send({ error: 'cette publicité n’existe pas' });
    return reply.send(vue);
  });

  /**
   * METTRE EN PAUSE, OU RELANCER. Le seul geste de ce module qui change ce que Meta diffuse sans rien créer.
   *
   * 🔴 LA PAUSE DOIT RESTER POSSIBLE MÊME QUAND TOUT VA MAL, et c'est pour ça qu'elle ne vérifie rien de
   * plus que l'identité de l'appelant. C'est le bouton d'arrêt d'une dépense : lui ajouter une condition
   * (l'état local, la fraîcheur du suivi, la validité de la connexion) créerait un cas où un client voit sa
   * campagne dépenser et ne peut pas l'arrêter depuis notre écran.
   */
  for (const [chemin, actif, action] of [
    ['pause', false, 'pubs.pausee'],
    ['reprendre', true, 'pubs.reprise'],
  ] as const) {
    app.post(`/tenants/:tenantId/pubs/:id/${chemin}`, couteux, async (req, reply) => {
      const tenantId = scopeTenant(req);
      if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
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

  // `couteux` et non `opts` : depuis qu'elle révoque chez Meta, cette route appelle l'extérieur comme les
  // autres écritures du module. ⚠️ Elle n'est PLUS « le seul geste irréversible » depuis le lot 3 : créer
  // une publicité crée des objets sur le compte du client, et la publier engage son budget. Ce qui lui
  // reste en propre, c'est d'être la seule à DÉTRUIRE quelque chose chez nous.
  app.delete('/tenants/:tenantId/pubs/connexion', couteux, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { revoqueChezMeta } = await deps.deconnecter(tenantId);
    await journal(tenantId, req, 'pubs.deconnectee', { kind: 'pub_connexion', id: tenantId }, { revoqueChezMeta });
    return reply.send({ ok: true, revoqueChezMeta });
  });
}

/**
 * CES OCTETS SONT-ILS UN JPEG OU UN PNG ? Lu sur la SIGNATURE du fichier, la seule chose qu'un client ne
 * peut pas nous faire croire en changeant un champ de son formulaire.
 *
 * ⚠️ CE N'EST PAS UN DÉCODEUR D'IMAGE, et ça n'a pas à l'être : Meta refusera de toute façon un fichier
 * corrompu, avec son message. Ce que cette garde ferme, c'est l'envoi d'un SVG (un document exécutable) ou
 * de n'importe quoi d'autre sous une étiquette `image/png`.
 */
function estJpegOuPng(o: Buffer): boolean {
  // JPEG : FF D8 FF. PNG : 89 50 4E 47 0D 0A 1A 0A.
  if (o.length >= 3 && o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return true;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return o.length >= png.length && png.every((b, i) => o[i] === b);
}
