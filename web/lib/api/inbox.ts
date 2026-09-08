'use client';

/**
 * Le fil de conversation : liste, messages, envoi, prise de main, moderation.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request } from '../http';

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
  opts?: { apres?: { at: string; id: string }; signal?: AbortSignal },
): Promise<ConversationThread> {
  const q = opts?.apres ? `?afterAt=${encodeURIComponent(opts.apres.at)}&afterId=${encodeURIComponent(opts.apres.id)}` : '';
  return request(`/tenants/${tenantId}/conversations/${conversationId}/messages${q}`, opts?.signal ? { signal: opts.signal } : {});
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
/** Surcharge de reprise de CE fil (C.4) : `resume` (repart au scénario), `inbox` (reste à l'humain), ou
 *  null (suit le défaut du tenant). Ne bascule pas le contrôle : réglage lu par le sweep de handback. */
export function replyConversation(tenantId: string, conversationId: string, text: string): Promise<{ messageId: string }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/reply`, { method: 'POST', body: JSON.stringify({ text }) });
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
