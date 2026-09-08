'use client';

/**
 * Les campagnes et le canal RCS : creation, suivi, destinataires, agents RCS.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request } from '../http';
import type { BulkTarget } from '../contact-filters';

// --- Campagnes ---

export type CampaignCategory = 'marketing' | 'utility';
export interface RecipientCounts {
  total: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  skipped: number;
}
export interface CampaignSummary {
  id: string;
  name: string;
  category: CampaignCategory;
  status: string;
  phoneNumberId: string;
  /** null pour une campagne SCÉNARIO (c'est le scénario qui envoie). Afficher via campaignSendLabel. */
  templateName: string | null;
  templateLanguage: string | null;
  /** Nom du scénario d'une campagne scénario. null = campagne template, ou scénario supprimé depuis. */
  workflowName: string | null;
  /** Webhook qui alimente la campagne AU FIL DE L'EAU. null = campagne ordinaire (liste figée à la création). */
  webhookId: string | null;
  /** Nom de ce webhook, affiché tel quel. null = campagne ordinaire, ou adresse supprimée depuis. */
  webhookName: string | null;
  createdAt: string;
  /** Instant de lancement programmé (ISO UTC) quand status = 'scheduled'. null sinon. */
  scheduledAt: string | null;
  /** Instant d'archivage (ISO UTC). null = campagne active. Indépendant du statut. */
  archivedAt: string | null;
  counts: RecipientCounts;
}
export interface CampaignRecipient {
  id: string;
  contactId: string;
  toE164: string;
  status: string;
  messageId: string | null;
  error: string | null;
  /** Code d'erreur Meta numérique (null hors échec). Pilote le bouton « Corriger + renvoyer » (F7). */
  errorCode: number | null;
  sentAt: string | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
}
export interface CampaignDetail extends CampaignSummary {
  /** Mapping des variables du template (sert au bouton F7 : savoir quels champs corriger). */
  paramMapping: TemplateParam[];
  recipients: CampaignRecipient[];
}
export interface PhoneNumber {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
}
export interface ParamSource {
  type: 'attribute' | 'field' | 'literal' | 'now';
  key?: string;
  value?: string;
}
export interface TemplateParam {
  position: number;
  source: ParamSource;
}
export interface RcsAgent {
  agentId: string;
  brandName: string;
  status: string;
}

export interface CreateCampaignInput {
  /** Vide sur une campagne RCS : elle part d'un agent de marque, pas d'un numéro Meta. */
  phoneNumberId: string;
  name: string;
  category: CampaignCategory;
  /** Template à envoyer (campagne template). Absent si campagne workflow. */
  templateName?: string;
  templateLanguage?: string;
  paramMapping?: TemplateParam[];
  /** Contacts choisis. Absent -> tous les contacts éligibles. */
  contactIds?: string[];
  /**
   * Les destinataires par INTENTION plutot que par liste d'identifiants : les filtres du mini-CRM, moins ce
   * qui a ete decoche. Exclusif avec `contactIds`, le serveur refuse les deux.
   *
   * 🔴 C'est ce qui retire le piege des grosses selections. « Tout selectionner » rapatriait jusqu'a 100 000
   * identifiants dans le navigateur et les renvoyait tous dans la requete, plafonnee a 1 Mo : la creation
   * echouait vers 25 000 contacts, bien AVANT la limite que l'ecran annoncait, et sans rien dire.
   */
  contactTarget?: BulkTarget;
  /** Campagne workflow : démarre ce workflow par destinataire (au lieu d'un template). */
  workflowId?: string;
  /** Débit max en messages/minute (1..80). Absent/null = aucun throttle (le run part au max). */
  ratePerMinute?: number | null;
  /** Canal d'envoi. Absent = 'whatsapp' (comportement historique). */
  channel?: 'whatsapp' | 'rcs';
  /** Campagne RCS : agent de marque qui envoie. */
  rcsAgentId?: string;
  /**
   * Campagne RCS : message envoyé tel quel (pas de template à faire approuver).
   *
   * Typé `RcsOutbound`, l'union COMPLÈTE, et pas la seule forme texte : une campagne à visuel envoie une
   * CARTE. L'ancienne déclaration ne mentait qu'à moitié (les boutons passaient déjà, par un spread qui
   * échappe au contrôle des propriétés en trop), ce qui est la pire des deux situations.
   */
  rcsMessage?: RcsOutbound;
  /**
   * Campagne AU FIL DE L'EAU : le webhook entrant (Tools > Webhooks) qui lui amènera ses destinataires, un
   * par un, à mesure qu'ils arrivent. Elle naît donc SANS destinataire, et `contactIds` n'a plus de sens
   * (le serveur refuse les deux ensemble).
   */
  webhookId?: string;
  /**
   * N'envoyer QUE pendant les heures d'ouverture de l'espace (onglet Paramètres). Absent = aucune contrainte.
   *
   * Vaut pour « Maintenant » COMME pour « Plus tard » : la campagne lancée hors créneau n'est pas refusée,
   * elle est mise en pause avec sa reprise, et un envoi coupé par la fermeture repart au créneau suivant.
   */
  businessHoursOnly?: boolean;
}

/** Campagnes actives par défaut ; `archived: true` renvoie la corbeille (les deux ensembles sont disjoints). */
export function listCampaigns(tenantId: string, opts?: { archived?: boolean }): Promise<{ campaigns: CampaignSummary[] }> {
  return request<{ campaigns: CampaignSummary[] }>(`/tenants/${tenantId}/campaigns${opts?.archived ? '?archived=1' : ''}`);
}

/** Ce qu'une clé d'API RCS ouvre : l'agent qui signe, le flux, et les quotas. Jamais la clé elle-même. */
export interface RcsChannelInfo {
  channelId: string;
  name: string;
  agentName: string;
  flow: string;
  dailyLimit: number | null;
  dailyUsed: number | null;
  monthlyLimit: number | null;
  monthlyUsed: number | null;
}

export interface RcsChannelState {
  active: boolean;
  channel?: { agentId: string; brandName: string; displayName: string | null; status: string; checkedAt: string | null };
}

export function getRcsChannel(tenantId: string): Promise<RcsChannelState> {
  return request<RcsChannelState>(`/tenants/${tenantId}/rcs/channel`);
}
export function activateRcsChannel(tenantId: string, apiKey: string): Promise<{ active: true; channel: RcsChannelInfo }> {
  return request<{ active: true; channel: RcsChannelInfo }>(`/tenants/${tenantId}/rcs/channel`, { method: 'POST', body: JSON.stringify({ apiKey }) });
}
export function deactivateRcsChannel(tenantId: string): Promise<{ active: false }> {
  return request<{ active: false }>(`/tenants/${tenantId}/rcs/channel`, { method: 'DELETE' });
}

// Modèle du message RCS : dans `./rcs-types`, module PUR, pour que la bascule TEXTE/CARTE (`./rcs`) soit
// testable depuis la suite racine sans tirer `window`. Ré-exporté ici : les écrans l'importent toujours d'`api`.
export type { RcsSuggestion, RcsCard, RcsOutbound } from '../rcs-types';
import type { RcsSuggestion, RcsOutbound } from '../rcs-types';

export interface RcsMessage {
  id: string;
  name: string;
  /** null = contenu stocké devenu illisible pour le schéma courant. L'écran le SIGNALE au lieu de le proposer. */
  content: RcsOutbound | null;
  createdAt: string;
  updatedAt: string;
}

export function listRcsMessages(tenantId: string): Promise<{ messages: RcsMessage[] }> {
  return request<{ messages: RcsMessage[] }>(`/tenants/${tenantId}/rcs-messages`);
}
export function createRcsMessage(tenantId: string, name: string, content: RcsOutbound): Promise<{ message: RcsMessage }> {
  return request<{ message: RcsMessage }>(`/tenants/${tenantId}/rcs-messages`, { method: 'POST', body: JSON.stringify({ name, content }) });
}
export function updateRcsMessage(tenantId: string, id: string, name: string, content: RcsOutbound): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/tenants/${tenantId}/rcs-messages/${id}`, { method: 'PATCH', body: JSON.stringify({ name, content }) });
}
export function deleteRcsMessage(tenantId: string, id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/tenants/${tenantId}/rcs-messages/${id}`, { method: 'DELETE' });
}

/**
 * Envoie un message de la bibliothèque RCS dans une conversation. Ses variables sont résolues côté serveur sur
 * la fiche du contact. Pas de fenêtre de 24 h à respecter : c'est une règle de WhatsApp, pas du RCS.
 */
/**
 * Envoie un RCS dans une conversation. Deux formes EXCLUSIVES : un message de la bibliothèque, ou une
 * réponse écrite à la main. La seconde existe parce qu'un contact joignable seulement en RCS n'était
 * atteignable qu'à travers la bibliothèque, sur le canal où il venait pourtant d'écrire.
 */
export function sendRcsToConversation(
  tenantId: string,
  conversationId: string,
  contenu: { rcsMessageId: string } | { text: string },
): Promise<{ messageId: string }> {
  return request<{ messageId: string }>(`/tenants/${tenantId}/conversations/${conversationId}/send-rcs`, {
    method: 'POST',
    body: JSON.stringify(contenu),
  });
}

/**
 * Variables d'un template résolues sur la fiche du contact d'une conversation, avec le libellé du champ qui
 * les alimente. Sert à PRÉ-REMPLIR l'écran d'envoi de l'Inbox au lieu de demander `{{1}}`, `{{2}}`.
 */
export function resolveTemplateParamsForConversation(
  tenantId: string,
  conversationId: string,
  tpl: { name: string; language: string; count: number },
): Promise<{ values: string[]; labels: string[] }> {
  const q = new URLSearchParams({ name: tpl.name, language: tpl.language, count: String(tpl.count) });
  return request<{ values: string[]; labels: string[] }>(
    `/tenants/${tenantId}/conversations/${conversationId}/template-params?${q.toString()}`,
  );
}

/** Un visuel hébergé pour les messages RCS. `url` est l'adresse PUBLIQUE, celle que l'opérateur ira chercher. */
export interface RcsMedia {
  id: string;
  code: string;
  mime: 'image/jpeg' | 'image/png' | 'image/gif';
  taille: number;
  nom: string | null;
  createdAt: string;
}

export function listRcsMedia(tenantId: string): Promise<{ media: RcsMedia[] }> {
  return request<{ media: RcsMedia[] }>(`/tenants/${tenantId}/rcs/media`);
}

/**
 * Téléverse un visuel et rend son adresse publique. Le serveur relit la SIGNATURE du fichier : un fichier
 * renommé en `.png` est refusé, et c'est le type réel qui décide de l'extension de l'URL.
 */
export function uploadRcsMedia(tenantId: string, dataUrl: string, nom: string | null): Promise<{ media: RcsMedia; url: string }> {
  return request<{ media: RcsMedia; url: string }>(`/tenants/${tenantId}/rcs/media`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl, nom }),
  });
}

export function deleteRcsMedia(tenantId: string, id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/tenants/${tenantId}/rcs/media/${id}`, { method: 'DELETE' });
}

/** Agents RCS du tenant (sélecteur de l'assistant de campagne). Liste vide = canal RCS non configuré. */
export function listRcsAgents(tenantId: string): Promise<{ agents: RcsAgent[] }> {
  return request<{ agents: RcsAgent[] }>(`/tenants/${tenantId}/rcs-agents`);
}
export function getCampaign(tenantId: string, campaignId: string): Promise<CampaignDetail> {
  return request<CampaignDetail>(`/tenants/${tenantId}/campaigns/${campaignId}`);
}
export function listPhoneNumbers(tenantId: string): Promise<{ phoneNumbers: PhoneNumber[] }> {
  return request<{ phoneNumbers: PhoneNumber[] }>(`/tenants/${tenantId}/phone-numbers`);
}
export interface CampaignCreated {
  campaignId: string;
  recipientCount: number;
  /** Destinataires écartés à la création (variable de template manquante, ex. prénom absent) -> avertissement UI. */
  /** Écarts à la construction, avec leur motif. `missing` n'existe que pour `missing_variable`. */
  skipped: Array<{ contactId: string; toE164: string; reason: 'missing_variable' | 'not_opted_in'; missing?: number[] }>;
  /**
   * Avertissement de PALIER : l'audience dépasse ce que Meta laissera passer en 24 h sur ce numéro. Absent =
   * rien à signaler. Ce n'est PAS un refus : la campagne part, se met en pause au plafond et reprend.
   */
  avertissement?: string;
}
export function createCampaign(tenantId: string, input: CreateCampaignInput): Promise<CampaignCreated> {
  return request(`/tenants/${tenantId}/campaigns`, { method: 'POST', body: JSON.stringify(input) });
}

/**
 * Brouillon de COMPOSITION : une campagne en cours d'écriture, retrouvable après avoir quitté l'écran.
 *
 * ⚠️ Rien à voir avec une campagne de statut « brouillon », qui est une campagne COMPLÈTE (destinataires
 * calculés) non lancée. Un brouillon de composition n'a ni destinataire ni template résolu : il ne peut
 * donc rien envoyer, et il disparaît dès que la vraie campagne est créée.
 */
export interface CampaignDraft {
  id: string;
  name: string;
  /** État de l'écran, forme libre : ce que le formulaire y met, il est seul à savoir le relire. */
  state: Record<string, unknown>;
  updatedAt: string;
}
export function listCampaignDrafts(tenantId: string): Promise<{ drafts: CampaignDraft[] }> {
  return request(`/tenants/${tenantId}/campaign-drafts`);
}
export function createCampaignDraft(tenantId: string, name: string, state: Record<string, unknown>): Promise<{ draft: CampaignDraft }> {
  return request(`/tenants/${tenantId}/campaign-drafts`, { method: 'POST', body: JSON.stringify({ name, state }) });
}
export function updateCampaignDraft(tenantId: string, draftId: string, name: string, state: Record<string, unknown>): Promise<{ updated: boolean }> {
  return request(`/tenants/${tenantId}/campaign-drafts/${draftId}`, { method: 'PUT', body: JSON.stringify({ name, state }) });
}
export function deleteCampaignDraft(tenantId: string, draftId: string): Promise<{ deleted: boolean }> {
  return request(`/tenants/${tenantId}/campaign-drafts/${draftId}`, { method: 'DELETE' });
}
/** Lance une campagne : maintenant (sans `scheduledAt`) ou à une date future (ISO UTC absolu -> programmée). */
export function runCampaign(campaignId: string, scheduledAt?: string): Promise<{ enqueued?: boolean; scheduled?: boolean; scheduledAt?: string }> {
  return request(`/campaigns/${campaignId}/run`, { method: 'POST', ...(scheduledAt ? { body: JSON.stringify({ scheduledAt }) } : {}) });
}
/** Renvoi d'un destinataire en échec de variable de template (F7) : après avoir corrigé la donnée du contact, re-résout
 *  et remet le destinataire en file. 202 si repris ; 422 si la variable est toujours manquante. */
export function retryRecipient(campaignId: string, recipientId: string): Promise<{ enqueued: boolean; recipientId: string }> {
  return request(`/campaigns/${campaignId}/recipients/${recipientId}/retry`, { method: 'POST' });
}
/** Annule une campagne programmée : elle repasse en brouillon. */
export function cancelSchedule(campaignId: string): Promise<{ cancelled: boolean }> {
  return request(`/campaigns/${campaignId}/cancel-schedule`, { method: 'POST' });
}
/** Archive une campagne : masquée de la liste, conservée en base (les analytics continuent de la compter). */
export function archiveCampaign(tenantId: string, campaignId: string): Promise<{ archived: boolean }> {
  return request(`/tenants/${tenantId}/campaigns/${campaignId}/archive`, { method: 'POST' });
}
/**
 * Arrête une campagne AU FIL DE L'EAU : elle cesse de prendre les arrivants du webhook. C'est son seul point
 * final, elle n'en a aucun par elle-même. Son historique d'envoi reste intact.
 */
export function stopCampaign(tenantId: string, campaignId: string): Promise<{ stopped: boolean }> {
  return request(`/tenants/${tenantId}/campaigns/${campaignId}/stop`, { method: 'POST' });
}
/**
 * SUSPEND un envoi en cours. Ce qui est déjà parti reste parti ; l'envoi s'interrompt dans les secondes qui
 * suivent, et « Reprendre » repart au destinataire suivant. 409 si la campagne n'était pas en cours d'envoi.
 */
export function pauseCampaign(tenantId: string, campaignId: string): Promise<{ paused: boolean }> {
  return request(`/tenants/${tenantId}/campaigns/${campaignId}/pause`, { method: 'POST' });
}
/** Sort une campagne de l'archive. */
export function unarchiveCampaign(tenantId: string, campaignId: string): Promise<{ archived: boolean }> {
  return request(`/tenants/${tenantId}/campaigns/${campaignId}/unarchive`, { method: 'POST' });
}
/** Supprime DÉFINITIVEMENT une campagne jamais lancée. 409 si elle est déjà partie (il faut l'archiver). */
export function deleteCampaign(tenantId: string, campaignId: string): Promise<{ deleted: boolean }> {
  return request(`/tenants/${tenantId}/campaigns/${campaignId}`, { method: 'DELETE' });
}
