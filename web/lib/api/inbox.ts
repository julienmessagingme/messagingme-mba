'use client';

/**
 * Le fil de conversation : liste, messages, envoi, prise de main, moderation.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request, requestBlob } from '../http';

// --- Inbox ---

/**
 * Qui détient la conversation, et donc qui répond au client.
 * `app_workflow` = le scénario, en automatique. `app_human` = un opérateur s'en occupe, le scénario se
 * tait. `mba` = l'agent de Meta répond (n'arrive que si MBA est activé sur le numéro).
 */
export type ControlOwner = 'app_workflow' | 'app_human' | 'mba';

/** Destination d'un fil après une prise en main opérateur (C.4). `resume` = rendu au scénario ; `inbox` =
 *  reste à l'humain. Réglé par tenant (défaut) et/ou par conversation (surcharge). Miroir du serveur. */

export interface Conversation {
  id: string;
  waId: string;
  profileName: string | null;
  lastPreview: string | null;
  lastMessageAt: string;
  /**
   * 🔴 LE POINT DE REPRISE DE LA PAGINATION, OPAQUE. À renvoyer TEL QUEL dans `before.at`.
   *
   * `lastMessageAt` est tronqué à la milliseconde par le `Date` du serveur alors que la base compte en
   * microsecondes : s'en servir comme curseur faisait SAUTER les conversations dont la dernière activité
   * tombe dans la même milliseconde que le point d'arrêt. Absent : on retombe sur `lastMessageAt`, c'est-à-dire
   * le comportement d'avant, jamais pire.
   */
  curseur?: string;
  controlOwner: ControlOwner;
  /** Un message ENTRANT est arrivé depuis la dernière ouverture du fil par un opérateur. Optionnel : une
   *  instance antérieure à la migration 0055 ne le rend pas, et l'inbox se comporte alors comme avant. */
  unread?: boolean;
  /**
   * Membre à qui la conversation est confiée. `null` ou absent = personne, donc ouverte à tous.
   *
   * ⚠️ Sans rapport avec `controlOwner` : celui-ci dit QU'EST-CE QUI parle (scénario, humain, agent Meta),
   * celui-là QUEL HUMAIN s'en occupe. Une conversation peut être affectée ET tenue par le scénario.
   */
  assignedTo?: string | null;
  /** Nom du membre affecté, pour l'afficher sans un second appel. */
  assignedToName?: string | null;
  /**
   * Cette conversation m'est-elle affectée ? Calculé par le SERVEUR, qui seul connaît l'identifiant de
   * l'appelant : la session du navigateur ne porte que l'email et le rôle.
   */
  assignedToMe?: boolean;
  /**
   * La conversation a-t-elle été signalée À LA MAIN ?
   *
   * ⚠️ DISTINCT du dossier « Signalé », qui montre l'union de ce drapeau et du constat de l'analyse. L'écran
   * en a besoin pour savoir quoi proposer : sur une conversation signalée par le MODÈLE, un « ne plus
   * signaler » n'aurait aucun effet visible. Absent (backend antérieur) = lu comme `false`.
   */
  signaleeMain?: boolean;
}
export interface InboxMessage {
  id: string;
  direction: 'in' | 'out';
  type: string | null;
  body: string | null;
  buttonPayload: string | null;
  createdAt: string;
  /**
   * 🔴 LE POINT DE REPRISE DU DELTA, OPAQUE. À renvoyer TEL QUEL dans `apres.at`, jamais à reconstruire.
   *
   * `createdAt` a traversé un `Date` JavaScript côté serveur et n'a donc que la milliseconde, alors que la
   * base stocke la microseconde. S'en servir comme curseur faisait repasser le dernier message à chaque tour
   * de rafraîchissement : il se ré-ajoutait au fil toutes les 4 secondes et l'écran défilait tout seul.
   * Absent : ne pas poser de curseur du tout (le serveur rend alors le fil entier, repli sûr).
   */
  curseur?: string;
  /** Auteur d'un message sortant (pastille inbox) ; null/absent = pas d'auteur (legacy / réponse auto). */
  senderName?: string | null;
  /** Canal de CETTE bulle : le fil est unique par contact, c'est le message qui porte le tuyau emprunté.
   *  Absent (message d'avant la migration 0056) = WhatsApp. */
  channel?: 'whatsapp' | 'rcs';
  /** Ce message porte un fichier chez Meta (migration 0125). Le serveur ne rend PAS son identifiant :
   *  celui-ci ne sert qu'a aller chercher les octets, et l'ecran n'en ferait rien. */
  aMedia?: boolean;
  /** La transcription du vocal, quand un operateur l'a demandee. A afficher MARQUEE comme telle : c'est la
   *  lecture d'un modele, pas ce que le client a ecrit. */
  transcription?: string | null;
  /** La langue dans laquelle le vocal a ete DIT (migration 0137). Sert a ne pas le traduire pour rien. */
  transcriptionLangue?: string | null;
  /** NOTRE lecture d'un ENTRANT, dans la langue du lecteur (migration 0137). A COTE de `body`, jamais a sa place. */
  traduction?: string | null;
  traductionLangue?: string | null;
  /**
   * Ce que l'OPERATEUR a ecrit avant de faire traduire, sur un SORTANT (migration 0137).
   *
   * 🔴 LE SENS S'INVERSE ICI : sur un sortant, `body` porte ce qui est PARTI (le texte traduit, celui
   * que le client a recu), et ce champ porte l'original. L'ecran affiche l'original, sinon l'operateur
   * est aveugle a sa propre conversation.
   */
  redactionOrigine?: string | null;
  /**
   * LES TROIS ETATS, rendus seulement quand le fil a ete demande avec `traduire`.
   *
   * `affiche` est le texte de la bulle, quel que soit l'etat. `traduit` dit que c'est une traduction.
   * `traductionEchouee` dit qu'elle a ete TENTEE et n'est pas revenue : au-dela du plafond, rien n'a
   * ete tente et les deux drapeaux sont faux. Les confondre ferait annoncer une panne qui n'existe pas.
   */
  affiche?: string;
  traduit?: boolean;
  traductionEchouee?: boolean;
}
/**
 * Une page de conversations, de la plus récente à la plus ancienne.
 *
 * Filtre et pagination sont faits par le SERVEUR : les appliquer en mémoire ne voyait que les conversations
 * déjà chargées, donc au-delà d'une page le filtre ignorait le reste sans rien signaler.
 *
 * Page suivante : passer `before` avec le dernier élément reçu. Une page pleine (autant d'éléments que
 * `limit`) signifie qu'il peut y en avoir d'autres.
 */
export function listConversations(
  tenantId: string,
  opts: { limit?: number; before?: { at: string; id: string }; aTraiter?: boolean; affectee?: string | 'aucune'; signalees?: boolean; archivees?: boolean } = {},
): Promise<{ conversations: Conversation[] }> {
  const p = new URLSearchParams();
  if (opts.limit !== undefined) p.set('limit', String(opts.limit));
  if (opts.aTraiter) p.set('aTraiter', '1');
  if (opts.affectee !== undefined) p.set('affectee', opts.affectee);
  if (opts.signalees) p.set('signalees', '1');
  // Le dossier ARCHIVÉ. Absent = les dossiers ordinaires, qui excluent les archivées.
  if (opts.archivees) p.set('archivees', '1');
  // Le curseur part ENTIER ou pas du tout : le serveur ignore une moitié, autant ne pas l'envoyer.
  if (opts.before) { p.set('beforeAt', opts.before.at); p.set('beforeId', opts.before.id); }
  const qs = p.toString();
  return request<{ conversations: Conversation[] }>(`/tenants/${tenantId}/conversations${qs ? `?${qs}` : ''}`);
}
/** Nombre de conversations non lues (pastille du menu). Route dédiée : le menu ne rapatrie pas la liste. */
export function countUnreadConversations(tenantId: string): Promise<{ count: number }> {
  return request<{ count: number }>(`/tenants/${tenantId}/conversations/unread-count`);
}
/**
 * Affecte une conversation à un membre, ou la libère avec `null`.
 *
 * Réservé aux managers et aux admins. Le refus d'écrire dans une conversation affectée est appliqué par le
 * SERVEUR : l'écran ne fait que griser, il ne protège rien.
 */
export function setConversationAssignee(tenantId: string, conversationId: string, assignee: string | null): Promise<{ conversationId: string; assignee: string | null }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/assignee`, { method: 'PATCH', body: JSON.stringify({ assignee }) });
}
/**
 * MODÉRATION : bloque ou débloque un contact.
 *
 * Bloqué = plus aucun envoi vers lui (campagnes, scénarios, automations) ET sa conversation disparaît de
 * l'inbox. Ses messages restent enregistrés, et il se retrouve dans les paramètres pour être débloqué.
 */
export function setContactBlocked(tenantId: string, contactId: string, blocked: boolean): Promise<{ contactId: string; blocked: boolean }> {
  return request(`/tenants/${tenantId}/contacts/${contactId}/blocked`, { method: 'PATCH', body: JSON.stringify({ blocked }) });
}
export interface BlockedContact { id: string; profileName: string | null; phoneE164: string | null; blockedAt: string }
/** Contacts bloqués : la SEULE porte de sortie d'un blocage, puisqu'ils sont invisibles partout ailleurs. */
export function listBlockedContacts(tenantId: string): Promise<{ contacts: BlockedContact[] }> {
  return request(`/tenants/${tenantId}/contacts/blocked`);
}
/**
 * Les chiffres du menu de dossiers, en UNE lecture.
 *
 * ⚠️ Lus ENSEMBLE parce qu'ils sont AFFICHÉS ensemble : six routes, ce seraient six instants différents, et
 * un « Tout (12) » au-dessus d'un « À traiter (13) » se remarque tout de suite.
 */
export interface CompteursInbox {
  tout: number;
  aTraiter: number;
  signalees: number;
  archivees: number;
  nonAffectees: number;
  parMembre: Array<{ userId: string; nom: string; n: number }>;
}

/** Les compteurs du menu. Une réponse mal formée rend des zéros : un menu sans chiffres reste un menu. */
export async function countConversationsParDossier(tenantId: string): Promise<CompteursInbox> {
  const r = await request<Partial<CompteursInbox>>(`/tenants/${tenantId}/conversations/counts`);
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    tout: n(r?.tout), aTraiter: n(r?.aTraiter), signalees: n(r?.signalees),
    archivees: n(r?.archivees), nonAffectees: n(r?.nonAffectees),
    // Vérifié et non casté : ce tableau vient du réseau, et l'écran fait `.map` dessus pendant le rendu.
    parMembre: Array.isArray(r?.parMembre) ? r.parMembre : [],
  };
}

/** Range une conversation dans Archivé, ou l'en sort. */
export function archiverConversation(tenantId: string, conversationId: string, archive: boolean): Promise<{ archived: boolean }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' });
}

/**
 * Lance un SCÉNARIO sur cette conversation. Le serveur tranche sur l'état RÉEL de la fenêtre de 24 h et
 * renvoie 422 avec la raison si le scénario ne peut pas partir (la liste affichée est filtrée, mais un fil
 * peut sortir de la fenêtre entre l'affichage et le clic).
 */
export function startWorkflowInConversation(tenantId: string, conversationId: string, workflowId: string): Promise<{ ok: boolean }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/workflow`, { method: 'POST', body: JSON.stringify({ workflowId }) });
}
/** Un opérateur vient d'ouvrir le fil : il est lu. Seul événement qui éteint la pastille. */
export function markConversationRead(tenantId: string, conversationId: string): Promise<{ ok: boolean }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/read`, { method: 'POST' });
}
export interface ConversationThread {
  waId: string;
  windowOpen: boolean;
  lastInboundAt: string | null;
  controlOwner: ControlOwner;
  /**
   * La langue APPRISE du contact (migration 0137), `null` tant qu'on n'a rien appris.
   *
   * 🔴 `null` N'EST PAS « francais » : c'est elle que le bouton de traduction sortante lit pour NOMMER
   * sa cible, et supposer une langue ferait promettre « Traduire en espagnol » a un anglophone.
   */
  langueContact?: string | null;
  /** `true` = la traduction n'a pas pu se faire. Rendu seulement si `traduire` a ete demande. */
  traductionIndisponible?: boolean;
  /**
   * POURQUOI, et les deux causes n'appellent pas le meme geste (revue du 2026-09-13).
   *
   * `instance` = aucun modele de traduction n'est configure sur le serveur (`TRADUCTION_MODELE` vide) ;
   * personne, cote client, ne peut rien y faire. `credit` = cet espace n'a pas de cle de modele, et la
   * recharger le regle.
   *
   * ⚠️ L'ecran a d'abord affirme « le credit est epuise » dans LES DEUX cas. C'etait faux dans le
   * premier, qui etait justement l'etat de la production : on envoyait un administrateur recharger un
   * credit sans rapport. Absente = on ne sait pas, et l'ecran reste prudent.
   */
  traductionCause?: 'instance' | 'credit';
  /** Surcharge de reprise de CE fil (C.4). null = suit le défaut du tenant. */
  messages: InboxMessage[];
}
/**
 * Le fil d'une conversation. `apres` ne demande QUE les messages postérieurs au couple donné : le fil ouvert
 * se rafraîchit toutes les 4 secondes, et il retéléchargeait jusqu'à 500 messages à chaque tour, par onglet.
 *
 * ⚠️ Le point de reprise est le COUPLE `(curseur, id)`, jamais l'identifiant seul : deux messages peuvent
 * porter le même horodatage, et l'un des deux se perdrait à chaque poll. Un couple incomplet ou mal formé est
 * ignoré par le serveur, qui rend alors le fil ENTIER : le repli est de voir trop de messages, jamais trop peu.
 *
 * 🔴 `apres.at` prend `message.curseur`, PAS `message.createdAt`. Voir `InboxMessage.curseur` : le second est
 * tronqué à la milliseconde et faisait revenir le dernier message à chaque tour.
 *
 * `signal` : l'écran annule sa requête en cours quand on change de conversation ou qu'on quitte l'inbox.
 */
export function getConversationMessages(
  tenantId: string,
  conversationId: string,
  opts?: { apres?: { at: string; id: string }; traduire?: 'fr' | 'en'; signal?: AbortSignal },
): Promise<ConversationThread> {
  const params = new URLSearchParams();
  if (opts?.apres) {
    params.set('afterAt', opts.apres.at);
    params.set('afterId', opts.apres.id);
  }
  // ⚠️ La langue de LECTURE vient du navigateur : le serveur ne la connait pas, et il ne peut pas la
  // deviner a l'arrivee du message (deux collegues lisent le meme fil dans deux langues).
  if (opts?.traduire) params.set('traduire', opts.traduire);
  const q = params.toString();
  return request(`/tenants/${tenantId}/conversations/${conversationId}/messages${q ? `?${q}` : ''}`, opts?.signal ? { signal: opts.signal } : {});
}

/**
 * TRADUIT ce que l'operateur s'apprete a envoyer. Il n'envoie RIEN.
 *
 * 🔴 C'est une garde, pas une commodite : une traduction ratee en entree se rattrape sur l'original
 * affiche a cote, une traduction ratee en SORTIE est partie chez un client, et aucun message WhatsApp
 * livre ne se rappelle. L'operateur voit le texte traduit dans sa zone de saisie avant de valider.
 */
export function traduireSortant(
  tenantId: string,
  conversationId: string,
  texte: string,
  cible: string,
): Promise<{ texte: string; langueSource: string | null; cible: string }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/traduire`, {
    method: 'POST',
    body: JSON.stringify({ texte, cible }),
  });
}
/** L'opérateur rend la main : le scénario (ou l'agent de Meta) reprend la conversation. */
/**
 * EFFACE le contenu d'une conversation. Rend le nombre de messages effacés.
 *
 * 🔴 IRRÉVERSIBLE, réservé aux administrateurs, ET IL FERME LA FENÊTRE DE SERVICE : celle de 24 h se calcule
 * sur le dernier message ENTRANT, donc sans messages il n'y en a plus, et plus personne ne peut répondre
 * librement à ce contact tant qu'il n'a pas réécrit. L'écran doit l'avoir dit avant le clic.
 */
export function effacerConversation(tenantId: string, conversationId: string): Promise<{ effaces: number }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/messages`, { method: 'DELETE' });
}
export function releaseConversation(tenantId: string, conversationId: string): Promise<{ controlOwner: ControlOwner }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/release`, { method: 'POST' });
}
/**
 * L'opérateur PREND le fil : la conversation entre dans « À traiter ».
 *
 * Miroir exact de `releaseConversation`, qui existait seul. Sans lui, remettre une conversation à traiter
 * demandait d'ENVOYER un message (c'est l'envoi qui prend le fil), donc d'écrire au client pour un geste
 * de rangement interne.
 */
export function prendreConversation(tenantId: string, conversationId: string): Promise<{ controlOwner: ControlOwner }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/prendre`, { method: 'POST' });
}
/**
 * Signale une conversation À LA MAIN, ou retire ce signalement.
 *
 * ⚠️ N'écrit PAS le constat de l'analyse (qui repère les injures toute seule) : ce sont deux sources, et le
 * dossier « Signalé » montre leur union. Une ré-analyse ne peut donc pas effacer un signalement humain.
 */
export function signalerConversation(tenantId: string, conversationId: string, signale: boolean): Promise<{ signalee: boolean }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/${signale ? 'signaler' : 'ne-plus-signaler'}`, { method: 'POST' });
}
/** Surcharge de reprise de CE fil (C.4) : `resume` (repart au scénario), `inbox` (reste à l'humain), ou
 *  null (suit le défaut du tenant). Ne bascule pas le contrôle : réglage lu par le sweep de handback. */
export function replyConversation(
  tenantId: string,
  conversationId: string,
  text: string,
  /**
   * Ce que l'operateur avait ECRIT avant de faire traduire (migration 0137).
   *
   * 🔴 `text` EST CE QUI PART, traduit compris : c'est ce que le client recevra, et notre trace doit y
   * correspondre le jour d'un litige. Ce champ garde l'original. Ne garder qu'un des deux est faux
   * dans les deux sens.
   */
  redactionOrigine?: string | null,
): Promise<{ messageId: string }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/reply`, {
    method: 'POST',
    body: JSON.stringify(redactionOrigine ? { text, redactionOrigine } : { text }),
  });
}
export interface SendTemplateInput {
  templateName: string;
  language: string;
  bodyParams: string[];
  /** URL publique du média de header (image/vidéo/document), si le template en a un. */
  headerMediaUrl?: string;
  headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  /** Catégorie du template (pour les stats du dashboard) : MARKETING | UTILITY. */
  templateCategory?: string;
}
export function sendTemplateToConversation(tenantId: string, conversationId: string, input: SendTemplateInput): Promise<{ messageId: string }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/send-template`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Le fichier d'un message média, en octets (2026-09-09).
 *
 * ⚠️ APPELÉ AU CLIC, jamais au rendu du fil. Un fil de trente messages dont dix vocaux téléchargerait
 * vingt méga à l'ouverture, pour des fichiers que l'opérateur n'écoutera pas.
 */
export function lireMediaMessage(tenantId: string, conversationId: string, messageId: string): Promise<Blob> {
  return requestBlob(`/tenants/${tenantId}/conversations/${conversationId}/messages/${messageId}/media`);
}

/**
 * Transcrit le vocal d'un message. `deja` = il l'était déjà, rien n'a été repayé.
 *
 * 🔴 UN SEUL GESTE POUR L'OPÉRATEUR : avec `traduire`, le texte revient DANS SA LANGUE même si le
 * vocal était en espagnol. `texte` reste ce qui a été DIT, `traduction` notre lecture : garder les
 * deux est ce qui permet de marquer la seconde comme une lecture de modèle plutôt que comme une
 * citation.
 *
 * ⚠️ C'est la TRANSCRIPTION qui est traduite, jamais `body` : pour un vocal il vaut `[audio]` ou la
 * légende. Deux appels de modèle, donc deux fois le coût, et c'est assumé.
 */
export function transcrireMessage(
  tenantId: string,
  conversationId: string,
  messageId: string,
  traduire?: 'fr' | 'en' | null,
): Promise<{ texte: string; deja: boolean; langue: string | null; traduction: string | null }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/messages/${messageId}/transcrire`, {
    method: 'POST',
    ...(traduire ? { body: JSON.stringify({ traduire }) } : {}),
  });
}
