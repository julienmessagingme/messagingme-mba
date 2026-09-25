import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Guard, PreHandler } from '../auth/middleware';
import type { ConversationSummary, ConversationMessage, ListConversationsOptions, CompteursInbox } from '../inbox/store.pg';
import type { OutboundCarouselCard } from '../meta/template-components';
import { scopeTenant, nonEmpty, estUuid } from './scope';
import { RCS_TEXTE_MAX } from '../rcs/schema';
import { peutEcrire, peutAffecter, peutPrendre } from '../inbox/assignment';
import { gardeEtendue } from '../auth/middleware';
import { cacheCourt } from '../lib/cache-court';
import { journaliser } from '../lib/journal';
import { RienATranscrire } from '../inbox/transcrire';
import { MediaTropGros } from '../meta/media';
import { MediaExpire, enTetesMedia } from '../inbox/media-entrant';
import { makeJournal, type AuditSink } from '../audit/journal';
import { repondreDansLaFenetre } from '../inbox/repondre';
import type { OrigineMessage } from '../inbox/origine';
import { estCodeLangue, estLangueConsole, TEXTE_MAX_CARACTERES, type LangueConsole, type Traduction } from '../traduction/traduire';
import type { FilTraduit } from '../traduction/fil';

/**
 * Ce que rend la route des compteurs quand la dépendance n'est pas câblée (suites de tests à deps minimales,
 * instance partielle). Des ZÉROS et non une erreur : un menu sans chiffres reste un menu.
 */
const COMPTEURS_VIDES: CompteursInbox = { tout: 0, aTraiter: 0, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 0, parMembre: [] };

/**
 * Durée de vie du micro-cache des compteurs de l'inbox (AUDIT-SCALE-2026-08-25.md, R7).
 *
 * 5 secondes, et pas plus : c'est ce qui mutualise les 25 utilisateurs d'un même client sur une requête sans
 * qu'aucun compteur ne devienne visiblement faux. Les écritures de l'inbox qui changent ces nombres
 * invalident de toute façon la clé du tenant, donc le seul retard réellement possible est celui d'un message
 * ENTRANT, qui arrive dans le worker (autre process, autre cache) : au pire 5 s sur une pastille déjà relue
 * toutes les 30 s.
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
  /** Cartes d'un template CAROUSEL, visuels DÉJÀ re-téléversés (`mediaId`). Absent = template classique. */
  carousel?: { cards: OutboundCarouselCard[] };
}

export interface InboxRouteDeps {
  /**
   * EFFACE LE CONTENU d'une conversation. Rend le nombre de messages effacés, `null` si elle n'est pas de cet
   * espace. Optionnelle : absente, la route rend 503 plutôt que d'exister sans rien faire.
   */
  effacerMessages?(tenantId: string, conversationId: string): Promise<number | null>;
  /**
   * Journal d'audit. Optionnel : absent -> aucune trace (câblages de test). BEST-EFFORT à l'appel : un
   * journal muet est un désagrément, une action bloquée par une écriture de log est un incident.
   */
  audit?: AuditSink;
  listConversations(tenantId: string, opts?: ListConversationsOptions): Promise<ConversationSummary[]>;
  /**
   * TROUVE OU CRÉE la conversation d'un contact, et rend son identifiant (`null` = contact inconnu de cet
   * espace, supprimé, ou sans aucune identité joignable).
   *
   * ⚠️ OPTIONNELLE, et c'est la seule raison acceptable ici : une instance dont le magasin est plus ancien
   * que cette route doit répondre « pas configuré » plutôt que tomber. La route le dit en 503.
   */
  ouvrirConversationDuContact?(tenantId: string, contactId: string): Promise<string | null>;
  /** Nombre de conversations non lues (pastille du menu). Optionnel : absent -> 0, la pastille ne s'affiche pas. */
  countUnread?(tenantId: string, acteur: { userId: string | null; role: string | null }): Promise<number>;
  /** Nombre de conversations « À traiter ». Optionnel : absent -> le compteur n'est pas rendu. */
  countATraiter?(tenantId: string): Promise<number>;
  /** Les compteurs du menu de dossiers, plus la charge par membre. */
  compterConversations?(tenantId: string): Promise<CompteursInbox>;
  /** Range une conversation dans Archivé, ou l'en sort. `false` = inconnue dans cet espace -> 404. */
  archiverConversation?(tenantId: string, conversationId: string, archive: boolean): Promise<boolean>;
  /**
   * Signale une conversation À LA MAIN, ou retire ce signalement (migration 0123).
   *
   * ⚠️ N'écrit PAS le constat de l'analyse : ce sont deux sources distinctes que le dossier « Signalé »
   * réunit. Absente -> la route rend 503, comme l'archivage.
   */
  signalerConversation?(tenantId: string, conversationId: string, signale: boolean, parUserId: string | null): Promise<boolean>;
  /**
   * Marque une conversation « Traité », ou retire ce statut (migration 0160). `false` = inconnue dans cet
   * espace -> 404. Absente -> la route rend 503, comme l'archivage.
   */
  marquerTraitee?(tenantId: string, conversationId: string, traitee: boolean): Promise<boolean>;
  /**
   * Transcrit le vocal d'un message, à la demande (2026-09-09).
   *
   * OPTIONNELLE : absente, la route rend 503 plutôt que d'échouer, comme l'archivage. Une instance sans clé
   * de modèle n'a pas à voir ses routes d'Inbox casser.
   *
   * ⚠️ Rend `deja` quand le message était DÉJÀ transcrit : l'écran doit pouvoir le dire, sinon un opérateur
   * qui reclique croit avoir déclenché un nouvel appel.
   */
  transcrireMessage?(
    tenantId: string,
    messageId: string,
    conversationId?: string,
    /**
     * La langue du LECTEUR, quand la traduction est allumée dans son navigateur (migration 0137).
     *
     * 🔴 ON TRADUIT LA TRANSCRIPTION, PAS LE CORPS : `body` vaut `[audio]` ou la légende, le traduire
     * ne produirait rien. Et c'est UN SEUL geste pour l'opérateur : il appuie sur Transcrire, et le
     * texte arrive dans sa langue même si le vocal était en espagnol.
     */
    cible?: LangueConsole | null,
  ): Promise<{ texte: string; deja: boolean; langue: string | null; traduction: string | null }>;
  /**
   * Les octets d'un message média, pour les servir au navigateur (2026-09-09).
   *
   * `null` = ce message ne porte aucun média. OPTIONNELLE : absente, la route rend 503, comme les autres
   * capacités de cet écran.
   */
  lireMediaMessage?(tenantId: string, messageId: string, conversationId?: string): Promise<{ bytes: Buffer; mime: string | null; nom?: string | null } | null>;
  /**
   * À qui la conversation est confiée. `undefined` = conversation inconnue, `null` = confiée à personne.
   * Optionnelle : absente, aucune conversation n'est considérée comme affectée et tout le monde écrit,
   * c'est-à-dire exactement le comportement d'avant l'affectation.
   */
  getAssignee?(tenantId: string, conversationId: string): Promise<string | null | undefined>;
  /** Affecte (ou libère avec `null`). `false` = conversation inconnue, ou membre étranger au tenant. */
  setAssignee?(tenantId: string, conversationId: string, assignee: string | null, parUserId: string | null): Promise<boolean>;
  /**
   * PREND une conversation du pot commun pour `userId`, SEULEMENT si elle est à personne (migration 0160).
   * `false` = inconnue ou déjà prise : la route relit l'affectation pour dire lequel.
   */
  prendreSiLibre?(tenantId: string, conversationId: string, userId: string): Promise<boolean>;
  /**
   * L'espace autorise-t-il ses agents à PRENDRE une conversation du pot commun ? Absente -> `false`, c'est-à-
   * dire le comportement d'avant le réglage.
   */
  agentsPeuventPrendre?(tenantId: string): Promise<boolean>;
  /**
   * Les membres à qui l'encadrement peut confier une conversation (id + nom affichable). Absente -> la route
   * rend une liste vide, et le sélecteur ne propose que « Non affectée », comme avant.
   */
  membresPourAffectation?(tenantId: string): Promise<Array<{ id: string; nom: string }>>;
  /** Marque un fil comme lu (un opérateur vient de l'ouvrir). Optionnel (deps de test minimales). */
  markConversationRead?(tenantId: string, conversationId: string): Promise<void>;
  /**
   * wa_id + état de la fenêtre de service 24 h. `null` si conversation absente, ou d'un autre espace.
   *
   * ⚠️ `langueContact` s'y est ajoutée avec la migration 0137 : la langue APPRISE du contact,
   * OPTIONNELLE dans le type pour que les câblages de test qui ne la rendent pas restent valides, et
   * `null` quand on n'a encore rien appris. Ce n'est PAS « français » : c'est elle que le bouton de
   * traduction sortante lit pour nommer sa cible, et supposer une langue ferait promettre
   * « Traduire en espagnol » à un anglophone.
   */
  getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean; langueContact?: string | null } | null>;
  /**
   * Traduit les ENTRANTS d'un fil vers la langue du lecteur, et range le resultat (migration 0137).
   *
   * OPTIONNELLE : absente, la route rend le fil en VO avec `traductionIndisponible`, jamais une
   * erreur. Une instance sans cle de modele n'a pas a voir son Inbox casser.
   *
   * ⚠️ Elle rend les messages ENRICHIS, pas remplaces : meme nombre, meme ordre, plus les trois
   * etats (`affiche`, `traduit`, `traductionEchouee`).
   */
  traduireFil?(
    tenantId: string,
    conversationId: string,
    messages: ConversationMessage[],
    cible: LangueConsole,
  ): Promise<FilTraduit<ConversationMessage>>;
  /**
   * Traduit UN texte que l'operateur s'apprete a envoyer. `null` = la traduction n'a pas abouti.
   *
   * 🔴 JAMAIS AUTOMATIQUE : c'est un bouton, avant l'envoi. Une traduction ratee en entree se
   * rattrape sur l'original affiche a cote ; une traduction ratee en sortie est partie chez un
   * client, et aucun message WhatsApp livre ne se rappelle.
   */
  traduireSortant?(tenantId: string, texte: string, cible: string): Promise<Traduction | null>;
  /** Cet espace peut-il traduire ? `false` = pas de cle de modele, donc pas de credit. */
  traductionDisponible?(tenantId: string): Promise<boolean>;
  /** Pose/retire la surcharge de reprise d'UN fil (C.4). null = suit le défaut du tenant. Optionnel (deps de test minimales). */
  getMessages(conversationId: string, apres?: { at: string; id: string }): Promise<ConversationMessage[]>;
  /**
   * Un opérateur vient d'écrire : il PREND le fil. Posé depuis la route et non depuis le store, parce que
   * seule la route sait qu'un humain authentifié est à l'origine de l'envoi. Sans condition `only` : un
   * humain prend toujours la main, y compris sur MBA (côté Meta, envoyer suffit à prendre le contrôle).
   * Optionnel pour ne pas casser les suites de tests qui construisent des deps minimales.
   */
  takeControl?(tenantId: string, waId: string): Promise<void>;
  /**
   * PREND le fil À L'AGENT DE META, sans écrire au client (`thread_control`, action `take`).
   *
   * 🔴 DISTINCTE DE `takeControl`, ET CE N'EST PAS UN DOUBLON. `takeControl` n'écrit QUE notre état local,
   * et c'est tout ce qu'il faut sur les chemins d'ENVOI : écrire un message prend déjà le fil chez Meta,
   * implicitement. Ici il n'y a pas de message, donc rien ne le dit à Meta, et c'est précisément le défaut
   * signalé par Julien le 2026-09-11 : après « Reprendre la main », l'agent de Meta répondait au message
   * suivant du client comme si de rien n'était.
   *
   * ⚠️ LÈVE si Meta refuse, et la route en fait un 4xx lisible. Optionnelle : absente, le bouton garde son
   * ancien comportement local, ce qui est le bon repli pour une instance sans MBA.
   */
  prendreLeFil?(tenantId: string, waId: string): Promise<void>;
  /**
   * L'opérateur REND la main : la conversation repart en automatique. Renvoie qui la détient désormais.
   *
   * ⚠️ ELLE APPELLE META, depuis le 2026-09-10 : `thread_control` action `release`, pour que l'agent de Meta
   * redevienne le répondeur principal. Ce texte annonçait cet appel au FUTUR (« quand MBA sera actif, c'est
   * ici qu'il faudra ») et disait que la fonction « se contente de l'état local » : c'était faux depuis un
   * jour quand la revue l'a relevé, le 2026-09-11. Son jumeau `prendreLeFil`, juste en dessous, fait le
   * geste inverse.
   *
   * 🔴 UN ÉCHEC REMONTE, il ne s'avale pas : la route en fait un 409 lisible, et notre état local ne bouge
   * pas. Un état local qui annonce ce que Meta n'a pas fait est pire qu'une erreur.
   */
  releaseControl?(tenantId: string, waId: string): Promise<'app_workflow' | 'mba'>;
  /** Détenteur courant du fil, pour l'afficher dans le détail de la conversation. */
  getControlOwner?(tenantId: string, waId: string): Promise<'app_workflow' | 'app_human' | 'mba'>;
  recordOutbound(
    conversationId: string,
    body: string,
    messageId: string | null,
    /** D'OÙ vient le message (migration 0099). Obligatoire : elle était déduite, et la déduction a menti
     *  dès qu'un appelant sans expéditeur humain est apparu (le serveur MCP). */
    origine: OrigineMessage,
    type?: string,
    templateCategory?: string | null,
    templateName?: string | null,
    senderUserId?: string | null,
    /** Canal de la bulle. Absent -> WhatsApp. */
    channel?: 'whatsapp' | 'rcs',
    /**
     * Ce que l'opérateur avait ÉCRIT avant de faire traduire (migration 0137). `body`, lui, porte ce
     * qui est PARTI. Absent -> les deux sont la même chose, ce qui est le cas de tout envoi non traduit.
     */
    redactionOrigine?: string | null,
  ): Promise<void>;
  /** Numéro du tenant depuis lequel répondre. */
  getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
  /**
   * Variables d'un template DÉJÀ résolues sur la fiche de ce contact, avec le libellé du champ qui les
   * alimente. C'est ce que l'écran d'envoi affiche : l'opérateur voit les vraies valeurs, pas `{{1}}`.
   *
   * OPTIONNELLE : absente, l'écran retombe sur des champs vides à remplir à la main (comportement d'avant).
   */
  resolveTemplateParams?(
    tenantId: string,
    waId: string,
    template: { name: string; language: string; count: number },
  ): Promise<{ values: string[]; labels: string[] }>;
  /**
   * Envoie un message de la bibliothèque RCS à ce contact, variables résolues sur sa fiche.
   *
   * Rend `{ messageId, apercu }` quand c'est parti, ou `{ refus }` avec une raison DESTINÉE À L'OPÉRATEUR
   * (canal éteint, message supprimé depuis, contact désabonné du RCS). Optionnelle : absente, la route
   * répond 422 « canal RCS non disponible » au lieu de 500 sur des deps de test minimales.
   */
  sendRcsFromInbox?(
    tenantId: string,
    waId: string,
    contenu: { rcsMessageId: string } | { text: string },
  ): Promise<{ messageId: string; apercu: string } | { refus: string }>;
  /** Envoie une réponse texte (fenêtre de service 24 h). `tenantId` -> token Meta PAR TENANT (B1). Retourne le message_id. */
  sendReply(tenantId: string, phoneNumberId: string, to: string, text: string): Promise<string>;
  /** Envoie un template (autorisé hors fenêtre). `tenantId` -> token Meta PAR TENANT. Retourne le message_id. */
  sendTemplateMessage(tenantId: string, phoneNumberId: string, to: string, tpl: OutboundTemplate): Promise<string>;
  /**
   * Ce contact a-t-il demandé à ne plus être contacté ? REQUISE depuis le lot 3 du plan 2026-09-14 : elle
   * valait « aucun blocage » quand elle manquait, ce qui faisait dépendre la garde d'un câblage lointain.
   *
   * ⚠️ Elle ne sert PAS à la réponse texte de cette route, qui reste exemptée : seul l'envoi d'un MODÈLE la
   * consulte, parce qu'un modèle ROUVRE une conversation au lieu de répondre dans une conversation ouverte.
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /**
   * La catégorie RÉELLE d'un modèle, telle que Meta la connaît. `null` = indéterminable.
   *
   * 🔴 ELLE NE VIENT PAS DU CORPS DE LA REQUÊTE, et c'est tout l'intérêt. `templateCategory` y est bien
   * présent, mais il est fourni par le NAVIGATEUR et ne sert qu'aux statistiques : s'en servir comme d'une
   * garde laisserait n'importe qui se déclarer « utility » pour écrire à un contact désabonné. Même règle
   * que le rôle, qui vient du jeton et jamais du corps.
   *
   * ⚠️ N'EST APPELÉE QUE SUR UN CONTACT DÉSABONNÉ, donc le cas ordinaire ne paie aucune lecture chez Meta.
   */
  categorieDuModele?(tenantId: string, name: string, language: string): Promise<'marketing' | 'utility' | null>;
  /**
   * Template CAROUSEL : relit ses cartes chez Meta et prépare leurs visuels pour l'envoi (re-téléversement).
   * `null` = ce template n'est pas un carousel (envoi inchangé). `{ refus }` = il en est un mais n'est pas
   * envoyable, et la raison est destinée à l'opérateur.
   *
   * Pourquoi la route en dépend au lieu de laisser l'envoi échouer : sans re-téléversement, Meta ACCEPTE
   * l'envoi (200 + id) puis ne le livre jamais (131053). Un « envoyé » à l'écran sans message sur le
   * téléphone est exactement ce qu'on ne veut plus. Absente -> aucun carousel n'est envoyable depuis l'inbox.
   */
  prepareCarousel?(
    tenantId: string,
    name: string,
    language: string,
  ): Promise<{ cards: OutboundCarouselCard[] } | { refus: string } | null>;
  /**
   * Démarre un SCÉNARIO sur cette conversation (l'opérateur le déclenche depuis l'Inbox).
   *
   * `windowOpen` décide de ce qui est permis, et c'est toute la règle métier : fenêtre OUVERTE, le scénario
   * peut ouvrir par un message rapide ou un formulaire ; fenêtre FERMÉE, seul un scénario qui ouvre par un
   * template configuré peut partir, les autres seraient refusés par Meta (131047).
   *
   * Rendu : `true` = parti. Une CHAÎNE = pas parti, avec la raison exacte à montrer à l'opérateur.
   * `null` = scénario inconnu pour ce workspace. Absente -> la fonctionnalité est indisponible (503).
   */
  startWorkflow?(tenantId: string, workflowId: string, waId: string, windowOpen: boolean): Promise<true | string | null>;
}

/**
 * Boîte de réception : lister/lire une conversation, répondre (texte dans la fenêtre 24 h,
 * template hors fenêtre). Lectures + réponse ouvertes à tout compte authentifié.
 */
export function registerInbox(app: FastifyInstance, deps: InboxRouteDeps, garde: PreHandler, gardeAdmin: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
  /**
   * 🔴 LA GARDE DES GESTES QUI COÛTENT DE L'ARGENT RÉEL (2026-09-09). L'Inbox n'en avait aucun jusqu'à la
   * transcription : tous ses gestes écrivent en base et rien de plus. Celui-ci appelle un modèle, et il est
   * payé sur NOTRE clé maison. Sous le seul plafond général (300 appels par minute et par utilisateur), un
   * script pourrait donc transcrire trois cents vocaux la minute à nos frais. L'idempotence ne protège que
   * du re-clic sur LE MÊME message, pas de trois cents messages différents.
   */
  const couteux = gardeEtendue(garde, limiteCouteuse);
  /**
   * La garde des gestes RÉSERVÉS AUX ADMINISTRATEURS de cet écran. Il n'y en a qu'un : effacer le contenu
   * d'une conversation. Un opérateur répond aux clients, il n'efface pas des traces.
   *
   * ⚠️ IL N'Y A PLUS DE REPLI, ET IL N'EN FAUT PLUS (lot 2 du plan 2026-09-14). Ce paramètre était optionnel
   * et retombait sur la garde générale quand il manquait, ce qui était le bon sens de l'échec tant que
   * l'oubli était possible. Il ne l'est plus : le type l'exige.
   */
  const optsAdmin = { preHandler: gardeAdmin };
  const journal = makeJournal(deps.audit);
  // Micro-cache des compteurs (R7). Instancié ici, donc un par serveur construit : deux instances de test ne
  // se partagent rien, et il meurt avec le process.
  // ⚠️ Ils sont TROIS depuis le 2026-09-08 (non-lus, à traiter, et le menu de dossiers), d'où la seconde
  // instance juste en dessous : ce commentaire disait « les DEUX » et l'oublier aurait laissé croire que la
  // liste d'invalidation était complète alors qu'il lui en manquait un.
  const compteurs = cacheCourt<number>(COMPTEURS_TTL_MS);
  /**
   * 🔴 LA CLÉ PORTE L'UTILISATEUR, et l'oublier ferait fuiter un chiffre d'un compte à l'autre. La pastille
   * n'est plus celle de l'espace : deux membres du même client attendent deux nombres différents, et un
   * cache indexé sur le seul espace servirait au second celui du premier.
   */
  const cleUnread = (tenant: string, userId: string | null): string => `unread:${tenant}:${userId ?? '-'}`;
  const cleATraiter = (tenant: string): string => `todo:${tenant}`;
  /**
   * Le MÊME mécanisme, une seconde instance : le menu de dossiers rend un OBJET, pas un nombre, et le cache
   * est typé. Ce qui compte est qu'il n'y ait qu'UN endroit où l'on invalide, juste en dessous.
   */
  const compteursMenu = cacheCourt<CompteursInbox>(COMPTEURS_TTL_MS);
  const cleMenu = (tenant: string): string => `menu:${tenant}`;
  /** Une écriture vient de changer ce que les compteurs disent : TOUS repartent en base au prochain appel.
   *  🔴 Un compteur oublié ici resterait juste assez longtemps pour qu'on le croie. */
  const invaliderCompteurs = (tenant: string): void => {
    // ⚠️ PAR PRÉFIXE pour les non-lus : la clé porte l'utilisateur depuis que la pastille est la sienne, donc
    // invalider `unread:<espace>` tout court ne toucherait plus aucune entrée. Un compteur qu'on croit
    // invalidé et qui ne l'est pas est précisément le défaut que ce mécanisme existe pour éviter.
    compteurs.invaliderPrefixe(`unread:${tenant}:`);
    compteurs.invalider(cleATraiter(tenant));
    compteursMenu.invalider(cleMenu(tenant));
  };

  /**
   * Le réglage « les agents peuvent prendre », lu seulement quand il décide de quelque chose.
   *
   * 🔴 LA LISTE NE DOIT PAS TOMBER POUR UN RÉGLAGE (revue du 2026-09-19). Lu sans garde, un échec de cette
   * lecture rendait 500 sur la liste ENTIÈRE, c'est-à-dire l'Inbox vide pour tout le monde, pour un bouton.
   * Un échec rend `null` (« illisible ») et il est JOURNALISÉ : avalé en silence, une lecture qui échoue
   * durablement couperait le bouton de tous les agents sans laisser de trace. La liste le lit comme « non » ;
   * la route qui écrit refuse, mais en disant la vraie raison. Et l'encadrement n'en a pas besoin
   * (`peutPrendre` le lui accorde de toute façon) : on ne le lit pas pour lui.
   */
  async function reglagePrise(
    tenant: string,
    acteur: { userId: string | null; role: string | null },
  ): Promise<boolean | null> {
    if (!deps.agentsPeuventPrendre || peutAffecter(acteur)) return false;
    try {
      return await deps.agentsPeuventPrendre(tenant);
    } catch (err) {
      // ⚠️ `journaliser`, pas le journal de Fastify : celui-ci est MUET (`logger: false`). Cette fonction le
      // recevait en paramètre, et la promesse « il est JOURNALISÉ » ci-dessus n'était pas tenue.
      journaliser('warn', 'reglage_prise_illisible', { err, tenantId: tenant });
      return null;
    }
  }

  app.get('/tenants/:tenantId/conversations', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    // Query string = entrée NON FIABLE. Chaque paramètre est lu dans sa forme attendue et ignoré sinon : un
    // filtre mal formé doit rendre la page normale, jamais une page vide qui se lirait « aucune conversation ».
    const q = (req.query ?? {}) as {
      limit?: unknown; beforeAt?: unknown; beforeId?: unknown; id?: unknown;
      aTraiter?: unknown; signalees?: unknown; archivees?: unknown; traitees?: unknown; affectee?: unknown;
    };
    const opts: ListConversationsOptions = {};
    /**
     * UNE conversation précise. Sert le lien « Ouvrir la conversation » du mini-CRM, dont la cible peut être
     * un vieux fil, donc hors de la première page.
     *
     * 🔴 `estUuid` COMME PARTOUT DANS CE FICHIER (relecture du 2026-09-23). Le paramètre lié empêche bien
     * l'injection, mais ce n'est pas la question que pose la convention posée 120 lignes plus bas : un
     * identifiant mal formé fait lever Postgres (`22P02`), donc un 500 que Cloudflare remplace par sa propre
     * page, et l'opérateur ne voit même pas ce qu'on lui reproche. Ici, en plus, le commentaire juste
     * au-dessus exige qu'un filtre mal formé rende la page NORMALE : on l'ignore donc, comme les autres.
     */
    if (typeof q.id === 'string' && estUuid(q.id)) opts.id = q.id;
    const limit = Number(q.limit);
    if (Number.isInteger(limit) && limit > 0) opts.limit = limit;
    if (q.aTraiter === '1' || q.aTraiter === 'true') opts.aTraiter = true;
    if (q.signalees === '1' || q.signalees === 'true') opts.signalees = true;
    // Le dossier ARCHIVÉ. Absent = les dossiers ordinaires, qui excluent les archivées : c'est le défaut,
    // et c'est celui qu'un appelant qui ne connaît pas ce paramètre doit obtenir.
    if (q.archivees === '1' || q.archivees === 'true') opts.archivees = true;
    // Le dossier « Traité » (migration 0160). ⚠️ Lu ICI, sur la route, et c'est la ligne qu'on oublie : le
    // filtre par membre de juste en dessous a vécu des semaines supporté par le magasin, envoyé par l'écran,
    // et jeté entre les deux.
    if (q.traitees === '1' || q.traitees === 'true') opts.traitees = true;
    /**
     * 🔴 LE FILTRE PAR MEMBRE ÉTAIT JETÉ ICI, ET NULLE PART AILLEURS (constaté par Julien le 2026-09-15).
     * Le magasin le SUPPORTE (`ListConversationsOptions.affectee`, `store.pg.ts`), l'écran l'ENVOIE
     * (`dossierEnParams`, `?affectee=<id>`), et cette route ne le LISAIT pas : cliquer sur un membre
     * n'avait aucun effet, la liste entière restait affichée. Le motif « une capacité câblée sur deux
     * consommateurs sur trois », et c'est la route, au milieu, qui manquait.
     *
     * ⚠️ `'aucune'` EST UNE VALEUR, pas une absence : c'est le dossier « Non affectées ». Le confondre avec
     * un paramètre absent rendrait ce dossier-là identique à « Tout ».
     */
    if (typeof q.affectee === 'string' && q.affectee !== '') opts.affectee = q.affectee;
    // Le curseur n'a de sens qu'ENTIER : une moitié rendrait une page arbitraire, donc on exige les deux.
    if (typeof q.beforeAt === 'string' && q.beforeAt !== '' && typeof q.beforeId === 'string' && q.beforeId !== '') {
      opts.before = { at: q.beforeAt, id: q.beforeId };
    }
    const conversations = await deps.listConversations(tenant, opts);
    // `assignedToMe` est calculé ICI plutôt que déduit à l'écran : la session du navigateur ne porte pas
    // d'identifiant d'utilisateur, et lui en ajouter un toucherait l'authentification pour un besoin
    // d'affichage. Le serveur, lui, sait déjà qui appelle.
    const moi = req.auth?.userId ?? null;
    const acteur = { userId: moi, role: req.auth?.role ?? null };
    /**
     * PEUT-IL PRENDRE UNE CONVERSATION DU POT COMMUN ? (migration 0160)
     *
     * 🔴 CALCULÉ PAR LA MÊME RÈGLE QUE LA ROUTE QUI ÉCRIT (`peutPrendre`), sur une conversation à personne :
     * l'écran montre le bouton « Je m'en occupe » sur les lignes non affectées quand ce drapeau est vrai. Deux
     * règles écrites séparément finiraient par proposer un geste que le serveur refuse.
     */
    const reglage = await reglagePrise(tenant, acteur);
    return reply.code(200).send({
      conversations: conversations.map((c) => ({ ...c, assignedToMe: moi !== null && c.assignedTo === moi })),
      peutPrendre: deps.prendreSiLibre !== undefined && peutPrendre(acteur, null, reglage === true),
    });
  });

  /**
   * Compteur « À traiter ». Route dédiée, même raison que le compteur de non-lus : l'écran le calculait sur
   * les conversations chargées, donc il plafonnait à la taille de la page et affichait moins que la réalité.
   * Déclarée AVANT `/conversations/:conversationId` : `counts` n'est pas un identifiant.
   *
   * ⚠️ Rend un objet à ZÉROS quand la dépendance n'est pas câblée, jamais une erreur : un menu sans chiffres
   * reste un menu utilisable, alors qu'une 503 rendrait tout l'écran indisponible pour un ornement.
   */
  app.get('/tenants/:tenantId/conversations/counts', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.compterConversations) return reply.code(200).send(COMPTEURS_VIDES);
    // `deps.compterConversations(...)` DANS la fermeture, jamais une référence détachée : même raison que
    // pour `todo-count` juste en dessous.
    const compte = await compteursMenu.lire(cleMenu(tenant), () => deps.compterConversations!(tenant));
    return reply.code(200).send(compte);
  });

  /**
   * Archiver / désarchiver une conversation.
   *
   * DEUX routes et non un PATCH à drapeau : l'intention se lit dans l'adresse, et un corps mal formé ne peut
   * pas transformer un archivage en son contraire.
   *
   * Ouvert aux OPÉRATEURS comme aux admins (`garde` et non `gardeAdmin`) : ranger sa boîte est le geste de
   * celui qui la traite, pas une décision d'administration.
   */
  for (const [chemin, archive] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/tenants/:tenantId/conversations/:conversationId/${chemin}`, opts, async (req, reply) => {
      const tenant = scopeTenant(req);
      if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
      if (!deps.archiverConversation) return reply.code(503).send({ error: 'archivage indisponible sur cette instance' });
      const { conversationId } = req.params as { conversationId: string };
      // 404 et non 200 : une conversation inconnue (ou d'un autre espace) doit se voir, sinon l'écran
      // annoncerait un rangement qui n'a pas eu lieu.
      if (!(await deps.archiverConversation(tenant, conversationId, archive))) {
        return reply.code(404).send({ error: 'conversation inconnue' });
      }
      invaliderCompteurs(tenant); // deux dossiers viennent de changer de contenu.
      return reply.code(200).send({ archived: archive });
    });
  }

  /**
   * Signaler / ne plus signaler une conversation, À LA MAIN (2026-09-09).
   *
   * Même forme que l'archivage juste au-dessus, et pour les mêmes raisons : deux adresses plutôt qu'un PATCH
   * à drapeau, et ouvert aux OPÉRATEURS. Signaler un échange qui a mal tourné est le geste de celui qui le
   * lit, pas une décision d'administration.
   *
   * 🔴 L'AUTEUR EST PRIS DANS LA SESSION, jamais dans le corps. Un identifiant fourni par l'appelant
   * laisserait signaler au nom d'un collègue, sur une conversation de client.
   */
  for (const [chemin, signale] of [['signaler', true], ['ne-plus-signaler', false]] as const) {
    app.post(`/tenants/:tenantId/conversations/:conversationId/${chemin}`, opts, async (req, reply) => {
      const tenant = scopeTenant(req);
      if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
      if (!deps.signalerConversation) return reply.code(503).send({ error: 'signalement indisponible sur cette instance' });
      const { conversationId } = req.params as { conversationId: string };
      if (!(await deps.signalerConversation(tenant, conversationId, signale, req.auth?.userId ?? null))) {
        return reply.code(404).send({ error: 'conversation inconnue' });
      }
      invaliderCompteurs(tenant); // le dossier « Signalé » vient de changer de contenu.
      return reply.code(200).send({ signalee: signale });
    });
  }

  /**
   * Marquer « Traité » / ne plus marquer traité (migration 0160, demande de Julien du 2026-09-19).
   *
   * Même forme que l'archivage et le signalement, et pour les mêmes raisons : deux adresses, ouvertes aux
   * OPÉRATEURS. Dire « j'ai fini avec ce fil » est le geste de celui qui le traite.
   *
   * ⚠️ AUCUN GESTE INVERSE AUTOMATIQUE ICI : c'est le prochain message du CONTACT qui retire le statut, dans
   * l'écriture qui l'enregistre (`upsertConversationByWaId`), sauf une réaction emoji, qui le laisse. Cette route ne fait que la pose et le retrait
   * à la main.
   *
   * ⚠️ `estUuid` AVANT la base : un identifiant mal formé ferait lever Postgres (`22P02`), donc un 500
   * qu'aucun opérateur ne sait lire. Une conversation qui n'existe pas se dit en 404.
   */
  for (const [chemin, traitee] of [['traiter', true], ['ne-plus-traiter', false]] as const) {
    app.post(`/tenants/:tenantId/conversations/:conversationId/${chemin}`, opts, async (req, reply) => {
      const tenant = scopeTenant(req);
      if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
      if (!deps.marquerTraitee) return reply.code(503).send({ error: 'statut « Traité » indisponible sur cette instance' });
      const { conversationId } = req.params as { conversationId: string };
      if (!estUuid(conversationId) || !(await deps.marquerTraitee(tenant, conversationId, traitee))) {
        return reply.code(404).send({ error: 'conversation inconnue' });
      }
      invaliderCompteurs(tenant); // « À traiter » et « Traité » viennent de changer de contenu.
      return reply.code(200).send({ traitee });
    });
  }

  /**
   * L'opérateur PREND le fil : il sort le dossier « À traiter » de son statut de simple reflet.
   *
   * 🔴 CE GESTE N'AVAIT AUCUN BOUTON. On ne prenait un fil qu'en RÉPONDANT (l'envoi appelle `takeControl`),
   * donc « remettre une conversation à traiter » sans rien écrire au client était impossible : il fallait
   * envoyer un message qu'on n'avait pas à envoyer. C'est le miroir exact de `release`, qui existait seul.
   *
   * ⚠️ `takeControl` est appelé en BEST-EFFORT sur les chemins d'envoi (le message est déjà parti, un échec
   * de bascule ne doit pas le faire passer pour raté). Ici c'est l'inverse : la bascule EST le geste, un
   * échec doit se voir. On ne l'avale donc pas.
   */
  /**
   * OUVRIR LA CONVERSATION D'UN CONTACT depuis le mini-CRM (demande de Julien du 2026-09-23).
   *
   * 🔴 `POST` ET PAS `GET`, parce qu'elle ÉCRIT : un contact qui n'a jamais parlé n'a pas de fil, et ce
   * geste le crée. Un `GET` qui crée une ligne est le genre de route qu'un préchargement de navigateur
   * déclenche tout seul.
   *
   * ⚠️ ELLE EST IDEMPOTENTE : deux clics rendent le MÊME identifiant, parce que la clé `(tenant_id, wa_id)`
   * de 0009 l'impose et que le magasin s'appuie dessus (`on conflict`). Cliquer deux fois ne crée pas deux
   * fils, et n'en fait pas remonter un ancien.
   *
   * 404 quand le contact est inconnu de cet espace, supprimé, ou sans aucune identité joignable : il n'y a
   * alors aucun fil possible, et en inventer un le rendrait inatteignable.
   */
  app.post('/tenants/:tenantId/contacts/:contactId/conversation', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.ouvrirConversationDuContact) return reply.code(503).send({ error: 'ouverture de conversation non configuree' });
    const { contactId } = req.params as { contactId: string };
    // ⚠️ `estUuid` AVANT la base, même raison qu'ailleurs dans ce fichier : un identifiant mal formé ferait
    // lever Postgres, donc un 500 illisible, là où « ce contact n'existe pas » est la réponse juste.
    if (!estUuid(contactId)) return reply.code(404).send({ error: 'contact introuvable, supprime, bloque, ou sans numero' });
    const id = await deps.ouvrirConversationDuContact(tenant, contactId);
    if (id === null) return reply.code(404).send({ error: 'contact introuvable, supprime, bloque, ou sans numero' });
    return reply.code(200).send({ conversationId: id });
  });

  app.post('/tenants/:tenantId/conversations/:conversationId/prendre', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    if (!deps.takeControl) return reply.code(503).send({ error: 'prise du fil indisponible sur cette instance' });
    /**
     * 🔴 META D'ABORD, NOTRE ÉTAT ENSUITE, comme pour `release`. L'ordre inverse est ce qui a produit le
     * bug : un état local qui annonce ce que Meta n'a pas fait est pire qu'une erreur, parce qu'il rend le
     * problème invisible jusqu'au prochain message du client.
     *
     * 🔴 ET LE REFUS SORT EN 409, PAS EN 500. Meta réserve l'action `take` au « configured escalation
     * partner » : un refus est un cas NORMAL, pas une panne. Cloudflare remplace le corps de toute réponse
     * 5xx par sa page d'erreur, donc un message destiné à l'opérateur doit sortir en 4xx. Et il lui donne la
     * porte de secours, qui reste vraie quoi qu'il arrive : ÉCRIRE prend le fil à coup sûr.
     */
    if (deps.prendreLeFil) {
      try {
        await deps.prendreLeFil(tenant, ctx.waId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`prendre: Meta a refusé de céder le fil (${tenant}/${ctx.waId}):`, err instanceof Error ? err.message : err);
        return reply.code(409).send({ error: 'Meta n’a pas cédé la conversation, son agent peut encore répondre. Envoyez un message : écrire prend le fil à coup sûr.' });
      }
    }
    await deps.takeControl(tenant, ctx.waId);
    invaliderCompteurs(tenant); // le fil entre dans « À traiter ».
    return reply.code(200).send({ controlOwner: 'app_human' });
  });

  /**
   * SERVIR le fichier d'un message média au navigateur (2026-09-09).
   *
   * 🔴 POURQUOI CETTE ROUTE EXISTE PLUTÔT QU'UN LIEN DIRECT. L'URL que rend Meta vit quelques minutes ET
   * exige notre jeton dans un en-tête : une balise `<audio src>` ne peut ni l'un ni l'autre. La donner au
   * front produirait des lectures qui marchent au premier essai et échouent cinq minutes plus tard, ce qui
   * est la pire forme de panne. On sert donc les octets nous-mêmes, sous la garde d'espace habituelle.
   *
   * ⚠️ PAS de plafond de débit COÛTEUX ici, contrairement à la transcription : écouter ne coûte rien à un
   * modèle, seulement de la bande passante, et le plafond général suffit. Les deux gestes se ressemblent à
   * l'écran et n'ont pas du tout le même prix : les mettre sous la même garde aurait rationné le geste
   * gratuit pour protéger le payant.
   */
  app.get('/tenants/:tenantId/conversations/:conversationId/messages/:messageId/media', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId, messageId } = req.params as { conversationId: string; messageId: string };
    if (!estUuid(messageId)) return reply.code(404).send({ error: 'message inconnu' });
    if (!deps.lireMediaMessage) return reply.code(503).send({ error: 'lecture des médias indisponible sur cette instance' });
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    try {
      const f = await deps.lireMediaMessage(tenant, messageId, conversationId);
      if (!f) return reply.code(404).send({ error: 'ce message ne porte aucun média' });
      /**
       * 🔴 `inline` POUR UNE IMAGE AFFICHABLE, `attachment` POUR TOUT LE RESTE, et `nosniff` partout
       * (`enTetesMedia`). Un document reçu porte le type que son EXPÉDITEUR annonce : servi tel quel, un
       * `text/html` ou un SVG s'exécuterait dans l'origine de la console. `no-store` : ces octets sont ceux
       * d'un client, ils n'ont rien à faire dans un cache partagé.
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
   * TRANSCRIRE le vocal d'UN message, À LA DEMANDE (2026-09-09, demande de Julien).
   *
   * 🔴 UN BOUTON, PAS UN AUTOMATISME, et c'est son choix : « soit l'écouter avec un petit bouton lecture,
   * soit le demander à transcrire ». Neuf fois sur dix un opérateur écoute, c'est plus rapide que de lire :
   * transcrire tout ferait payer un service que personne n'a demandé. Le chemin de l'AGENT, lui, sera
   * automatique, parce qu'un modèle ne sait pas écouter.
   *
   * ⚠️ IDEMPOTENTE : deux clics, ou deux opérateurs sur la même conversation, ne paient pas deux fois. La
   * réponse dit `deja` pour que l'écran puisse le montrer plutôt que de laisser croire à un nouvel appel.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/messages/:messageId/transcrire', couteux, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId, messageId } = req.params as { conversationId: string; messageId: string };
    if (!estUuid(messageId)) return reply.code(404).send({ error: 'message inconnu' });
    // La conversation est relue DANS l'espace : c'est elle qui porte l'isolation, un identifiant de message
    // seul ne dit pas à qui il appartient.
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    if (!deps.transcrireMessage) return reply.code(503).send({ error: 'transcription indisponible sur cette instance' });
    /**
     * `traduire` dans le CORPS : la langue de lecture vient du navigateur, exactement comme pour le
     * fil. Une valeur hors de nos deux langues est IGNORÉE, et on transcrit sans traduire : un
     * paramètre mal formé ne doit jamais priver l'opérateur de sa transcription.
     */
    const demande = (req.body ?? {}) as { traduire?: unknown };
    const cible = estLangueConsole(demande.traduire) ? demande.traduire : null;
    try {
      const r = await deps.transcrireMessage(tenant, messageId, conversationId, cible);
      return reply.code(200).send(r);
    } catch (err) {
      // 🔴 4xx et JAMAIS 5xx : Cloudflare remplace le corps de toute réponse 5xx par sa page d'erreur, donc
      // le message se perdrait exactement quand il sert. Et les trois causes n'appellent pas la même action :
      // rien à transcrire (l'écran n'aurait pas dû proposer le bouton), fichier trop lourd (rien à faire),
      // panne du fournisseur (réessayer).
      if (err instanceof RienATranscrire) return reply.code(422).send({ error: 'ce message ne porte aucun vocal à transcrire' });
      // Le vocal a disparu chez Meta (sept jours) : rien ne le fera revenir, « réessayez » serait faux.
      if (err instanceof MediaExpire) return reply.code(410).send({ error: err.message, code: 'media_expire' });
      if (err instanceof MediaTropGros) {
        return reply.code(422).send({ error: `vocal trop long pour être transcrit (${Math.round(err.octets / 1024)} Ko, maximum ${Math.round(err.plafond / 1024)} Ko)` });
      }
      // Journalisé ICI, sous les trois cas métier : un vocal expiré n'est pas une erreur, et chaque clic sur
      // l'un d'eux écrivait une ligne `error`, pile comprise. Même place que `media_illisible`.
      journaliser('error', 'transcription_impossible', { err, tenantId: tenant, messageId });
      return reply.code(422).send({ error: 'la transcription a échoué, réessayez dans un instant' });
    }
  });

  /**
   * TRADUIRE CE QUE L'OPÉRATEUR S'APPRÊTE À ENVOYER (2026-09-12).
   *
   * 🔴 ELLE NE FAIT QUE TRADUIRE, ELLE N'ENVOIE RIEN, et c'est la garde centrale de ce lot. Une
   * traduction ratée en ENTRÉE se rattrape sur l'original affiché à côté ; une traduction ratée en
   * SORTIE est partie chez un client, et aucun message WhatsApp livré ne se rappelle. L'opérateur
   * voit donc le texte traduit dans sa zone de saisie AVANT de cliquer sur Envoyer.
   *
   * 🔴 LA CIBLE EST CELLE DU CONTACT, PAS UNE DE NOS DEUX LANGUES : c'est la moitié dissymétrique de
   * la règle. Un entrant se traduit vers la langue du LECTEUR (fr ou en), un sortant vers celle du
   * CONTACT, qui écrit ce qu'il veut. L'écran la NOMME dans le libellé du bouton, donc l'opérateur
   * sait où part sa phrase avant de valider.
   *
   * ⚠️ PAS de plafond de débit « coûteux » ici, contrairement à la transcription, et la différence
   * est le PAYEUR. La transcription est sur NOTRE clé, donc un script pourrait nous facturer trois
   * cents vocaux la minute ; la traduction est sur le crédit PRÉPAYÉ du client (migration 0124), qui
   * est sa propre borne. Et ce plafond-là est par ESPACE : à 10 par minute, une équipe de cinq
   * opérateurs qui traduisent chacun deux réponses le saturerait, sur un geste délibéré.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/traduire', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const b = (req.body ?? {}) as { texte?: unknown; cible?: unknown };
    if (!nonEmpty(b.texte)) return reply.code(400).send({ error: 'texte requis' });
    if (b.texte.length > TEXTE_MAX_CARACTERES) {
      // 4xx et jamais 5xx, et surtout jamais une troncature : une traduction coupée en deux
      // s'afficherait comme un message entier.
      return reply.code(422).send({ error: `texte trop long pour être traduit (maximum ${TEXTE_MAX_CARACTERES} caractères)` });
    }
    if (!estCodeLangue(b.cible)) return reply.code(400).send({ error: 'cible requise (code de langue)' });
    // La conversation est relue DANS l'espace : elle porte l'isolation, et traduire pour un fil qu'on
    // ne possède pas n'a aucun sens même si rien n'en sort.
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    if (!deps.traduireSortant) return reply.code(503).send({ error: 'traduction indisponible sur cette instance' });
    if (deps.traductionDisponible && !(await deps.traductionDisponible(tenant))) {
      // ⚠️ 422 et NON 503 : ce n'est pas une panne de l'instance, c'est un espace sans crédit de
      // modèle. Le code est lu par l'écran, qui en fait une phrase actionnable.
      return reply.code(422).send({ error: 'Cet espace n’a pas de crédit de modèle : la traduction est indisponible.', code: 'traduction_indisponible' });
    }
    const r = await deps.traduireSortant(tenant, b.texte.trim(), b.cible.trim().toLowerCase());
    if (r === null) return reply.code(422).send({ error: 'la traduction a échoué, réessayez dans un instant' });
    return reply.code(200).send({ texte: r.texte, langueSource: r.langueSource, cible: b.cible.trim().toLowerCase() });
  });

  /**
   * Déclarée AVANT `/conversations/:conversationId` : `todo-count` n'est pas un identifiant.
   */
  app.get('/tenants/:tenantId/conversations/todo-count', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.countATraiter) return reply.code(200).send({ count: 0 });
    // ⚠️ `deps.countATraiter(...)` DANS la fermeture, jamais une référence détachée gardée de côté : un store
    // de production y perdrait son `this` (leçon du verrou de campagne, 2026-08-27).
    const count = await compteurs.lire(cleATraiter(tenant), () => deps.countATraiter!(tenant));
    return reply.code(200).send({ count });
  });

  /**
   * Compteur de non-lus, pour la pastille du menu. Route DÉDIÉE et non un champ de la liste : le menu est
   * monté sur toutes les pages et la rafraîchit régulièrement, il ne doit pas rapatrier 100 conversations.
   * Déclarée AVANT `/conversations/:conversationId/...` : `unread-count` n'est pas un identifiant.
   */
  app.get('/tenants/:tenantId/conversations/unread-count', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.countUnread) return reply.code(200).send({ count: 0 });
    const acteur = { userId: req.auth?.userId ?? null, role: req.auth?.role ?? null };
    const count = await compteurs.lire(cleUnread(tenant, acteur.userId), () => deps.countUnread!(tenant, acteur));
    return reply.code(200).send({ count });
  });

  /** Un opérateur vient d'OUVRIR le fil : il est lu. C'est le seul événement qui éteint la pastille. */
  app.post('/tenants/:tenantId/conversations/:conversationId/read', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    if (!deps.markConversationRead) return reply.code(503).send({ error: 'suivi des non-lus indisponible sur cette instance' });
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    await deps.markConversationRead(tenant, conversationId);
    // C'est LE geste que la pastille doit refléter tout de suite : l'écran relit le compteur dans la foulée,
    // et sans cette invalidation il retomberait sur la valeur d'avant pendant toute la durée de vie du cache.
    invaliderCompteurs(tenant);
    return reply.code(200).send({ ok: true });
  });

  /**
   * EFFACER LE CONTENU d'une conversation. Demandé par Julien le 2026-09-02 : « je dois pouvoir supprimer le
   * contenu de la conversation ».
   *
   * 🔴 RÉSERVÉE AUX ADMINISTRATEURS, contrairement au reste de l'inbox. Un opérateur répond aux clients ; il
   * n'efface pas des traces. Et c'est irréversible : il n'existe aucune corbeille pour un fil de messages.
   *
   * 🔴 ELLE FERME LA FENÊTRE DE SERVICE, et l'écran doit l'avoir dit AVANT le clic. `windowOpen` se calcule
   * sur le dernier message ENTRANT : sans messages, il n'y en a plus, donc plus personne ne peut répondre
   * librement à ce contact, ni un opérateur ni un scénario, tant qu'il n'a pas réécrit.
   *
   * La trace part au Journal des actions, SANS le numéro ni le texte : y écrire ce qu'on vient d'effacer
   * annulerait l'effacement, dans une table conçue pour ne jamais être modifiée.
   */
  app.delete('/tenants/:tenantId/conversations/:conversationId/messages', optsAdmin, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    if (!estUuid(conversationId)) return reply.code(404).send({ error: 'conversation inconnue' });
    if (!deps.effacerMessages) return reply.code(503).send({ error: 'effacement indisponible sur cette instance' });
    const effaces = await deps.effacerMessages(tenant, conversationId);
    if (effaces === null) return reply.code(404).send({ error: 'conversation inconnue' });
    await journal(tenant, req, 'conversation.effacee', { kind: 'conversation', id: conversationId }, { messages: effaces });
    // La pastille des non-lus se calcule sur les messages entrants : elle vient de changer.
    invaliderCompteurs(tenant);
    return reply.code(200).send({ effaces });
  });

  app.get('/tenants/:tenantId/conversations/:conversationId/messages', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    // DELTA (lot 5 du programme II) : `afterAt` + `afterId` = le dernier message que l'écran a déjà. Le fil se
    // rafraîchit toutes les 4 s et retéléchargeait 500 messages à chaque tour, par onglet ouvert.
    //
    // ⚠️ LES DEUX ou AUCUN, et `afterId` doit être un uuid : un couple incomplet ou mal formé est IGNORÉ, donc
    // on rend le fil entier. C'est le repli sûr — un client qui se trompe voit trop de messages, jamais trop
    // peu. L'inverse (partir d'un point inventé) escamoterait des bulles sans que personne ne le voie.
    const q = (req.query ?? {}) as { afterAt?: unknown; afterId?: unknown; traduire?: unknown };
    const afterAt = typeof q.afterAt === 'string' && !Number.isNaN(Date.parse(q.afterAt)) ? q.afterAt : undefined;
    const apres = afterAt !== undefined && estUuid(q.afterId) ? { at: afterAt, id: q.afterId } : undefined;
    /**
     * `?traduire=fr` : LA LANGUE DU LECTEUR, qui vient du navigateur et que le serveur ne connait pas.
     *
     * 🔴 ELLE NE PEUT PAS ETRE DECIDEE A L'ARRIVEE DU MESSAGE. A cet instant, personne ne sait dans
     * quelle langue le futur lecteur voudra le lire : deux collegues, l'un francophone et l'autre
     * anglophone, ouvrent le meme fil. C'est donc le navigateur qui demande, comme le fait deja le bot
     * d'aide (`QuestionAide.langue`). Une valeur hors de nos deux langues est IGNOREE, et le fil sort
     * en VO : un parametre mal forme ne doit jamais casser l'ecran le plus utilise du produit.
     */
    const cible = estLangueConsole(q.traduire) ? q.traduire : null;
    const messages = await deps.getMessages(conversationId, apres);
    /**
     * ⚠️ PAS DE PLAFOND DE DEBIT « COUTEUX » SUR CETTE ROUTE, ET C'EST DELIBERE. Le fil se rafraichit
     * toutes les 4 secondes, soit 15 appels par minute : le plafond couteux (10 par minute et par
     * espace) le couperait purement et simplement. Ce qui borne la depense ici est ailleurs : une
     * traduction deja rangee n'est jamais recalculee, le lot est plafonne a 40 messages et a 20 000
     * caracteres, et la facture tombe sur le credit PREPAYE du client, qui est sa propre borne.
     *
     * 🔴 ET UNE QUATRIEME BORNE VIT DANS LE NAVIGATEUR, SANS QUOI LES TROIS AUTRES NE SUFFISENT PAS
     * (revue du 2026-09-13). Ce commentaire a d'abord affirme que « le delta ne ramene que les
     * messages NOUVEAUX, donc zero traduction sur un fil calme ». C'etait FAUX au premier chargement,
     * et faux de la maniere la plus couteuse : le curseur du delta ne se pose qu'a la RECEPTION d'une
     * reponse. Une traduction pouvant durer jusqu'a 20 secondes contre un rafraichissement toutes les
     * 4, aucune requete n'aboutissait, aucun curseur ne se posait, et chaque tour repartait du fil
     * ENTIER pour relancer une traduction complete. Mesure par mutation : QUATRE traductions payees
     * en treize secondes la ou une suffisait, en boucle tant que la conversation reste ouverte.
     *
     * La borne manquante est dans `web/app/inbox/page.tsx` : un tour qui tombe pendant qu'une requete
     * est encore en vol PASSE SON TOUR au lieu de l'annuler (`enCoursRef`). Elle est gardee par
     * `web/e2e/inbox-traduction-polling.spec.ts`, qui COMPTE les requetes dans les deux sens.
     * ⚠️ Retirer cette garde cote ecran remet la dependance en boucle, sans qu'aucun test serveur ne
     * bouge : c'est pour cela qu'elle est nommee ici, a l'endroit ou l'on croit que la borne existe.
     */
    const traduit = cible !== null && deps.traduireFil
      ? await deps.traduireFil(tenant, conversationId, messages, cible)
      : null;
    return reply.code(200).send({
      waId: ctx.waId,
      windowOpen: ctx.windowOpen,
      lastInboundAt: ctx.lastInboundAt,
      /**
       * La langue APPRISE du contact, `null` tant qu'on n'a rien appris. C'est elle qui permet au
       * bouton de traduction sortante de NOMMER sa cible au lieu de dire « Traduire » tout court.
       */
      langueContact: ctx.langueContact ?? null,
      /**
       * ⚠️ RENDU SEULEMENT QUAND UNE TRADUCTION A ETE DEMANDEE, et c'est ce qui garde le rayon de
       * souffle a zero : sans `?traduire`, la reponse est mot pour mot celle d'avant ce lot.
       * `true` = cet espace n'a pas de cle de modele, donc pas de credit. Ce n'est pas une panne, et
       * c'est un 200 : Cloudflare remplacerait de toute facon le corps d'un 5xx par sa page.
       */
      ...(cible !== null ? { traductionIndisponible: traduit === null || traduit.indisponible } : {}),
      /**
       * 🔴 POURQUOI ELLE EST INDISPONIBLE, PARCE QUE LES DEUX CAUSES N'APPELLENT PAS LE MÊME GESTE
       * (revue du 2026-09-13). Le drapeau ci-dessus vaut vrai dans DEUX situations : cette instance
       * n'a pas de modèle de traduction configuré (`TRADUCTION_MODELE` vide, donc `traduireFil`
       * absent), ou cet espace n'a pas de clé Gateway, c'est-à-dire pas de crédit.
       *
       * L'écran affirmait « le crédit de cet espace est épuisé, un administrateur peut le recharger »
       * dans les deux cas. C'est FAUX dans le premier, et c'était l'état exact de la production au
       * moment où ce lot a été écrit : on envoyait un administrateur recharger un crédit sans rapport,
       * en lui cachant la seule cause réelle. Une phrase fausse coûte plus cher qu'aucune phrase,
       * parce qu'elle donne une piste et qu'on la suit.
       */
      ...(cible !== null && (traduit === null || traduit.indisponible)
        ? { traductionCause: traduit === null ? 'instance' : 'credit' }
        : {}),
      // Qui détient le fil : sans cette information, l'opérateur voit le scénario se taire sans comprendre
      // pourquoi et ne sait pas s'il doit rendre la main. Défaut `app_workflow` quand le dep est absent,
      // qui est l'état d'une conversation dont personne n'a pris le contrôle.
      controlOwner: deps.getControlOwner ? await deps.getControlOwner(tenant, ctx.waId) : 'app_workflow',
      // Surcharge de reprise de CE fil (C.4) : null = suit le défaut du tenant. L'inbox l'affiche pour que
      // l'opérateur sache si, à la reprise, ce fil précis restera à l'humain ou repartira au scénario.
      messages: traduit ? traduit.messages : messages,
    });
  });

  /**
   * Cet acteur a-t-il le droit d'écrire dans cette conversation ? Rend un message d'erreur, ou `null` si
   * c'est permis.
   *
   * 🔴 Appelé par CHAQUE route qui écrit vers le client. C'est la seule barrière réelle : l'écran grise un
   * bouton, mais rien n'empêche d'appeler l'API directement. Sans dépendance `getAssignee` câblée, tout est
   * permis, c'est-à-dire le comportement d'avant l'affectation.
   */
  async function refusAffectation(req: FastifyRequest, tenant: string, conversationId: string): Promise<string | null> {
    if (!deps.getAssignee) return null;
    const assignee = await deps.getAssignee(tenant, conversationId);
    // `undefined` (conversation inconnue) est laissé aux gardes existantes des routes, qui rendent un 404
    // plus précis. On ne se prononce que sur une conversation qui existe.
    if (assignee === undefined) return null;
    if (peutEcrire({ userId: req.auth?.userId ?? null, role: req.auth?.role ?? null }, assignee)) return null;
    return 'Cette conversation est affectée à un autre membre de l’équipe.';
  }

  /**
   * LES MEMBRES QU'ON PEUT AFFECTER, pour le sélecteur de l'encadrement (2026-09-19).
   *
   * 🔴 LE SÉLECTEUR LISAIT `GET /users`, RÉSERVÉ AUX ADMINS : chez un MANAGER, la liste revenait vide et il ne
   * pouvait affecter à personne, alors que la route d'affectation l'y autorise. Cette route-ci suit la MÊME
   * règle que l'affectation (`peutAffecter`), donc voir la liste et pouvoir s'en servir vont ensemble.
   *
   * ⚠️ Déclarée sous `/conversations/membres-affectables` : un segment FIXE, que Fastify sert avant le
   * paramètre `:conversationId`, comme `counts`.
   */
  app.get('/tenants/:tenantId/conversations/membres-affectables', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!peutAffecter({ userId: req.auth?.userId ?? null, role: req.auth?.role ?? null })) {
      return reply.code(403).send({ error: 'réservé aux managers et aux admins' });
    }
    return reply.code(200).send({ membres: deps.membresPourAffectation ? await deps.membresPourAffectation(tenant) : [] });
  });

  /**
   * PRENDRE une conversation du pot commun : se l'affecter à SOI (migration 0160, arbitrage de Julien du
   * 2026-09-19 : « un agent ne peut pas réaffecter [...] en revanche il peut prendre parmi celles du pot
   * commun »).
   *
   * 🔴 L'AFFECTATAIRE EST PRIS DANS LA SESSION, JAMAIS DANS LE CORPS : c'est ce qui fait de cette route une
   * PRISE et pas une affectation. Un identifiant fourni par l'appelant la transformerait en « donner à un
   * collègue », précisément ce que le réglage n'autorise pas.
   *
   * ⚠️ 409 QUAND UN COLLÈGUE L'A PRISE ENTRE-TEMPS : l'écriture est conditionnelle (`assigned_to is null`
   * dans le `where`), donc deux clics simultanés ne se volent pas la conversation. Le perdant l'apprend,
   * avec un message qu'il peut lire (4xx, jamais 5xx : Cloudflare remplacerait le corps).
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/assignee/moi', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.prendreSiLibre || !deps.getAssignee) return reply.code(503).send({ error: 'prise de conversation indisponible' });
    const { conversationId } = req.params as { conversationId: string };
    if (!estUuid(conversationId)) return reply.code(404).send({ error: 'conversation inconnue' });
    const acteur = { userId: req.auth?.userId ?? null, role: req.auth?.role ?? null };
    const actuel = await deps.getAssignee(tenant, conversationId);
    if (actuel === undefined) return reply.code(404).send({ error: 'conversation inconnue' });
    if (actuel !== null) return reply.code(409).send({ error: 'Un collègue s’occupe déjà de cette conversation.', code: 'deja_prise' });
    const reglage = await reglagePrise(tenant, acteur);
    // Illisible : on refuse, mais sans affirmer que l'espace l'interdit, ce qui serait peut-être faux.
    // 409 et pas 5xx : Cloudflare remplacerait le corps, et l'agent n'aurait rien à lire.
    if (reglage === null) {
      return reply.code(409).send({ error: 'Le réglage de votre espace est momentanément illisible, réessayez dans un instant.', code: 'reglage_illisible' });
    }
    if (!peutPrendre(acteur, null, reglage)) {
      return reply.code(403).send({ error: 'Votre espace ne permet pas aux agents de prendre une conversation. Un manager peut vous l’affecter.' });
    }
    // `acteur.userId` est non nul ici : `peutPrendre` l'exige.
    if (!(await deps.prendreSiLibre(tenant, conversationId, acteur.userId!))) {
      // Prise entre notre lecture et notre écriture : un collègue a été plus rapide.
      return reply.code(409).send({ error: 'Un collègue s’occupe déjà de cette conversation.', code: 'deja_prise' });
    }
    invaliderCompteurs(tenant); // « Non affectées » et la charge de l'agent viennent de changer.
    return reply.code(200).send({ conversationId, assignee: acteur.userId });
  });

  /**
   * Affecter une conversation à un membre, ou la libérer. Réservé aux managers et aux admins : c'est la
   * première prérogative réelle du rôle `manager`, qui n'accordait rien depuis sa création.
   */
  app.patch('/tenants/:tenantId/conversations/:conversationId/assignee', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.setAssignee) return reply.code(503).send({ error: 'affectation indisponible' });
    if (!peutAffecter({ userId: req.auth?.userId ?? null, role: req.auth?.role ?? null })) {
      return reply.code(403).send({ error: 'réservé aux managers et aux admins' });
    }
    const { conversationId } = req.params as { conversationId: string };
    const brut = (req.body as { assignee?: unknown } | null)?.assignee;
    // `null` explicite = libérer. Toute autre forme qu'une chaîne non vide est refusée : une valeur bancale
    // ne doit pas se traduire par une libération silencieuse, qui rouvrirait la conversation à tous.
    if (brut !== null && !nonEmpty(brut)) return reply.code(400).send({ error: 'assignee requis (identifiant de membre, ou null pour libérer)' });
    const assignee = brut === null ? null : (brut as string);
    const ok = await deps.setAssignee(tenant, conversationId, assignee, req.auth?.userId ?? null);
    if (!ok) return reply.code(404).send({ error: 'conversation inconnue, ou membre étranger à cet espace' });
    return reply.code(200).send({ conversationId, assignee });
  });

  app.post('/tenants/:tenantId/conversations/:conversationId/reply', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const corps = (req.body ?? {}) as { text?: unknown; redactionOrigine?: unknown };
    const text = corps.text;
    if (!nonEmpty(text)) return reply.code(400).send({ error: 'text requis' });
    /**
     * CE QUE L'OPÉRATEUR A ÉCRIT AVANT DE FAIRE TRADUIRE (migration 0137).
     *
     * 🔴 LE SENS S'INVERSE ICI, et c'est le piège du lot : `text` est ce qui PART, donc le texte
     * traduit, parce que c'est ce que le client recevra et que notre trace doit y correspondre le
     * jour d'un litige. Ce champ-ci garde l'original, sans quoi l'opérateur ne peut plus se relire.
     * Ne garder qu'un des deux est faux dans les deux sens.
     *
     * ⚠️ REFUSÉ EN 400 plutôt qu'ignoré quand il est mal formé, et l'ordre compte : rien n'est encore
     * parti, donc refuser ne coûte qu'un nouvel essai. L'ignorer ferait partir le message en perdant
     * sa trace, c'est-à-dire le défaut exact que cette colonne existe pour empêcher.
     */
    const brutOrigine = corps.redactionOrigine;
    if (brutOrigine !== undefined && brutOrigine !== null
      && (!nonEmpty(brutOrigine) || brutOrigine.length > TEXTE_MAX_CARACTERES)) {
      return reply.code(400).send({ error: 'redactionOrigine invalide' });
    }
    const redactionOrigine = nonEmpty(brutOrigine) ? brutOrigine.trim() : null;

    // L'affectation est une règle de la CONSOLE (qui, parmi les opérateurs, a la charge du fil) : elle est
    // vérifiée ici et pas dans `repondreDansLaFenetre`, qui sert aussi un appelant sans opérateur.
    const refus = await refusAffectation(req, tenant, conversationId);
    if (refus) return reply.code(403).send({ error: refus, code: 'assigned_to_other' });

    // « humain » : cette route n'est atteignable qu'avec un JWT de console, donc c'est toujours un opérateur
    // qui écrit. L'origine est POSÉE et non déduite, cf. le commentaire de `repondreDansLaFenetre`.
    const res = await repondreDansLaFenetre(deps, tenant, conversationId, text, req.auth?.userId ?? null, 'humain', redactionOrigine);
    if ('refus' in res) {
      if (res.refus.motif === 'conversation_inconnue') return reply.code(404).send({ error: 'conversation inconnue' });
      if (res.refus.motif === 'aucun_numero') return reply.code(400).send({ error: 'aucun numéro pour ce tenant' });
      /**
       * ⚠️ INATTEIGNABLE PAR CONSTRUCTION depuis cette route (le refus d'opt-out ne vise que l'origine
       * machine), et écrit quand même : ce qui suit est un REPLI qui suppose « fenêtre fermée ». Sans
       * branche explicite, tout motif futur sortirait sous ce message-là, c'est-à-dire une raison fausse
       * affichée à un opérateur qui chercherait un template approuvé pour rien.
       */
      if (res.refus.motif === 'contact_desabonne') {
        return reply.code(409).send({ error: 'ce contact a demandé à ne plus recevoir de messages', code: 'contact_desabonne' });
      }
      // Hors fenêtre 24 h : Meta refuse le texte libre. On bloque et on dit les DEUX chemins qui restent.
      // Le message ne parlait que du template, alors que le même écran propose le RCS juste en dessous : un
      // opérateur croyait devoir faire approuver un template alors qu'il avait un chemin immédiat.
      // Le code `window_closed` ne bouge pas, l'écran s'en sert.
      return reply.code(422).send({ error: 'Fenêtre de 24 h fermée : envoie un template, ou un message RCS si le contact y est joignable.', code: 'window_closed' });
    }
    invaliderCompteurs(tenant); // le fil passe cote humain : il entre dans « A traiter ».
    return reply.code(200).send({ messageId: res.messageId });
  });

  /**
   * Envoi d'un message RCS depuis une conversation.
   *
   * 🔴 Volontairement SANS garde de fenêtre 24 h, à la différence de `reply` : cette fenêtre est une règle de
   * WhatsApp, pas une règle du monde. Le RCS n'en a pas, et c'est précisément quand la fenêtre WhatsApp est
   * fermée qu'il devient le moyen de reprendre contact sans template à faire approuver.
   *
   * Le message vient de la BIBLIOTHÈQUE (comme un template vient de Meta) : un opérateur d'inbox n'a pas à
   * composer une carte, un visuel et des boutons dans une barre de réponse. Ses variables sont résolues sur la
   * fiche du contact, exactement comme dans une campagne.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/send-rcs', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    // Deux formes, EXCLUSIVES : un message de la bibliothèque, ou une réponse écrite à la main. La seconde
    // existe parce qu'un contact joignable SEULEMENT en RCS n'était atteignable qu'à travers la bibliothèque :
    // l'opérateur ne pouvait pas répondre une phrase sur le canal où le client venait de lui parler.
    const corps = (req.body ?? {}) as { rcsMessageId?: unknown; text?: unknown };
    const aId = nonEmpty(corps.rcsMessageId);
    const aTexte = nonEmpty(corps.text);
    if (aId === aTexte) return reply.code(400).send({ error: 'rcsMessageId OU text requis, pas les deux' });
    // Même borne que le schéma RCS : refuser ici plutôt que d'aller se faire refuser par le fournisseur.
    if (aTexte && (corps.text as string).trim().length > RCS_TEXTE_MAX) {
      return reply.code(400).send({ error: `texte trop long (${RCS_TEXTE_MAX} caractères maximum)` });
    }
    const contenu = aId ? { rcsMessageId: (corps.rcsMessageId as string).trim() } : { text: (corps.text as string).trim() };

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    const refusAff = await refusAffectation(req, tenant, conversationId);
    if (refusAff) return reply.code(403).send({ error: refusAff, code: 'assigned_to_other' });
    if (!deps.sendRcsFromInbox) return reply.code(422).send({ error: 'canal RCS non disponible' });

    const issue = await deps.sendRcsFromInbox(tenant, ctx.waId, contenu);
    // 422 et non 5xx : c'est une situation à corriger par l'opérateur (canal éteint, contact désabonné), et
    // Cloudflare remplacerait le corps d'un 5xx par sa page d'erreur, donc la raison n'arriverait jamais.
    if ('refus' in issue) return reply.code(422).send({ error: issue.refus });

    // L'opérateur prend le fil, comme sur une réponse texte. Best-effort et APRÈS l'envoi réussi : un échec
    // d'état ne doit pas faire croire à un message perdu.
    await deps.takeControl?.(tenant, ctx.waId).catch(() => {});
    invaliderCompteurs(tenant); // le fil passe cote humain : il entre dans « A traiter ».
    await deps.recordOutbound(conversationId, issue.apercu, issue.messageId, 'humain', 'rcs', null, null, req.auth?.userId ?? null, 'rcs');
    return reply.code(200).send({ messageId: issue.messageId });
  });

  /**
   * Variables d'un template, résolues pour CE contact.
   *
   * 🔴 Pourquoi cette route existe. L'écran d'envoi de l'Inbox demandait les variables une par une, en texte
   * libre, sans dire ce qu'elles attendaient : l'opérateur devait se souvenir que `{{1}}` était le prénom et
   * le retaper, alors que la fiche du contact le porte et que le template dit déjà quel champ l'alimente
   * (`template_param_hints`, posés à la création). On rend donc les valeurs DÉJÀ remplies, avec le libellé du
   * champ à côté, et elles restent modifiables.
   */
  app.get('/tenants/:tenantId/conversations/:conversationId/template-params', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const q = req.query as { name?: string; language?: string; count?: string };
    if (!nonEmpty(q.name) || !nonEmpty(q.language)) return reply.code(400).send({ error: 'name et language requis' });
    const count = Number(q.count ?? 0);
    if (!Number.isInteger(count) || count < 0 || count > 20) return reply.code(400).send({ error: 'count invalide' });

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    if (!deps.resolveTemplateParams || count === 0) return reply.code(200).send({ values: [], labels: [] });

    const r = await deps.resolveTemplateParams(tenant, ctx.waId, { name: q.name as string, language: q.language as string, count });
    return reply.code(200).send(r);
  });

  // Envoi d'un template dans une conversation (le seul moyen de ré-engager hors fenêtre 24 h).
  app.post('/tenants/:tenantId/conversations/:conversationId/send-template', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
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

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    const refusTpl = await refusAffectation(req, tenant, conversationId);
    if (refusTpl) return reply.code(403).send({ error: refusTpl, code: 'assigned_to_other' });
    const phoneNumberId = await deps.getTenantPhoneNumberId(tenant);
    if (!phoneNumberId) return reply.code(400).send({ error: 'aucun numéro pour ce tenant' });

    /**
     * 🔴 UN CONTACT DÉSABONNÉ NE REÇOIT PLUS DE MODÈLE MARKETING, MÊME ENVOYÉ À LA MAIN (décision de Julien
     * du 2026-09-13). Un modèle n'est pas une réponse : il ROUVRE une conversation fermée, c'est-à-dire
     * exactement le geste dont la personne a demandé qu'il cesse. Le SERVICE passe (livraison, rendez-vous,
     * compte), parce qu'il répond à un engagement pris et non à une sollicitation.
     *
     * 🔴 LA CATÉGORIE EST LUE CHEZ META, PAS DANS LA REQUÊTE, et un modèle dont on n'a PAS pu lire la
     * catégorie est REFUSÉ. Échouer fermé est la seule position tenable ici : la lire dans le corps
     * laisserait se déclarer « utility » pour passer, et l'accepter en cas de doute reviendrait au même
     * résultat par une autre porte.
     *
     * ⚠️ RIEN DE TOUT CECI N'EST PAYÉ PAR LE CAS ORDINAIRE : la lecture chez Meta n'a lieu que si le
     * contact est effectivement désabonné, ce qui est rare.
     */
    if (await deps.estDesabonne(tenant, ctx.waId)) {
      const categorie = deps.categorieDuModele
        ? await deps.categorieDuModele(tenant, b.templateName, b.language).catch(() => null)
        : null;
      if (categorie !== 'utility') {
        return reply.code(409).send({
          error: categorie === null
            ? 'ce contact s’est désabonné, et la catégorie de ce modèle n’a pas pu être vérifiée : l’envoi est refusé par prudence. Vous pouvez encore lui répondre à la main si la conversation est ouverte.'
            : 'ce contact s’est désabonné : seuls les modèles de catégorie « Service » peuvent encore lui être envoyés. Vous pouvez lui répondre à la main si la conversation est ouverte.',
          code: 'contact_desabonne',
        });
      }
    }

    // Carousel : ses cartes ne sont pas dans la requête, elles se relisent chez Meta, et leurs visuels doivent
    // être re-téléversés. Un refus (carte sans visuel exploitable, variable de carte) sort en 422 AVANT
    // l'envoi : mieux vaut le dire que laisser Meta accepter un message qu'il ne livrera pas.
    let carousel: { cards: OutboundCarouselCard[] } | undefined;
    if (deps.prepareCarousel) {
      const prep = await deps.prepareCarousel(tenant, b.templateName, b.language);
      if (prep && 'refus' in prep) return reply.code(422).send({ error: prep.refus });
      if (prep) carousel = prep;
    }

    const messageId = await deps.sendTemplateMessage(tenant, phoneNumberId, ctx.waId, {
      name: b.templateName,
      language: b.language,
      bodyParams,
      ...(headerMediaUrl ? { headerMediaUrl } : {}),
      ...(headerFormat ? { headerFormat } : {}),
      ...(carousel ? { carousel } : {}),
    });
    // Même prise de main que sur la réponse texte : un template envoyé à la main est un acte d'opérateur.
    await deps.takeControl?.(tenant, ctx.waId).catch(() => {});
    invaliderCompteurs(tenant); // le fil passe cote humain : il entre dans « A traiter ».
    await deps.recordOutbound(conversationId, `[template] ${b.templateName}`, messageId, 'humain', 'template', templateCategory, b.templateName, req.auth?.userId ?? null);
    return reply.code(200).send({ messageId });
  });

  /**
   * Lance un SCÉNARIO sur cette conversation. L'opérateur clique, donc il doit savoir TOUT DE SUITE si c'est
   * parti et sinon pourquoi : la raison est rendue telle quelle en 422, jamais un 200 muet.
   *
   * C'est l'état RÉEL de la fenêtre au moment du clic qui décide, pas ce que l'écran croyait afficher : la
   * liste proposée est filtrée côté navigateur, mais un fil peut sortir de la fenêtre entre l'affichage et
   * le clic. Le serveur reste le juge.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/workflow', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const workflowId = (req.body as { workflowId?: unknown } | null)?.workflowId;
    if (!nonEmpty(workflowId)) return reply.code(400).send({ error: 'workflowId requis' });
    if (!deps.startWorkflow) return reply.code(503).send({ error: 'lancement de scénario indisponible sur cette instance' });

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    // Lancer un scénario ÉCRIT au client : même règle que répondre à la main.
    const refusWf = await refusAffectation(req, tenant, conversationId);
    if (refusWf) return reply.code(403).send({ error: refusWf, code: 'assigned_to_other' });

    const issue = await deps.startWorkflow(tenant, workflowId, ctx.waId, ctx.windowOpen);
    if (issue === null) return reply.code(404).send({ error: 'scénario inconnu' });
    // Une CHAÎNE porte la raison exacte du refus (ouverture par un message de session hors fenêtre, scénario
    // vide, bloc de départ supprimé, template introuvable chez Meta...). On l'affiche telle quelle.
    if (typeof issue === 'string') return reply.code(422).send({ error: issue });
    return reply.code(200).send({ ok: true });
  });

  /**
   * L'opérateur rend la main : le scénario (ou, demain, l'agent de Meta) reprend la conversation.
   *
   * Sans cette route, le seul chemin de retour serait le garde-fou d'inactivité : un opérateur qui règle
   * une question en deux minutes devrait attendre le délai configuré avant que l'automatisme reparte.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/release', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    if (!deps.releaseControl) return reply.code(503).send({ error: 'reprise indisponible sur cette instance' });
    /**
     * 🔴 UN ÉCHEC CHEZ META SORT EN 4xx, PAS EN 500. Depuis le 2026-09-10, rendre la main APPELLE Meta
     * (`thread_control`, action `release`) avant d'écrire notre état. L'appel peut échouer (jeton, réseau,
     * numéro non éligible) et l'opérateur DOIT le savoir : Cloudflare remplace le corps de toute réponse
     * 5xx par sa page d'erreur, donc un message d'erreur en 500 n'arriverait jamais à l'écran.
     *
     * ⚠️ Et surtout, notre état local n'a PAS bougé dans ce cas : `releaseControl` écrit après Meta, jamais
     * avant. L'écran continue donc d'annoncer que l'opérateur tient le fil, ce qui est la vérité.
     */
    let owner: 'app_workflow' | 'mba';
    try {
      owner = await deps.releaseControl(tenant, ctx.waId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`release: Meta a refusé de reprendre le fil (${tenant}/${ctx.waId}):`, err instanceof Error ? err.message : err);
      return reply.code(409).send({ error: 'Meta n’a pas repris la conversation. Elle reste de votre côté, réessayez dans un instant.' });
    }
    invaliderCompteurs(tenant); // le fil repart en automatique : il sort de « À traiter ».
    return reply.code(200).send({ controlOwner: owner });
  });

}
