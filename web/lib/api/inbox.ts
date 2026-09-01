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
  opts: { limit?: number; before?: { at: string; id: string }; aTraiter?: boolean; affectee?: string | 'aucune'; signalees?: boolean } = {},
): Promise<{ conversations: Conversation[] }> {
  const p = new URLSearchParams();
  if (opts.limit !== undefined) p.set('limit', String(opts.limit));
  if (opts.aTraiter) p.set('aTraiter', '1');
  if (opts.affectee !== undefined) p.set('affectee', opts.affectee);
  if (opts.signalees) p.set('signalees', '1');
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
/** Nombre de conversations « À traiter », compté par le serveur sur TOUTE la base (pas sur la page affichée). */
export function countConversationsATraiter(tenantId: string): Promise<{ count: number }> {
  return request<{ count: number }>(`/tenants/${tenantId}/conversations/todo-count`);
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
export function getConversationMessages(tenantId: string, conversationId: string): Promise<ConversationThread> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/messages`);
}
/** L'opérateur rend la main : le scénario (ou l'agent de Meta) reprend la conversation. */
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
