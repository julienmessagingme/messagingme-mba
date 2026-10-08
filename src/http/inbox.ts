import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Guard, PreHandler } from '../auth/middleware';
import type { ConversationSummary, ConversationMessage, ListConversationsOptions, CompteursInbox } from '../inbox/store.pg';
import type { OutboundCarouselCard } from '../meta/template-components';
import { espaceVerifie, nonEmpty, estUuid } from './scope';
import { RCS_TEXTE_MAX } from '../rcs/schema';
import { peutEcrire, peutAffecter, peutPrendre } from '../inbox/assignment';
import { gardeEtendue } from '../auth/middleware';
import { cacheCourt } from '../lib/cache-court';
import { journaliser } from '../lib/journal';
import { CreditEpuise, RienATranscrire } from '../inbox/transcrire';
import { MediaTropGros } from '../meta/media';
import { MediaExpire, enTetesMedia } from '../inbox/media-entrant';
import { makeJournal, type AuditSink } from '../audit/journal';
import { repondreDansLaFenetre, type ConversationsRepondre, type DepsRepondre } from '../inbox/repondre';
import { estCodeLangue, estLangueConsole, TEXTE_MAX_CARACTERES, type CauseSansTraduction, type LangueConsole, type Traduction } from '../traduction/traduire';
import type { FilTraduit } from '../traduction/fil';
import { messageDe } from '../lib/erreur';
import type { AuteurDuChangement, DetailConversation } from '../inbox/evenements';

/**
 * Durée de vie du micro-cache des compteurs de l'Inbox : 5 secondes, ce qui mutualise les utilisateurs d'un même
 * client sur une requête sans qu'un compteur devienne visiblement faux. Les écritures de l'Inbox invalident la clé
 * de l'espace ; seul un message entrant (traité par le worker, autre cache) peut retarder un compteur de 5 s.
 */
const COMPTEURS_TTL_MS = 5_000;

/** Template à envoyer dans une conversation (hors fenêtre 24 h). */
export interface OutboundTemplate {
  name: string;
  language: string;
  /** Valeurs des variables du corps {{1}}, {{2}}... dans l'ordre. */
  bodyParams: string[];
  /** URL publique du média de header (image/vidéo/document), si le template en a un. */
  headerMediaUrl?: string;
  /** Format du header média, pour construire le bon type de paramètre côté Meta. */
  headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  /** Cartes d'un template carousel, visuels déjà re-téléversés (`mediaId`). Absent = template classique. */
  carousel?: { cards: OutboundCarouselCard[] };
}

/** Ce que les routes lisent et écrivent des conversations. */
export interface InboxDep extends ConversationsRepondre {
  /**
   * Efface le contenu d'une conversation. Rend le nombre de messages effacés, `null` si elle n'est pas de cet
   * espace. 🔴 Réservé aux administrateurs par la garde de `server.ts`, et tracé au Journal des actions sans le
   * numéro ni le texte (y écrire ce qu'on efface annulerait l'effacement).
   */
  effacerMessages(tenantId: string, conversationId: string): Promise<number | null>;
  listConversations(tenantId: string, opts?: ListConversationsOptions): Promise<ConversationSummary[]>;
  /**
   * Trouve ou crée la conversation d'un contact, et rend son identifiant (`null` = contact inconnu de cet
   * espace, supprimé, ou sans aucune identité joignable).
   */
  ouvrirConversationDuContact(tenantId: string, contactId: string): Promise<string | null>;
  /** Nombre de conversations non lues (pastille du menu). 0 -> la pastille ne s'affiche pas. */
  countUnread(tenantId: string, acteur: { userId: string | null; role: string | null }): Promise<number>;
  /** Nombre de conversations « À traiter ». */
  countATraiter(tenantId: string): Promise<number>;
  /** Les compteurs du menu de dossiers, plus la charge par membre. */
  compterConversations(tenantId: string): Promise<CompteursInbox>;
  /**
   * Range une conversation dans Archivé, ou l'en sort. `false` = inconnue dans cet espace -> 404. `par` : qui le
   * fait, pour le journal du panneau Détail (les écritures de l'Inbox disent toutes qui les demande).
   */
  archiverConversation(tenantId: string, conversationId: string, archive: boolean, par: AuteurDuChangement): Promise<boolean>;
  /**
   * Signale une conversation à la main, ou retire ce signalement. N'écrit pas le constat de l'analyse : le
   * dossier « Signalé » réunit les deux sources.
   */
  signalerConversation(tenantId: string, conversationId: string, signale: boolean, par: AuteurDuChangement): Promise<boolean>;
  /**
   * Marque une conversation urgente, ou retire l'urgence (migration 0216). `false` = inconnue dans cet espace -> 404.
   * Une décision, pas un constat : la note d'urgence de l'analyse n'y entre pour rien.
   */
  marquerUrgente(tenantId: string, conversationId: string, urgente: boolean, par: AuteurDuChangement): Promise<boolean>;
  /**
   * Marque une conversation « Traité », ou retire ce statut. `false` = inconnue dans cet espace -> 404.
   */
  marquerTraitee(tenantId: string, conversationId: string, traitee: boolean, par: AuteurDuChangement): Promise<boolean>;
  /**
   * À qui la conversation est confiée. `undefined` = conversation inconnue, `null` = confiée à personne.
   */
  getAssignee(tenantId: string, conversationId: string): Promise<string | null | undefined>;
  /** Affecte (ou libère avec `null`). `false` = conversation inconnue, ou membre étranger au tenant. */
  setAssignee(tenantId: string, conversationId: string, assignee: string | null, par: AuteurDuChangement): Promise<boolean>;
  /**
   * Prend une conversation du pot commun pour `userId`, seulement si elle est à personne. `false` = inconnue ou
   * déjà prise : la route relit l'affectation pour dire lequel.
   */
  prendreSiLibre(tenantId: string, conversationId: string, userId: string): Promise<boolean>;
  /**
   * Les membres à qui l'encadrement peut confier une conversation (id + nom affichable). Une liste vide : le
   * sélecteur ne propose que « Non affectée ».
   */
  membresPourAffectation(tenantId: string): Promise<Array<{ id: string; nom: string }>>;
  /** Marque un fil comme lu (un opérateur vient de l'ouvrir). */
  markConversationRead(tenantId: string, conversationId: string): Promise<void>;
  /**
   * wa_id et état de la fenêtre de service 24 h. `null` si conversation absente, ou d'un autre espace.
   * `langueContact` : la langue apprise du contact, `null` tant qu'on n'a rien appris (pas « français » : le
   * bouton de traduction sortante nomme sa cible avec).
   */
  getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean; langueContact?: string | null } | null>;
  getMessages(conversationId: string, apres?: { at: string; id: string }): Promise<ConversationMessage[]>;
  /** Détenteur courant du fil, pour l'afficher dans le détail de la conversation. */
  getControlOwner(tenantId: string, waId: string): Promise<'app_workflow' | 'app_human' | 'mba'>;
  /**
   * Le panneau Détail : identité, résumé de l'analyse, assignation, et les 50 derniers événements. `null` =
   * inconnue dans cet espace OU invisible de cet acteur (la règle de `src/inbox/assignment.ts`) : les deux
   * rendent 404, un agent n'apprend pas qu'une conversation existe chez un collègue.
   */
  detailConversation(tenantId: string, conversationId: string, acteur: { userId: string | null; role: string | null }): Promise<DetailConversation | null>;
}

export interface InboxRouteDeps extends DepsRepondre {
  inbox: InboxDep;
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Au mieux à l'appel : une action
   * bloquée par une écriture de log serait un incident.
   */
  audit: AuditSink;
  /**
   * Transcrit le vocal d'un message, à la demande. Optionnelle : absente, la route rend 503 (une instance sans
   * clé de modèle garde son Inbox). Rend `deja` quand le message était déjà transcrit, pour que l'écran le dise.
   */
  transcrireMessage?(
    tenantId: string,
    messageId: string,
    conversationId?: string,
    /**
     * La langue du lecteur, quand la traduction est allumée dans son navigateur. On traduit la transcription, pas
     * le corps (`[audio]` ou la légende) : un seul geste, et le texte arrive dans sa langue.
     */
    cible?: LangueConsole | null,
  ): Promise<{ texte: string; deja: boolean; langue: string | null; traduction: string | null }>;
  /**
   * Les octets d'un message média, pour les servir au navigateur. `null` = ce message ne porte aucun média.
   */
  lireMediaMessage(tenantId: string, messageId: string, conversationId?: string): Promise<{ bytes: Buffer; mime: string | null; nom?: string | null } | null>;
  /**
   * L'espace autorise-t-il ses agents à prendre une conversation du pot commun ? `false` par défaut.
   */
  agentsPeuventPrendre(tenantId: string): Promise<boolean>;
  /**
   * Traduit les entrants d'un fil vers la langue du lecteur, et range le résultat. Optionnelle : absente, la
   * route rend le fil en VO avec `traductionIndisponible`, jamais une erreur. Rend les messages enrichis (même
   * nombre, même ordre, plus `affiche`, `traduit`, `traductionEchouee`).
   */
  traduireFil?(
    tenantId: string,
    conversationId: string,
    messages: ConversationMessage[],
    cible: LangueConsole,
  ): Promise<FilTraduit<ConversationMessage>>;
  /** Le traducteur des messages sortants. Absent : la route rend 503. */
  traducteur?: {
    /**
     * Traduit un texte que l'opérateur s'apprête à envoyer ; `null` = échec. Jamais automatique : c'est un bouton,
     * avant l'envoi, car une traduction ratée en sortie serait partie chez un client sans rappel possible.
     */
    traduire(tenantId: string, texte: string, cible: string): Promise<Traduction | null>;
    /**
     * Cet espace peut-il traduire ? `null` = oui ; sinon la cause, que la route dit en clair. Requise : sans elle,
     * un crédit épuisé se lirait « la traduction a échoué, réessayez », et l'opérateur réessaierait pour rien.
     */
    empechement(tenantId: string): Promise<CauseSansTraduction | null>;
  };
  /**
   * Un opérateur vient d'écrire : il prend le fil. Posé depuis la route, seule à savoir qu'un humain authentifié
   * envoie. Sans condition : un humain prend toujours la main, y compris sur MBA (chez Meta, envoyer suffit).
   */
  takeControl(tenantId: string, waId: string, par: AuteurDuChangement): Promise<void>;
  /**
   * « Reprendre la main » sans écrire au client : retire le contact de la liste de l'agent de Meta s'il y est (seul
   * moyen de faire taire l'agent, `ControleDuFil.reprendreLaMain`), puis écrit notre état. Distincte de
   * `takeControl`, qui n'écrit que notre état local (sur un envoi, le message prend déjà le fil chez Meta) : ici il
   * n'y a pas de message, il faut le dire à Meta. `'refuse'` : Meta a refusé le retrait, rien n'est écrit, la route
   * en fait un 409 lisible.
   */
  reprendreLaMain(tenantId: string, waId: string, par: AuteurDuChangement): Promise<'pris' | 'refuse'>;
  /**
   * L'opérateur rend la main : la conversation repart en automatique ; rend qui la détient désormais. Elle appelle
   * Meta (le contact sur la liste de l'agent, puis `release`) pour que l'agent de Meta redevienne le répondeur
   * principal, au prochain message du client. Un ajout à la liste refusé remonte (409 lisible) et notre état local
   * ne bouge pas : il ne doit pas annoncer ce que Meta n'a pas fait. Un `release` refusé n'en est pas un : l'agent
   * tenait déjà le fil (`ControleDuFil.rendreLaMain`).
   * `'aucun_numero'` : l'agent de Meta est allumé mais aucun numéro n'est connecté, il ne peut rien reprendre, et
   * rien n'est écrit.
   */
  releaseControl(tenantId: string, waId: string, par: AuteurDuChangement): Promise<'app_workflow' | 'mba' | 'aucun_numero'>;
  /**
   * Variables d'un template déjà résolues sur la fiche de ce contact, avec le libellé du champ qui les
   * alimente. C'est ce que l'écran d'envoi affiche : l'opérateur voit les vraies valeurs, pas `{{1}}`.
   */
  resolveTemplateParams(
    tenantId: string,
    waId: string,
    template: { name: string; language: string; count: number },
  ): Promise<{ values: string[]; labels: string[] }>;
  /**
   * Envoie un message de la bibliothèque RCS à ce contact, variables résolues sur sa fiche. Rend
   * `{ messageId, apercu }` quand c'est parti, ou `{ refus }` avec une raison destinée à l'opérateur (canal éteint,
   * message supprimé depuis, contact désabonné du RCS).
   */
  sendRcsFromInbox(
    tenantId: string,
    waId: string,
    contenu: { rcsMessageId: string } | { text: string },
  ): Promise<{ messageId: string; apercu: string } | { refus: string }>;
  /** Envoie une réponse texte (fenêtre de service 24 h), avec le token Meta de l'espace. Retourne le message_id. */
  sendReply(tenantId: string, phoneNumberId: string, to: string, text: string): Promise<string>;
  /** Envoie un template (autorisé hors fenêtre), avec le token Meta de l'espace. Retourne le message_id. */
  sendTemplateMessage(tenantId: string, phoneNumberId: string, to: string, tpl: OutboundTemplate): Promise<string>;
  /**
   * Ce contact a-t-il demandé à ne plus être contacté ? Requise. Elle ne sert pas à la réponse texte de cette
   * route, qui reste exemptée : seul l'envoi d'un modèle la consulte, parce qu'un modèle rouvre une conversation
   * au lieu d'y répondre.
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /**
   * La catégorie réelle d'un modèle, telle que Meta la connaît ; `null` = indéterminable. 🔴 Jamais lue dans le
   * corps : `templateCategory` vient du navigateur et ne sert qu'aux statistiques, s'en servir comme garde
   * laisserait se déclarer « utility » pour écrire à un désabonné. Appelée seulement sur un contact désabonné.
   */
  categorieDuModele(tenantId: string, name: string, language: string): Promise<'marketing' | 'utility' | null>;
  /**
   * Template carousel : relit ses cartes chez Meta et prépare leurs visuels (re-téléversement). `null` = pas un
   * carousel ; `{ refus }` = carousel non envoyable, raison destinée à l'opérateur. Sans re-téléversement, Meta
   * accepte l'envoi puis ne le livre jamais (131053).
   */
  prepareCarousel(
    tenantId: string,
    name: string,
    language: string,
  ): Promise<{ cards: OutboundCarouselCard[] } | { refus: string } | null>;
  /**
   * Démarre un scénario sur cette conversation, depuis l'Inbox. `windowOpen` décide : fenêtre ouverte, le
   * scénario peut ouvrir par un message rapide ou un formulaire ; fermée, seul un scénario qui ouvre par un
   * template peut partir (sinon 131047). `true` = parti ; une chaîne = la raison du refus ; `null` = inconnu.
   */
  startWorkflow(tenantId: string, workflowId: string, waId: string, windowOpen: boolean): Promise<true | string | null>;
}

/**
 * Boîte de réception : lister/lire une conversation, répondre (texte dans la fenêtre 24 h,
 * template hors fenêtre). Lectures + réponse ouvertes à tout compte authentifié.
 */
export function registerInbox(app: FastifyInstance, deps: InboxRouteDeps, garde: PreHandler, gardeAdmin: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
  /**
   * 🔴 La garde des gestes qui coûtent de l'argent réel : la transcription appelle un modèle payé sur notre clé.
   * Sous le seul plafond général (300 par minute et par utilisateur), un script transcrirait trois cents vocaux la
   * minute à nos frais ; l'idempotence ne protège que du re-clic sur le même message.
   */
  const couteux = gardeEtendue(garde, limiteCouteuse);
  /**
   * La garde des gestes réservés aux administrateurs de cet écran : il n'y en a qu'un, effacer le contenu d'une
   * conversation. Un opérateur répond aux clients, il n'efface pas des traces.
   */
  const optsAdmin = { preHandler: gardeAdmin };
  const journal = makeJournal(deps.audit);
  /**
   * L'auteur d'un geste de la console, pour le journal du panneau Détail : toujours la SESSION, jamais le corps
   * de la requête, sinon on écrirait un geste au nom d'un collègue.
   */
  const parLaSession = (req: FastifyRequest): AuteurDuChangement => ({ collaborateur: req.auth?.userId ?? null });
  // Micro-cache des compteurs, un par serveur construit (deux instances de test ne partagent rien). Trois
  // compteurs (non-lus, à traiter, menu de dossiers), d'où la seconde instance juste en dessous.
  const compteurs = cacheCourt<number>(COMPTEURS_TTL_MS);
  /**
   * 🔴 La clé porte l'utilisateur : la pastille est celle de chaque membre, et une clé sur le seul espace
   * servirait au second le chiffre du premier.
   */
  const cleUnread = (tenant: string, userId: string | null): string => `unread:${tenant}:${userId ?? '-'}`;
  const cleATraiter = (tenant: string): string => `todo:${tenant}`;
  /**
   * Le même mécanisme, une seconde instance : le menu de dossiers rend un objet, pas un nombre, et le cache est
   * typé. Ce qui compte est qu'il n'y ait qu'un endroit où l'on invalide, juste en dessous.
   */
  const compteursMenu = cacheCourt<CompteursInbox>(COMPTEURS_TTL_MS);
  const cleMenu = (tenant: string): string => `menu:${tenant}`;
  /** Une écriture vient de changer ce que les compteurs disent : tous repartent en base au prochain appel.
  *  Un compteur oublié ici resterait juste assez longtemps pour qu'on le croie. */
  const invaliderCompteurs = (tenant: string): void => {
    // Par préfixe pour les non-lus : la clé porte l'utilisateur, donc invalider `unread:<espace>` tout court ne
    // toucherait aucune entrée.
    compteurs.invaliderPrefixe(`unread:${tenant}:`);
    compteurs.invalider(cleATraiter(tenant));
    compteursMenu.invalider(cleMenu(tenant));
  };

  /**
   * Le réglage « les agents peuvent prendre », lu seulement quand il décide de quelque chose. La liste ne tombe
   * pas pour un réglage : un échec rend `null` (« illisible ») et il est journalisé ; la liste le lit comme
   * « non », la route qui écrit refuse en disant la vraie raison. L'encadrement n'en a pas besoin (`peutPrendre`).
   */
  async function reglagePrise(
    tenant: string,
    acteur: { userId: string | null; role: string | null },
  ): Promise<boolean | null> {
    if (peutAffecter(acteur)) return false;
    try {
      return await deps.agentsPeuventPrendre(tenant);
    } catch (err) {
      // `journaliser`, pas le journal de Fastify, qui est muet (`logger: false`).
      journaliser('warn', 'reglage_prise_illisible', { err, tenantId: tenant });
      return null;
    }
  }

  app.get('/tenants/:tenantId/conversations', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    // Query string = entrée non fiable. Chaque paramètre est lu dans sa forme attendue et ignoré sinon : un
    // filtre mal formé doit rendre la page normale, jamais une page vide qui se lirait « aucune conversation ».
    const q = (req.query ?? {}) as {
      limit?: unknown; beforeAt?: unknown; beforeId?: unknown; beforeUrgente?: unknown; id?: unknown;
      aTraiter?: unknown; urgentes?: unknown; signalees?: unknown; archivees?: unknown; traitees?: unknown; affectee?: unknown;
    };
    const opts: ListConversationsOptions = {};
    /**
     * Une conversation précise, pour le lien « Ouvrir la conversation » du mini-CRM (un vieux fil, hors de la
     * première page). `estUuid` : un identifiant mal formé ferait lever Postgres ; on l'ignore, comme les autres
     * filtres mal formés.
     */
    if (typeof q.id === 'string' && estUuid(q.id)) opts.id = q.id;
    const limit = Number(q.limit);
    if (Number.isInteger(limit) && limit > 0) opts.limit = limit;
    if (q.aTraiter === '1' || q.aTraiter === 'true') opts.aTraiter = true;
    // Le dossier « Urgent » (migration 0216).
    if (q.urgentes === '1' || q.urgentes === 'true') opts.urgentes = true;
    if (q.signalees === '1' || q.signalees === 'true') opts.signalees = true;
    // Le dossier archivé. Absent = les dossiers ordinaires, qui excluent les archivées : c'est le défaut,
    // et c'est celui qu'un appelant qui ne connaît pas ce paramètre doit obtenir.
    if (q.archivees === '1' || q.archivees === 'true') opts.archivees = true;
    // Le dossier « Traité ». Lu ici, sur la route : c'est la ligne qu'on oublie entre le magasin et l'écran.
    if (q.traitees === '1' || q.traitees === 'true') opts.traitees = true;
    /**
     * Le filtre par membre (`?affectee=<id>`), supporté par le magasin et envoyé par l'écran : la route doit le
     * lire. `'aucune'` est une valeur, le dossier « Non affectées », pas une absence.
     */
    if (typeof q.affectee === 'string' && q.affectee !== '') opts.affectee = q.affectee;
    // Le curseur n'a de sens qu'entier : une moitié rendrait une page arbitraire, donc on exige les deux.
    if (typeof q.beforeAt === 'string' && q.beforeAt !== '' && typeof q.beforeId === 'string' && q.beforeId !== '') {
      // Le rang d'urgence du point de reprise, que seul « À traiter » lit (`ListConversationsOptions.before`). Absent
      // ou mal formé = non urgent, le rang de toute conversation pour une console d'avant 0216.
      opts.before = { at: q.beforeAt, id: q.beforeId, urgente: q.beforeUrgente === '1' || q.beforeUrgente === 'true' };
    }
    const conversations = await deps.inbox.listConversations(tenant, opts);
    // `assignedToMe` est calculé ici plutôt que déduit à l'écran : la session du navigateur ne porte pas
    // d'identifiant d'utilisateur, et le serveur sait déjà qui appelle.
    const moi = req.auth?.userId ?? null;
    const acteur = { userId: moi, role: req.auth?.role ?? null };
    /**
     * Peut-il prendre une conversation du pot commun ? Calculé par la même règle que la route qui écrit
     * (`peutPrendre`), sur une conversation à personne : sinon l'écran proposerait un geste que le serveur refuse.
     */
    const reglage = await reglagePrise(tenant, acteur);
    return reply.code(200).send({
      conversations: conversations.map((c) => ({ ...c, assignedToMe: moi !== null && c.assignedTo === moi })),
      peutPrendre: peutPrendre(acteur, null, reglage === true),
    });
  });

  /**
   * Compteur « À traiter », route dédiée : calculé à l'écran sur les conversations chargées, il plafonnait à la
   * taille de la page. Déclarée avant `/conversations/:conversationId` : `counts` n'est pas un identifiant.
   */
  app.get('/tenants/:tenantId/conversations/counts', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    // `deps.inbox.compterConversations(...)` dans la fermeture, jamais une référence détachée : même raison que
    // pour `todo-count` juste en dessous.
    const compte = await compteursMenu.lire(cleMenu(tenant), () => deps.inbox.compterConversations(tenant));
    return reply.code(200).send(compte);
  });

  /**
   * Archiver / désarchiver une conversation. Deux routes et non un PATCH à drapeau : l'intention se lit dans
   * l'adresse. Ouvert aux opérateurs (`garde`, pas `gardeAdmin`) : ranger sa boîte est le geste de celui qui la
   * traite.
   */
  for (const [chemin, archive] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/tenants/:tenantId/conversations/:conversationId/${chemin}`, opts, async (req, reply) => {
      const tenant = espaceVerifie(req);
      const { conversationId } = req.params as { conversationId: string };
      // 404 et non 200 : une conversation inconnue (ou d'un autre espace) doit se voir, sinon l'écran
      // annoncerait un rangement qui n'a pas eu lieu.
      if (!(await deps.inbox.archiverConversation(tenant, conversationId, archive, parLaSession(req)))) {
        return reply.code(404).send({ error: 'conversation inconnue' });
      }
      invaliderCompteurs(tenant); // deux dossiers viennent de changer de contenu.
      return reply.code(200).send({ archived: archive });
    });
  }

  /**
   * Signaler / ne plus signaler une conversation, à la main. Même forme que l'archivage, ouvert aux opérateurs.
   * 🔴 L'auteur est pris dans la session, jamais dans le corps : sinon on signalerait au nom d'un collègue.
   */
  for (const [chemin, signale] of [['signaler', true], ['ne-plus-signaler', false]] as const) {
    app.post(`/tenants/:tenantId/conversations/:conversationId/${chemin}`, opts, async (req, reply) => {
      const tenant = espaceVerifie(req);
      const { conversationId } = req.params as { conversationId: string };
      if (!(await deps.inbox.signalerConversation(tenant, conversationId, signale, parLaSession(req)))) {
        return reply.code(404).send({ error: 'conversation inconnue' });
      }
      invaliderCompteurs(tenant); // le dossier « Signalé » vient de changer de contenu.
      return reply.code(200).send({ signalee: signale });
    });
  }

  /**
   * Marquer urgent / ne plus marquer urgent (migration 0216). Même forme que le signalement, ouvert à tout rôle : un
   * agent peut alerter sur la conversation d'un collègue, comme il peut la signaler. 🔴 L'auteur est pris dans la
   * session, jamais dans le corps. `estUuid` avant la base : un identifiant mal formé ferait lever Postgres.
   */
  for (const [chemin, urgente] of [['urgent', true], ['ne-plus-urgent', false]] as const) {
    app.post(`/tenants/:tenantId/conversations/:conversationId/${chemin}`, opts, async (req, reply) => {
      const tenant = espaceVerifie(req);
      const { conversationId } = req.params as { conversationId: string };
      if (!estUuid(conversationId) || !(await deps.inbox.marquerUrgente(tenant, conversationId, urgente, parLaSession(req)))) {
        return reply.code(404).send({ error: 'conversation inconnue' });
      }
      invaliderCompteurs(tenant); // « Urgent » et l'ordre de « À traiter » viennent de changer.
      return reply.code(200).send({ urgente });
    });
  }

  /**
   * Marquer « Traité » / ne plus marquer traité. Même forme que l'archivage, ouvert aux opérateurs. Aucun retrait
   * automatique ici : c'est le prochain message du contact qui retire le statut (`upsertConversationByWaId`), sauf
   * une réaction emoji. `estUuid` avant la base ; une conversation inexistante rend 404.
   */
  for (const [chemin, traitee] of [['traiter', true], ['ne-plus-traiter', false]] as const) {
    app.post(`/tenants/:tenantId/conversations/:conversationId/${chemin}`, opts, async (req, reply) => {
      const tenant = espaceVerifie(req);
      const { conversationId } = req.params as { conversationId: string };
      if (!estUuid(conversationId) || !(await deps.inbox.marquerTraitee(tenant, conversationId, traitee, parLaSession(req)))) {
        return reply.code(404).send({ error: 'conversation inconnue' });
      }
      invaliderCompteurs(tenant); // « À traiter » et « Traité » viennent de changer de contenu.
      return reply.code(200).send({ traitee });
    });
  }

  /**
   * Ouvrir la conversation d'un contact depuis le mini-CRM. `POST` car elle écrit (un contact qui n'a jamais parlé
   * n'a pas de fil) : un `GET` qui crée une ligne serait déclenché par un préchargement. Idempotente (clé
   * `(tenant_id, wa_id)`, `on conflict`). 404 quand le contact est inconnu, supprimé ou sans identité joignable.
   */
  app.post('/tenants/:tenantId/contacts/:contactId/conversation', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { contactId } = req.params as { contactId: string };
    // `estUuid` avant la base, même raison qu'ailleurs dans ce fichier : un identifiant mal formé ferait
    // lever Postgres, donc un 500 illisible, là où « ce contact n'existe pas » est la réponse juste.
    if (!estUuid(contactId)) return reply.code(404).send({ error: 'contact introuvable, supprime, bloque, ou sans numero' });
    const id = await deps.inbox.ouvrirConversationDuContact(tenant, contactId);
    if (id === null) return reply.code(404).send({ error: 'contact introuvable, supprime, bloque, ou sans numero' });
    return reply.code(200).send({ conversationId: id });
  });

  app.post('/tenants/:tenantId/conversations/:conversationId/prendre', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    /**
     * Prendre le fil sans rien écrire au client (le miroir de `release`) : la bascule est le geste, son échec doit se
     * voir (une panne de base sort en erreur, jamais en 200). Un refus de Meta de retirer le contact de la liste de
     * son agent, après un rejeu, sort en 409, et l'écran rappelle qu'écrire prend le fil à coup sûr.
     */
    if ((await deps.reprendreLaMain(tenant, ctx.waId, parLaSession(req))) === 'refuse') {
      // eslint-disable-next-line no-console
      console.error(`prendre: Meta a refusé de céder le fil (${tenant}/${ctx.waId})`);
      return reply.code(409).send({ error: 'Meta n’a pas cédé la conversation, son agent peut encore répondre. Envoyez un message : écrire prend le fil à coup sûr.' });
    }
    invaliderCompteurs(tenant); // le fil entre dans « À traiter ».
    return reply.code(200).send({ controlOwner: 'app_human' });
  });

  /**
   * Servir le fichier d'un message média au navigateur. L'URL de Meta vit quelques minutes et exige notre jeton
   * en en-tête : une balise `<audio src>` ne peut ni l'un ni l'autre, donc on sert les octets sous la garde
   * d'espace. Pas de plafond coûteux ici : écouter ne coûte qu'un peu de bande passante.
   */
  app.get('/tenants/:tenantId/conversations/:conversationId/messages/:messageId/media', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId, messageId } = req.params as { conversationId: string; messageId: string };
    if (!estUuid(messageId)) return reply.code(404).send({ error: 'message inconnu' });
    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    try {
      const f = await deps.lireMediaMessage(tenant, messageId, conversationId);
      if (!f) return reply.code(404).send({ error: 'ce message ne porte aucun média' });
      /**
       * 🔴 `inline` pour une image affichable, `attachment` pour le reste, et `nosniff` partout (`enTetesMedia`) : un
       * document reçu porte le type que son expéditeur annonce, et un `text/html` ou un SVG s'exécuterait dans
       * l'origine de la console. `no-store` : ces octets sont ceux d'un client.
       */
      return reply.headers(enTetesMedia(f.mime, f.nom ?? null, `piece-jointe-${messageId.slice(0, 8)}`)).send(f.bytes);
    } catch (err) {
      // 4xx, jamais 5xx : Cloudflare remplacerait le corps, et l'écran a besoin de savoir quoi dire. Et les
      // trois causes ne se disent pas pareil : trop tard (410, rien à faire), trop lourd (422 avec la taille),
      // panne (422, réessayer).
      if (err instanceof MediaExpire) return reply.code(410).send({ error: err.message, code: 'media_expire' });
      if (err instanceof MediaTropGros) {
        return reply.code(422).send({
          error: `fichier trop lourd pour être ouvert depuis la console (${Math.round(err.octets / 1024 / 1024)} Mo, maximum ${Math.round(err.plafond / 1024 / 1024)} Mo)`,
          code: 'media_trop_gros',
        });
      }
      journaliser('error', 'media_illisible', { err, tenantId: tenant, messageId });
      return reply.code(422).send({ error: 'ce média n’a pas pu être récupéré' });
    }
  });

  /**
   * Transcrire le vocal d'un message, à la demande : un bouton, pas un automatisme (un opérateur écoute le plus
   * souvent, tout transcrire ferait payer un service non demandé). Idempotente : deux clics ne paient pas deux
   * fois, et la réponse dit `deja`.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/messages/:messageId/transcrire', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId, messageId } = req.params as { conversationId: string; messageId: string };
    if (!estUuid(messageId)) return reply.code(404).send({ error: 'message inconnu' });
    // 🔴 La conversation est relue dans l'espace : c'est elle qui porte l'isolation, un identifiant de message
    // seul ne dit pas à qui il appartient.
    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    if (!deps.transcrireMessage) return reply.code(503).send({ error: 'transcription indisponible sur cette instance' });
    /**
     * `traduire` dans le corps : la langue de lecture vient du navigateur. Une valeur hors de nos deux langues est
     * ignorée, et on transcrit sans traduire.
     */
    const demande = (req.body ?? {}) as { traduire?: unknown };
    const cible = estLangueConsole(demande.traduire) ? demande.traduire : null;
    try {
      const r = await deps.transcrireMessage(tenant, messageId, conversationId, cible);
      return reply.code(200).send(r);
    } catch (err) {
      // 4xx, jamais 5xx (Cloudflare remplacerait le corps), et trois causes, trois actions : rien à transcrire,
      // fichier trop lourd, panne du fournisseur (réessayer).
      if (err instanceof RienATranscrire) return reply.code(422).send({ error: 'ce message ne porte aucun vocal à transcrire' });
      // Le crédit IA paie la transcription (lot 6, C) : épuisé, recharger règle le problème, « réessayez » serait faux.
      if (err instanceof CreditEpuise) {
        return reply.code(402).send({ error: 'Le crédit IA de l’espace est épuisé : rechargez-le pour transcrire ce vocal.', cause: 'credit' });
      }
      // Le vocal a disparu chez Meta (sept jours) : rien ne le fera revenir, « réessayez » serait faux.
      if (err instanceof MediaExpire) return reply.code(410).send({ error: err.message, code: 'media_expire' });
      if (err instanceof MediaTropGros) {
        return reply.code(422).send({ error: `vocal trop long pour être transcrit (${Math.round(err.octets / 1024)} Ko, maximum ${Math.round(err.plafond / 1024)} Ko)` });
      }
      // Journalisé ici, sous les trois cas métier : un vocal expiré n'est pas une erreur, et chaque clic sur
      // l'un d'eux écrirait une ligne `error`. Même place que `media_illisible`.
      journaliser('error', 'transcription_impossible', { err, tenantId: tenant, messageId });
      return reply.code(422).send({ error: 'la transcription a échoué, réessayez dans un instant' });
    }
  });

  /**
   * Traduire ce que l'opérateur s'apprête à envoyer : elle ne fait que traduire, elle n'envoie rien (le texte
   * traduit revient dans la zone de saisie avant Envoyer). La cible est la langue du contact, que l'écran nomme
   * dans le bouton. Pas de plafond coûteux : la traduction est payée sur le crédit prépayé du client, sa propre
   * borne, et un plafond par espace à 10 par minute gênerait une équipe.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/traduire', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    const b = (req.body ?? {}) as { texte?: unknown; cible?: unknown };
    if (!nonEmpty(b.texte)) return reply.code(400).send({ error: 'texte requis' });
    if (b.texte.length > TEXTE_MAX_CARACTERES) {
      // 4xx et jamais 5xx, et surtout jamais une troncature : une traduction coupée en deux
      // s'afficherait comme un message entier.
      return reply.code(422).send({ error: `texte trop long pour être traduit (maximum ${TEXTE_MAX_CARACTERES} caractères)` });
    }
    if (!estCodeLangue(b.cible)) return reply.code(400).send({ error: 'cible requise (code de langue)' });
    // La conversation est relue dans l'espace : elle porte l'isolation.
    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    if (!deps.traducteur) return reply.code(503).send({ error: 'traduction indisponible sur cette instance' });
    const empechement = await deps.traducteur.empechement(tenant);
    if (empechement !== null) {
      // 422 et non 503 : ce n'est pas une panne de l'instance, c'est l'état de cet espace. L'écran affiche le
      // message tel quel : il dit la cause, et seul le crédit épuisé envoie recharger.
      return reply.code(422).send({
        error: empechement === 'credit' || empechement === 'credit_insuffisant'
          ? 'Le crédit de cet espace est épuisé ou insuffisant : la traduction est indisponible. Un administrateur peut le recharger.'
          : empechement === 'cle_en_preparation'
            ? 'La traduction se prépare pour cet espace : réessayez dans un instant.'
            : 'La traduction est momentanément indisponible pour cet espace. Réessayez dans un instant.',
        code: 'traduction_indisponible',
        cause: empechement,
      });
    }
    const r = await deps.traducteur.traduire(tenant, b.texte.trim(), b.cible.trim().toLowerCase());
    if (r === null) return reply.code(422).send({ error: 'la traduction a échoué, réessayez dans un instant' });
    return reply.code(200).send({ texte: r.texte, langueSource: r.langueSource, cible: b.cible.trim().toLowerCase() });
  });

  /**
   * Déclarée avant `/conversations/:conversationId` : `todo-count` n'est pas un identifiant.
   */
  app.get('/tenants/:tenantId/conversations/todo-count', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    // `deps.inbox.countATraiter(...)` dans la fermeture, jamais une référence détachée : un store de production y
    // perdrait son `this`.
    const count = await compteurs.lire(cleATraiter(tenant), () => deps.inbox.countATraiter(tenant));
    return reply.code(200).send({ count });
  });

  /**
   * Compteur de non-lus, pour la pastille du menu. Route dédiée et non un champ de la liste : le menu est
   * monté sur toutes les pages et la rafraîchit régulièrement, il ne doit pas rapatrier 100 conversations.
   * Déclarée avant `/conversations/:conversationId/...` : `unread-count` n'est pas un identifiant.
   */
  app.get('/tenants/:tenantId/conversations/unread-count', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const acteur = { userId: req.auth?.userId ?? null, role: req.auth?.role ?? null };
    const count = await compteurs.lire(cleUnread(tenant, acteur.userId), () => deps.inbox.countUnread(tenant, acteur));
    return reply.code(200).send({ count });
  });

  /** Un opérateur vient d'ouvrir le fil : il est lu. C'est le seul événement qui éteint la pastille. */
  app.post('/tenants/:tenantId/conversations/:conversationId/read', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    await deps.inbox.markConversationRead(tenant, conversationId);
    // C'est le geste que la pastille doit refléter tout de suite : l'écran relit le compteur dans la foulée,
    // et sans cette invalidation il retomberait sur la valeur d'avant pendant toute la durée de vie du cache.
    invaliderCompteurs(tenant);
    return reply.code(200).send({ ok: true });
  });

  /**
   * 🔴 Effacer le contenu d'une conversation : irréversible (aucune corbeille), réservé aux administrateurs. Cela
   * ferme la fenêtre de service (plus d'entrant, donc plus de réponse libre jusqu'à ce que le contact réécrive),
   * et l'écran doit l'avoir dit avant le clic. La trace part au journal sans le numéro ni le texte.
   */
  app.delete('/tenants/:tenantId/conversations/:conversationId/messages', optsAdmin, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    if (!estUuid(conversationId)) return reply.code(404).send({ error: 'conversation inconnue' });
    const effaces = await deps.inbox.effacerMessages(tenant, conversationId);
    if (effaces === null) return reply.code(404).send({ error: 'conversation inconnue' });
    await journal(tenant, req, 'conversation.effacee', { kind: 'conversation', id: conversationId }, { messages: effaces });
    // La pastille des non-lus se calcule sur les messages entrants : elle vient de changer.
    invaliderCompteurs(tenant);
    return reply.code(200).send({ effaces });
  });

  app.get('/tenants/:tenantId/conversations/:conversationId/messages', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    // Delta : `afterAt` + `afterId` = le dernier message que l'écran a déjà (le fil se rafraîchit toutes les 4 s).
    // Les deux ou aucun, et `afterId` doit être un uuid : sinon on rend le fil entier. Le repli sûr montre trop de
    // messages, jamais trop peu.
    const q = (req.query ?? {}) as { afterAt?: unknown; afterId?: unknown; traduire?: unknown };
    const afterAt = typeof q.afterAt === 'string' && !Number.isNaN(Date.parse(q.afterAt)) ? q.afterAt : undefined;
    const apres = afterAt !== undefined && estUuid(q.afterId) ? { at: afterAt, id: q.afterId } : undefined;
    /**
     * `?traduire=fr` : la langue du lecteur, que seul le navigateur connaît (deux collègues peuvent lire le même
     * fil dans deux langues), donc impossible à décider à l'arrivée du message. Une valeur hors de nos deux
     * langues est ignorée et le fil sort en VO.
     */
    const cible = estLangueConsole(q.traduire) ? q.traduire : null;
    const messages = await deps.inbox.getMessages(conversationId, apres);
    /**
     * Pas de plafond coûteux sur cette route : le fil se rafraîchit toutes les 4 secondes. La dépense est bornée
     * ailleurs : une traduction rangée n'est jamais recalculée, le lot est plafonné (40 messages, 20 000 caractères),
     * la facture tombe sur le crédit prépayé du client. 🔴 Et une borne vit dans le navigateur : dans
     * `web/app/inbox/page.tsx`, un tour qui tombe pendant une requête en vol passe son tour (`enCoursRef`) ; sans
     * elle, chaque tour relancerait une traduction complète du fil. Gardée par
     * `web/e2e/inbox-traduction-polling.spec.ts`.
     */
    const traduit = cible !== null && deps.traduireFil
      ? await deps.traduireFil(tenant, conversationId, messages, cible)
      : null;
    return reply.code(200).send({
      waId: ctx.waId,
      windowOpen: ctx.windowOpen,
      lastInboundAt: ctx.lastInboundAt,
      /**
       * La langue apprise du contact, `null` tant qu'on n'a rien appris. C'est elle qui permet au bouton de
       * traduction sortante de nommer sa cible au lieu de dire « Traduire » tout court.
       */
      langueContact: ctx.langueContact ?? null,
      /**
       * Rendu seulement quand une traduction a été demandée : sans `?traduire`, la réponse est inchangée. `true` =
       * cet espace ne peut pas traduire ; ce n'est pas une panne, et c'est un 200.
       */
      ...(cible !== null ? { traductionIndisponible: traduit === null || traduit.indisponible !== null } : {}),
      /**
       * Pourquoi la traduction est indisponible, en causes qui n'appellent pas le même geste : `instance`, aucun
       * modèle configuré (`TRADUCTION_MODELE` vide) ; `credit`, le crédit de l'espace est épuisé, et
       * `credit_insuffisant`, il reste trop peu pour ouvrir la clé (recharger règle les deux) ; `cle_en_preparation`,
       * la clé s'ouvre en arrière-plan ; `cle`, l'espace a du crédit mais sa clé n'a pas pu s'ouvrir. L'écran
       * n'envoie recharger que pour les deux causes de crédit.
       */
      ...(cible !== null && (traduit === null || traduit.indisponible !== null)
        ? { traductionCause: traduit === null ? 'instance' : traduit.indisponible }
        : {}),
      // Qui détient le fil : sans cette information, l'opérateur voit le scénario se taire sans comprendre
      // pourquoi et ne sait pas s'il doit rendre la main.
      controlOwner: await deps.inbox.getControlOwner(tenant, ctx.waId),
      messages: traduit ? traduit.messages : messages,
    });
  });

  /**
   * Le panneau Détail d'une conversation (cadrage du 2026-09-28) : identité (champs système, tags, désabonné,
   * bloqué), résumé de l'analyse, assignation, et les 50 derniers événements du journal (migration 0192). Lecture
   * seule : les gestes restent dans l'en-tête du fil.
   *
   * 🔴 404 et non 403 pour une conversation qu'un agent ne voit pas : c'est la réponse d'une conversation qui
   * n'existe pas, et elle ne lui apprend rien. La règle de visibilité vit dans le dépôt (`visibiliteSql`,
   * `src/inbox/assignment.ts`), pas ici. `estUuid` avant la base : un identifiant mal formé ferait lever Postgres.
   */
  app.get('/tenants/:tenantId/conversations/:conversationId/detail', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    if (!estUuid(conversationId)) return reply.code(404).send({ error: 'conversation inconnue' });
    const acteur = { userId: req.auth?.userId ?? null, role: req.auth?.role ?? null };
    const detail = await deps.inbox.detailConversation(tenant, conversationId, acteur);
    if (!detail) return reply.code(404).send({ error: 'conversation inconnue' });
    return reply.code(200).send(detail);
  });

  /**
   * Cet acteur a-t-il le droit d'écrire dans cette conversation ? Rend un message d'erreur, ou `null` si c'est
   * permis. Appelé par chaque route qui écrit vers le client : l'écran grise un bouton, mais seule cette
   * barrière empêche d'appeler l'API directement.
   */
  async function refusAffectation(req: FastifyRequest, tenant: string, conversationId: string): Promise<string | null> {
    const assignee = await deps.inbox.getAssignee(tenant, conversationId);
    // `undefined` (conversation inconnue) est laissé aux gardes existantes des routes, qui rendent un 404
    // plus précis. On ne se prononce que sur une conversation qui existe.
    if (assignee === undefined) return null;
    if (peutEcrire({ userId: req.auth?.userId ?? null, role: req.auth?.role ?? null }, assignee)) return null;
    return 'Cette conversation est affectée à un autre membre de l’équipe.';
  }

  /**
   * Les membres qu'on peut affecter, pour le sélecteur de l'encadrement. Même règle que l'affectation
   * (`peutAffecter`), donc voir la liste et pouvoir s'en servir vont ensemble (`GET /users` est réservé aux
   * admins). Segment fixe, servi par Fastify avant `:conversationId`.
   */
  app.get('/tenants/:tenantId/conversations/membres-affectables', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (!peutAffecter({ userId: req.auth?.userId ?? null, role: req.auth?.role ?? null })) {
      return reply.code(403).send({ error: 'réservé aux managers et aux admins' });
    }
    return reply.code(200).send({ membres: await deps.inbox.membresPourAffectation(tenant) });
  });

  /**
   * Prendre une conversation du pot commun, se l'affecter à soi. 🔴 L'affectataire est pris dans la session,
   * jamais dans le corps : sinon la prise deviendrait « donner à un collègue », ce que le réglage n'autorise pas.
   * 409 si un collègue l'a prise entre-temps : l'écriture est conditionnelle (`assigned_to is null`).
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/assignee/moi', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    if (!estUuid(conversationId)) return reply.code(404).send({ error: 'conversation inconnue' });
    const acteur = { userId: req.auth?.userId ?? null, role: req.auth?.role ?? null };
    const actuel = await deps.inbox.getAssignee(tenant, conversationId);
    if (actuel === undefined) return reply.code(404).send({ error: 'conversation inconnue' });
    if (actuel !== null) return reply.code(409).send({ error: 'Un collègue s’occupe déjà de cette conversation.', code: 'deja_prise' });
    const reglage = await reglagePrise(tenant, acteur);
    // Illisible : on refuse sans affirmer que l'espace l'interdit, ce qui serait peut-être faux. 409, pas 5xx.
    if (reglage === null) {
      return reply.code(409).send({ error: 'Le réglage de votre espace est momentanément illisible, réessayez dans un instant.', code: 'reglage_illisible' });
    }
    if (!peutPrendre(acteur, null, reglage)) {
      return reply.code(403).send({ error: 'Votre espace ne permet pas aux agents de prendre une conversation. Un manager peut vous l’affecter.' });
    }
    // `acteur.userId` est non nul ici : `peutPrendre` l'exige.
    if (!(await deps.inbox.prendreSiLibre(tenant, conversationId, acteur.userId!))) {
      // Prise entre notre lecture et notre écriture : un collègue a été plus rapide.
      return reply.code(409).send({ error: 'Un collègue s’occupe déjà de cette conversation.', code: 'deja_prise' });
    }
    invaliderCompteurs(tenant); // « Non affectées » et la charge de l'agent viennent de changer.
    return reply.code(200).send({ conversationId, assignee: acteur.userId });
  });

  /**
   * Affecter une conversation à un membre, ou la libérer. Réservé aux managers et aux admins.
   */
  app.patch('/tenants/:tenantId/conversations/:conversationId/assignee', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (!peutAffecter({ userId: req.auth?.userId ?? null, role: req.auth?.role ?? null })) {
      return reply.code(403).send({ error: 'réservé aux managers et aux admins' });
    }
    const { conversationId } = req.params as { conversationId: string };
    const brut = (req.body as { assignee?: unknown } | null)?.assignee;
    // `null` explicite = libérer. Toute autre forme qu'une chaîne non vide est refusée : une valeur bancale
    // ne doit pas se traduire par une libération silencieuse, qui rouvrirait la conversation à tous.
    if (brut !== null && !nonEmpty(brut)) return reply.code(400).send({ error: 'assignee requis (identifiant de membre, ou null pour libérer)' });
    const assignee = brut === null ? null : (brut as string);
    const ok = await deps.inbox.setAssignee(tenant, conversationId, assignee, parLaSession(req));
    if (!ok) return reply.code(404).send({ error: 'conversation inconnue, ou membre étranger à cet espace' });
    return reply.code(200).send({ conversationId, assignee });
  });

  app.post('/tenants/:tenantId/conversations/:conversationId/reply', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    const corps = (req.body ?? {}) as { text?: unknown; redactionOrigine?: unknown };
    const text = corps.text;
    if (!nonEmpty(text)) return reply.code(400).send({ error: 'text requis' });
    /**
     * Ce que l'opérateur a écrit avant de faire traduire. `text` est ce qui part (le texte traduit, trace fidèle en
     * cas de litige) ; ce champ garde l'original pour que l'opérateur se relise. Mal formé, il est refusé en 400 :
     * rien n'est encore parti, alors que l'ignorer ferait partir le message en perdant sa trace.
     */
    const brutOrigine = corps.redactionOrigine;
    if (brutOrigine !== undefined && brutOrigine !== null
      && (!nonEmpty(brutOrigine) || brutOrigine.length > TEXTE_MAX_CARACTERES)) {
      return reply.code(400).send({ error: 'redactionOrigine invalide' });
    }
    const redactionOrigine = nonEmpty(brutOrigine) ? brutOrigine.trim() : null;

    // L'affectation est une règle de la console (qui, parmi les opérateurs, a la charge du fil) : elle est
    // vérifiée ici et pas dans `repondreDansLaFenetre`, qui sert aussi un appelant sans opérateur.
    const refus = await refusAffectation(req, tenant, conversationId);
    if (refus) return reply.code(403).send({ error: refus, code: 'assigned_to_other' });

    // « humain » : cette route n'est atteignable qu'avec un JWT de console, donc c'est toujours un opérateur
    // qui écrit. L'origine est posée et non déduite, cf. le commentaire de `repondreDansLaFenetre`.
    const res = await repondreDansLaFenetre(deps, tenant, conversationId, text, req.auth?.userId ?? null, 'humain', redactionOrigine);
    if ('refus' in res) {
      if (res.refus.motif === 'conversation_inconnue') return reply.code(404).send({ error: 'conversation inconnue' });
      if (res.refus.motif === 'aucun_numero') return reply.code(400).send({ error: 'aucun numéro pour ce tenant' });
      /**
       * Inatteignable depuis cette route (le refus d'opt-out ne vise que l'origine machine), et écrit quand même :
       * sans branche explicite, un motif futur sortirait sous le message « fenêtre fermée », une raison fausse.
       */
      if (res.refus.motif === 'contact_desabonne') {
        return reply.code(409).send({ error: 'ce contact a demandé à ne plus recevoir de messages', code: 'contact_desabonne' });
      }
      // Hors fenêtre 24 h : Meta refuse le texte libre. Le message dit les deux chemins qui restent (template, ou
      // RCS si le contact y est joignable). Le code `window_closed` ne bouge pas, l'écran s'en sert.
      return reply.code(422).send({ error: 'Fenêtre de 24 h fermée : envoie un template, ou un message RCS si le contact y est joignable.', code: 'window_closed' });
    }
    invaliderCompteurs(tenant); // le fil passe cote humain : il entre dans « A traiter ».
    return reply.code(200).send({ messageId: res.messageId });
  });

  /**
   * Envoi d'un message RCS depuis une conversation, sans garde de fenêtre 24 h (c'est une règle de WhatsApp, le
   * RCS n'en a pas : c'est le moyen de reprendre contact fenêtre fermée). Le message vient de la bibliothèque,
   * variables résolues sur la fiche du contact comme dans une campagne.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/send-rcs', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    // Deux formes, exclusives : un message de la bibliothèque, ou une réponse écrite à la main, pour qu'un contact
    // joignable seulement en RCS puisse recevoir une phrase sur le canal où il vient de parler.
    const corps = (req.body ?? {}) as { rcsMessageId?: unknown; text?: unknown };
    const aId = nonEmpty(corps.rcsMessageId);
    const aTexte = nonEmpty(corps.text);
    if (aId === aTexte) return reply.code(400).send({ error: 'rcsMessageId OU text requis, pas les deux' });
    // Même borne que le schéma RCS : refuser ici plutôt que d'aller se faire refuser par le fournisseur.
    if (aTexte && (corps.text as string).trim().length > RCS_TEXTE_MAX) {
      return reply.code(400).send({ error: `texte trop long (${RCS_TEXTE_MAX} caractères maximum)` });
    }
    const contenu = aId ? { rcsMessageId: (corps.rcsMessageId as string).trim() } : { text: (corps.text as string).trim() };

    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    const refusAff = await refusAffectation(req, tenant, conversationId);
    if (refusAff) return reply.code(403).send({ error: refusAff, code: 'assigned_to_other' });

    const issue = await deps.sendRcsFromInbox(tenant, ctx.waId, contenu);
    // 422 et non 5xx : une situation à corriger par l'opérateur (canal éteint, contact désabonné).
    if ('refus' in issue) return reply.code(422).send({ error: issue.refus });

    // L'opérateur prend le fil, comme sur une réponse texte. Au mieux et après l'envoi réussi : un échec d'état
    // ne doit pas faire croire à un message perdu.
    await deps.takeControl(tenant, ctx.waId, parLaSession(req)).catch(() => {});
    invaliderCompteurs(tenant); // le fil passe cote humain : il entre dans « A traiter ».
    await deps.inbox.recordOutbound(conversationId, issue.apercu, issue.messageId, 'humain', 'rcs', null, null, req.auth?.userId ?? null, 'rcs');
    return reply.code(200).send({ messageId: issue.messageId });
  });

  /**
   * Variables d'un template, résolues pour ce contact : l'écran d'envoi affiche les valeurs déjà remplies depuis
   * la fiche, avec le libellé du champ (`template_param_hints`), modifiables, au lieu de faire retaper `{{1}}`.
   */
  app.get('/tenants/:tenantId/conversations/:conversationId/template-params', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    const q = req.query as { name?: string; language?: string; count?: string };
    if (!nonEmpty(q.name) || !nonEmpty(q.language)) return reply.code(400).send({ error: 'name et language requis' });
    const count = Number(q.count ?? 0);
    if (!Number.isInteger(count) || count < 0 || count > 20) return reply.code(400).send({ error: 'count invalide' });

    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    if (count === 0) return reply.code(200).send({ values: [], labels: [] });

    const r = await deps.resolveTemplateParams(tenant, ctx.waId, { name: q.name as string, language: q.language as string, count });
    return reply.code(200).send(r);
  });

  // Envoi d'un template dans une conversation (le seul moyen de ré-engager hors fenêtre 24 h).
  app.post('/tenants/:tenantId/conversations/:conversationId/send-template', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    const b = (req.body ?? {}) as Partial<{
      templateName: string;
      language: string;
      bodyParams: unknown;
      headerMediaUrl: unknown;
      headerFormat: unknown;
      templateCategory: unknown;
    }>;
    if (!nonEmpty(b.templateName)) return reply.code(400).send({ error: 'templateName requis' });
    if (!nonEmpty(b.language)) return reply.code(400).send({ error: 'language requis' });
    let bodyParams: string[] = [];
    if (b.bodyParams !== undefined) {
      if (!Array.isArray(b.bodyParams) || !b.bodyParams.every((x) => typeof x === 'string')) {
        return reply.code(400).send({ error: 'bodyParams invalide (tableau de chaînes)' });
      }
      bodyParams = b.bodyParams as string[];
    }
    const headerMediaUrl = nonEmpty(b.headerMediaUrl) ? b.headerMediaUrl : undefined;
    const headerFormat =
      b.headerFormat === 'IMAGE' || b.headerFormat === 'VIDEO' || b.headerFormat === 'DOCUMENT' ? b.headerFormat : undefined;
    // Catégorie du template (pour les stats) : normalisée en minuscules marketing|utility.
    const catRaw = typeof b.templateCategory === 'string' ? b.templateCategory.toLowerCase() : '';
    const templateCategory = catRaw === 'marketing' || catRaw === 'utility' ? catRaw : null;

    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    const refusTpl = await refusAffectation(req, tenant, conversationId);
    if (refusTpl) return reply.code(403).send({ error: refusTpl, code: 'assigned_to_other' });
    const phoneNumberId = await deps.repo.getTenantPhoneNumberId(tenant);
    if (!phoneNumberId) return reply.code(400).send({ error: 'aucun numéro pour ce tenant' });

    /**
     * 🔴 Un contact désabonné ne reçoit plus de modèle marketing, même envoyé à la main : un modèle rouvre une
     * conversation, le geste dont la personne a demandé qu'il cesse. Le service passe (livraison, rendez-vous,
     * compte). La catégorie est lue chez Meta, pas dans la requête, et un modèle dont la catégorie est illisible est
     * refusé (échouer fermé). Cette lecture n'a lieu que pour un contact désabonné.
     */
    if (await deps.estDesabonne(tenant, ctx.waId)) {
      const categorie = await deps.categorieDuModele(tenant, b.templateName, b.language).catch(() => null);
      if (categorie !== 'utility') {
        return reply.code(409).send({
          error: categorie === null
            ? 'ce contact s’est désabonné, et la catégorie de ce modèle n’a pas pu être vérifiée : l’envoi est refusé par prudence. Vous pouvez encore lui répondre à la main si la conversation est ouverte.'
            : 'ce contact s’est désabonné : seuls les modèles de catégorie « Service » peuvent encore lui être envoyés. Vous pouvez lui répondre à la main si la conversation est ouverte.',
          code: 'contact_desabonne',
        });
      }
    }

    // Carousel : ses cartes se relisent chez Meta et leurs visuels doivent être re-téléversés. Un refus (carte sans
    // visuel exploitable, variable de carte) sort en 422 avant l'envoi, plutôt qu'un message accepté jamais livré.
    let carousel: { cards: OutboundCarouselCard[] } | undefined;
    const prep = await deps.prepareCarousel(tenant, b.templateName, b.language);
    if (prep && 'refus' in prep) return reply.code(422).send({ error: prep.refus });
    if (prep) carousel = prep;

    const messageId = await deps.sendTemplateMessage(tenant, phoneNumberId, ctx.waId, {
      name: b.templateName,
      language: b.language,
      bodyParams,
      ...(headerMediaUrl ? { headerMediaUrl } : {}),
      ...(headerFormat ? { headerFormat } : {}),
      ...(carousel ? { carousel } : {}),
    });
    // Même prise de main que sur la réponse texte : un template envoyé à la main est un acte d'opérateur.
    await deps.takeControl(tenant, ctx.waId, parLaSession(req)).catch(() => {});
    invaliderCompteurs(tenant); // le fil passe cote humain : il entre dans « A traiter ».
    await deps.inbox.recordOutbound(conversationId, `[template] ${b.templateName}`, messageId, 'humain', 'template', templateCategory, b.templateName, req.auth?.userId ?? null);
    return reply.code(200).send({ messageId });
  });

  /**
   * Lance un scénario sur cette conversation. La raison d'un refus est rendue telle quelle en 422, jamais un 200
   * muet. L'état réel de la fenêtre au clic décide, pas ce que l'écran affichait : le serveur reste le juge.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/workflow', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    const workflowId = (req.body as { workflowId?: unknown } | null)?.workflowId;
    if (!nonEmpty(workflowId)) return reply.code(400).send({ error: 'workflowId requis' });

    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    // Lancer un scénario écrit au client : même règle que répondre à la main.
    const refusWf = await refusAffectation(req, tenant, conversationId);
    if (refusWf) return reply.code(403).send({ error: refusWf, code: 'assigned_to_other' });

    const issue = await deps.startWorkflow(tenant, workflowId, ctx.waId, ctx.windowOpen);
    if (issue === null) return reply.code(404).send({ error: 'scénario inconnu' });
    // Une chaîne porte la raison exacte du refus (ouverture par un message de session hors fenêtre, scénario
    // vide, bloc de départ supprimé, template introuvable chez Meta...). On l'affiche telle quelle.
    if (typeof issue === 'string') return reply.code(422).send({ error: issue });
    return reply.code(200).send({ ok: true });
  });

  /**
   * L'opérateur rend la main : le scénario ou l'agent de Meta reprend la conversation, sans attendre le
   * garde-fou d'inactivité.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/release', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { conversationId } = req.params as { conversationId: string };
    const ctx = await deps.inbox.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    /**
     * Un échec chez Meta sort en 4xx, pas en 500 : rendre la main met le contact sur la liste de l'agent avant
     * d'écrire notre état, et l'opérateur doit le savoir. Notre état local n'a alors pas bougé (`releaseControl`
     * écrit après Meta) : l'écran continue d'annoncer que l'opérateur tient le fil, ce qui est vrai.
     */
    let owner: 'app_workflow' | 'mba' | 'aucun_numero';
    try {
      owner = await deps.releaseControl(tenant, ctx.waId, parLaSession(req));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`release: l’agent de Meta n’a pas pu prendre la conversation (${tenant}/${ctx.waId}):`, messageDe(err));
      return reply.code(409).send({ error: 'Meta n’a pas repris la conversation. Elle reste de votre côté, réessayez dans un instant.' });
    }
    // Même règle que le balayage : un agent qui ne peut pas répondre ne s'annonce pas, et « Automatique » sortirait
    // la conversation d'« À traiter ». Rien n'a été écrit.
    if (owner === 'aucun_numero') {
      return reply.code(409).send({ error: 'Aucun numéro WhatsApp n’est connecté : l’agent de Meta ne peut pas reprendre la conversation. Elle reste de votre côté.' });
    }
    invaliderCompteurs(tenant); // le fil repart en automatique : il sort de « À traiter ».
    return reply.code(200).send({ controlOwner: owner });
  });

}
