'use client';

/**
 * Appels API de la console. Le socle HTTP (auth, retry, 401) vit dans `./http` : il est partagé avec les
 * modules d'API par domaine (`api-mba.ts`), qui ne peuvent pas dupliquer l'authentification sans risquer
 * qu'une des deux copies dérive.
 *
 * `ApiError` et `SESSION_EXPIRED_EVENT` sont RÉEXPORTÉS : le reste de la console les importe depuis `@/lib/api`
 * depuis toujours, et les déplacer sans réexport casserait des imports pour zéro gain.
 */

import { request, ApiError, BASE } from './http';
import type { UserFieldKind } from './field-kinds';

export { ApiError, SESSION_EXPIRED_EVENT } from './http';


export interface LoginResult {
  token: string;
  user: { email: string; role: string; tenantId: string };
}
export function login(email: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}
/** Inscription libre : crée un espace + admin, renvoie une session (comme le login). */
export function signup(input: { workspaceName: string; email: string; password: string; name?: string }): Promise<LoginResult> {
  return request<LoginResult>('/auth/signup', { method: 'POST', body: JSON.stringify(input) });
}
/** Mot de passe perdu : renvoie toujours 200 (anti-énumération). */
export function forgotPassword(email: string): Promise<{ ok: boolean; message: string }> {
  return request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
}
export function resetPassword(token: string, password: string): Promise<{ ok: boolean }> {
  return request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });
}
export function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
  return request('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
}
/** Config publique d'auth : le front l'utilise pour afficher (ou non) le bouton Google. */
export function getAuthConfig(): Promise<{ googleClientId: string; googleEnabled: boolean }> {
  return request('/auth/config', { method: 'GET' });
}
/** Résultat Google : session + `isNew` (email inconnu -> nouvel espace créé -> onboarding /accueil). */
export interface GoogleResult extends LoginResult {
  isNew: boolean;
}
/** Se connecter avec Google : envoie le jeton ID au serveur, renvoie une session (login OU nouvel espace). */
export function loginWithGoogle(idToken: string): Promise<GoogleResult> {
  return request<GoogleResult>('/auth/google', { method: 'POST', body: JSON.stringify({ idToken }) });
}

export interface Contact {
  id: string;
  phoneE164: string | null;
  /** Identité BSUID (compte WhatsApp) quand le contact n'a pas de numéro. */
  bsuid: string | null;
  profileName: string | null;
  optInStatus: string;
  fields: Record<string, unknown>;
  tags: string[];
  createdAt: string;
}
/** Identité messageable d'un contact : le numéro s'il existe, sinon le BSUID. null si aucun. */
export function contactIdentity(c: Pick<Contact, 'phoneE164' | 'bsuid'>): string | null {
  return c.phoneE164 ?? c.bsuid ?? null;
}
export function listContacts(tenantId: string, opts?: { limit?: number; offset?: number; tag?: string }): Promise<{ contacts: Contact[] }> {
  const qs = new URLSearchParams();
  if (opts?.limit != null) qs.set('limit', String(opts.limit));
  if (opts?.offset != null) qs.set('offset', String(opts.offset));
  if (opts?.tag) qs.set('tag', opts.tag);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<{ contacts: Contact[] }>(`/tenants/${tenantId}/contacts${suffix}`);
}

/** Édite un contact (fiche) : ajoute/met à jour/supprime des valeurs de user fields, édite le Nom (profileName,
 *  '' -> vide), affecte/retire des tags. MERGE côté serveur (n'écrase pas les autres champs). Le téléphone et le
 *  BSUID (identité/routage) restent en lecture seule. Renvoie le contact à jour. */
export function updateContact(
  tenantId: string,
  contactId: string,
  patch: {
    fields?: Record<string, string>; removeFields?: string[]; addTags?: string[]; removeTags?: string[];
    profileName?: string | null;
    /** Consentement posé à la main depuis la fiche. Deux valeurs : « inconnu » ne se réécrit pas (il signifie
     *  « rien n'a jamais été enregistré », le repeindre falsifierait le registre au lieu de le corriger). */
    optInStatus?: 'opted_in' | 'opted_out';
  },
): Promise<{ contact: Contact }> {
  return request<{ contact: Contact }>(`/tenants/${tenantId}/contacts/${contactId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

// --- Historique d'un contact (onglet de la fiche) ---

export interface ContactSend {
  campaignId: string;
  campaignName: string;
  category: string;
  /** null quand la campagne envoie un scénario au lieu d'un template. */
  templateName: string | null;
  templateLanguage: string | null;
  workflowName: string | null;
  status: string;
  sentAt: string | null;
  error: string | null;
  /** Dernier état connu. null = statut jamais remonté par Meta, ce qui ne veut PAS dire « non délivré ». */
  deliveryStatus: string | null;
  deliveryUpdatedAt: string | null;
}
export interface ContactConversation {
  conversationId: string;
  waId: string;
  lastMessageAt: string;
  lastPreview: string | null;
  messagesCount: number;
  analysisStatus: string;
  analysis: {
    sentiment: string; intent: string; topic: string; resolved: boolean;
    handledBy: string; exchangesCount: number; actionSuggestion: string; analyzedAt: string;
  } | null;
  /** L'analyse existe mais un message est arrivé depuis : elle est périmée. */
  analysisStale: boolean;
  inboxHref: string;
}
export interface ContactHistory {
  sends: ContactSend[];
  conversations: ContactConversation[];
}
/** Campagnes reçues + conversations tenues par ce contact. 404 si le contact n'est pas dans l'espace. */
export function getContactHistory(tenantId: string, contactId: string): Promise<ContactHistory> {
  return request<ContactHistory>(`/tenants/${tenantId}/contacts/${contactId}/history`);
}
/** Envois du contact pour l'export CSV (F5), NON capé (contrairement à getContactHistory borné à l'écran). */
export function getContactSendsForExport(tenantId: string, contactId: string): Promise<{ sends: ContactSend[] }> {
  return request<{ sends: ContactSend[] }>(`/tenants/${tenantId}/contacts/${contactId}/history/export`);
}

// Types + sérialisation des filtres : module PUR `./contact-filters` (testable sans navigateur, miroir du parse
// serveur). Ré-exportés ici pour ne pas casser les imports existants (`import { ContactFilters } from '../lib/api'`).
export type { ContactFieldOp, ContactFieldFilter, ContactFilters, BulkTarget } from './contact-filters';
import { filtersToQuery, type ContactFilters, type BulkTarget } from './contact-filters';

/** Contacts correspondant aux filtres (paginé) + total (compteur réel). Source « Liste de contacts ». */
export function queryContacts(tenantId: string, filters: ContactFilters, opts?: { limit?: number; offset?: number }): Promise<{ contacts: Contact[]; total?: number }> {
  const qs = filtersToQuery(filters);
  if (opts?.limit != null) qs.set('limit', String(opts.limit));
  if (opts?.offset != null) qs.set('offset', String(opts.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<{ contacts: Contact[]; total?: number }>(`/tenants/${tenantId}/contacts${suffix}`);
}

/** Nombre de contacts correspondant aux filtres (badge « N contacts correspondent »). */
export function countContacts(tenantId: string, filters: ContactFilters): Promise<{ total: number }> {
  const suffix = filtersToQuery(filters).toString();
  return request<{ total: number }>(`/tenants/${tenantId}/contacts/count${suffix ? `?${suffix}` : ''}`);
}

/** Ids des contacts correspondant aux filtres (résolution serveur de la source d'une campagne). */
export function contactIdsForFilters(tenantId: string, filters: ContactFilters): Promise<{ ids: string[] }> {
  const suffix = filtersToQuery(filters).toString();
  return request<{ ids: string[] }>(`/tenants/${tenantId}/contacts/ids${suffix ? `?${suffix}` : ''}`);
}

/** Action en masse du mini-CRM (admin) : ajouter/retirer un tag OU poser un champ, sur une cible (ids ou filtres).
 *  Renvoie le nombre de contacts touchés. */
export type BulkAction =
  | { type: 'add_tag'; tags: string[] }
  | { type: 'remove_tag'; tags: string[] }
  | { type: 'set_field'; key: string; value: string }
  | { type: 'set_optin'; value: 'opted_in' | 'opted_out' };
export function bulkContactAction(tenantId: string, target: BulkTarget, action: BulkAction): Promise<{ affected: number }> {
  return request<{ affected: number }>(`/tenants/${tenantId}/contacts/bulk`, { method: 'POST', body: JSON.stringify({ target, action }) });
}

/**
 * SUPPRESSION de contacts (admin). LA seule, et elle est IRRÉVERSIBLE : le fil de conversation, ses messages
 * et l'analyse qualitative sont effacés, puis ce qui porte les compteurs est anonymisé pour que les totaux de
 * campagne restent justes. Le `confirm` n'est pas décoratif : le serveur refuse sans lui.
 */
export function deleteContacts(tenantId: string, target: BulkTarget): Promise<{ purges: number; conversations: number; messages: number; analyses: number }> {
  return request(`/tenants/${tenantId}/contacts/purge`, { method: 'POST', body: JSON.stringify({ target, confirm: 'SUPPRIMER' }) });
}

/** Une action sensible enregistrée sur les contacts. Ne porte JAMAIS de numéro : seulement l'identifiant. */
export interface AuditEntry {
  id: string;
  at: string;
  actorEmail: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  detail: Record<string, unknown>;
}

/** Historique des actions sensibles de l'espace, du plus récent au plus ancien (admin). */
export function listAudit(tenantId: string, limit = 100): Promise<{ entries: AuditEntry[] }> {
  return request<{ entries: AuditEntry[] }>(`/tenants/${tenantId}/audit?limit=${limit}`);
}

// `listAllContacts` a vécu ici sans appelant : elle paginait correctement, avec un commentaire promettant de
// « ne jamais tronquer silencieusement », pendant que la page Contacts et l'écran Campagne appelaient
// `listContacts` avec la limite serveur en dur. Supprimée le 2026-07-18 plutôt que gardée « au cas où » :
// la pagination réelle de ces deux écrans est un item du backlog (bloc 5 du PLAN.md), pas un helper dormant.

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ line: number; reason: string }>;
}

export type ColumnTarget = 'phone' | 'name' | 'custom' | 'ignore';
export interface ColumnMapping {
  columns: Record<string, { target: ColumnTarget; key?: string }>;
}
export interface ImportPreview {
  headers: string[];
  sampleRows: Array<Record<string, string>>;
  rowCount: number;
  mapping: ColumnMapping;
}

/** Aperçu : renvoie les colonnes détectées + un mapping suggéré (même parsing que l'import). */
export function previewImport(tenantId: string, csv: string): Promise<ImportPreview> {
  return request<ImportPreview>(`/tenants/${tenantId}/contacts/import/preview`, {
    method: 'POST',
    body: JSON.stringify({ csv }),
  });
}

export function importCsv(
  tenantId: string,
  csv: string,
  optIn: boolean,
  tags?: string[],
  mapping?: ColumnMapping,
): Promise<ImportReport> {
  return request<ImportReport>(`/tenants/${tenantId}/contacts/import`, {
    method: 'POST',
    body: JSON.stringify({
      csv,
      optIn,
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(mapping ? { mapping } : {}),
    }),
  });
}

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
  /** Campagne workflow : démarre ce workflow par destinataire (au lieu d'un template). */
  workflowId?: string;
  /** Débit max en messages/minute (1..80). Absent/null = aucun throttle (le run part au max). */
  ratePerMinute?: number | null;
  /** Canal d'envoi. Absent = 'whatsapp' (comportement historique). */
  channel?: 'whatsapp' | 'rcs';
  /** Campagne RCS : agent de marque qui envoie. */
  rcsAgentId?: string;
  /** Campagne RCS : message envoyé tel quel (pas de template à faire approuver). */
  rcsMessage?: { kind: 'text'; text: string };
}

/** Campagnes actives par défaut ; `archived: true` renvoie la corbeille (les deux ensembles sont disjoints). */
export function listCampaigns(tenantId: string, opts?: { archived?: boolean }): Promise<{ campaigns: CampaignSummary[] }> {
  return request<{ campaigns: CampaignSummary[] }>(`/tenants/${tenantId}/campaigns${opts?.archived ? '?archived=1' : ''}`);
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
}
export function createCampaign(tenantId: string, input: CreateCampaignInput): Promise<CampaignCreated> {
  return request(`/tenants/${tenantId}/campaigns`, { method: 'POST', body: JSON.stringify(input) });
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
/** Sort une campagne de l'archive. */
export function unarchiveCampaign(tenantId: string, campaignId: string): Promise<{ archived: boolean }> {
  return request(`/tenants/${tenantId}/campaigns/${campaignId}/unarchive`, { method: 'POST' });
}
/** Supprime DÉFINITIVEMENT une campagne jamais lancée. 409 si elle est déjà partie (il faut l'archiver). */
export function deleteCampaign(tenantId: string, campaignId: string): Promise<{ deleted: boolean }> {
  return request(`/tenants/${tenantId}/campaigns/${campaignId}`, { method: 'DELETE' });
}

// --- Templates ---

export interface TemplateSummary {
  /** Id Meta (requis pour l'édition). '' si l'appel n'a pas demandé le field. */
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  /** Corps du template : déduit les variables + aperçu côté campagne. Peut être '' (anciens). */
  body?: string;
  /** Format du header : TEXT | IMAGE | VIDEO | DOCUMENT, ou null si pas de header. */
  headerFormat?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null;
  /** Texte du header TEXT (pré-remplissage édition). */
  headerText?: string;
  /** Pied de page (pré-remplissage édition). */
  footer?: string;
  /** Boutons top-level (pré-remplissage de l'édition). */
  buttons?: TemplateButtonInput[];
  /** Exemples de variables du BODY (pré-remplissage). */
  example?: string[];
  /** true = carousel : édition non supportée, et non proposé à l'envoi manuel depuis l'inbox.
   *  NON optionnel : le serveur le rend toujours, et un filtre `!isCarousel` deviendrait muet sans erreur tsc. */
  isCarousel: boolean;
  /** Cartes du carousel relues chez Meta (image, texte, boutons), pour l'aperçu. Absent hors carousel.
   *  ⚠️ `mediaUrl` porte une expiration : à consommer à l'affichage, jamais à mettre en cache. */
  carousel?: { cards: Array<{ mediaUrl?: string; mediaFormat?: 'IMAGE' | 'VIDEO'; body?: string; buttons?: TemplateButtonInput[] }> };
  /** true = template limité à BODY(+BUTTONS) : seul cas éditable sans perte (header/footer/carousel bloqués). */
  editable?: boolean;
}
export interface TemplateButtonInput {
  type: 'QUICK_REPLY' | 'URL' | 'FLOW';
  text: string;
  url?: string;
  /** requis si type = FLOW : id d'un flow PUBLISHED. */
  flowId?: string;
}
export interface CarouselCardInput {
  headerHandle: string;
  body?: string;
  buttons?: TemplateButtonInput[];
}
/** En-tête d'un template : texte (variable optionnelle) OU média (handle du resumable upload). */
export type TemplateHeaderInput =
  | { format: 'TEXT'; text: string; example?: string }
  | { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; handle: string };
export interface CreateTemplateInput {
  name: string;
  category: 'MARKETING' | 'UTILITY';
  language: string;
  /** En-tête optionnel (texte/image/vidéo). */
  header?: TemplateHeaderInput;
  body: string;
  example?: string[];
  /** Pied de page optionnel (<= 60 car.). */
  footer?: string;
  buttons?: TemplateButtonInput[];
  /** Template CAROUSEL : corps commun (body) + 2-10 cartes. */
  carousel?: { cards: CarouselCardInput[] };
  /** Indices « variable {{n}} -> champ » posés via le sélecteur (pour pré-remplir la campagne). */
  paramHints?: TemplateParamHint[];
}
/** Indice de mapping variable -> champ posé au design d'un template. */
export interface TemplateParamHint {
  position: number;
  source: ParamSource;
}
export function listTemplates(tenantId: string): Promise<{ templates: TemplateSummary[] }> {
  return request<{ templates: TemplateSummary[] }>(`/tenants/${tenantId}/templates`);
}
export function createTemplate(tenantId: string, input: CreateTemplateInput): Promise<{ id: string; status: string }> {
  return request(`/tenants/${tenantId}/templates`, { method: 'POST', body: JSON.stringify(input) });
}
/** Édite un template SIMPLE (body/boutons/category). L'id est résolu côté serveur depuis le nom+langue. */
export interface UpdateTemplateInput {
  language: string;
  category: 'MARKETING' | 'UTILITY';
  header?: TemplateHeaderInput;
  body: string;
  example?: string[];
  footer?: string;
  buttons?: TemplateButtonInput[];
  paramHints?: TemplateParamHint[];
}
export function updateTemplate(tenantId: string, name: string, input: UpdateTemplateInput): Promise<{ success: boolean; status: string }> {
  return request(`/tenants/${tenantId}/templates/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(input) });
}
/** Indices variable -> champ d'un template (pour pré-remplir le mapping d'une campagne). */
export function getTemplateHints(tenantId: string, name: string, language: string): Promise<{ hints: TemplateParamHint[] }> {
  return request(`/tenants/${tenantId}/templates/${encodeURIComponent(name)}/param-hints?language=${encodeURIComponent(language)}`);
}
export function deleteTemplate(tenantId: string, name: string): Promise<{ success: boolean }> {
  return request(`/tenants/${tenantId}/templates/${encodeURIComponent(name)}`, { method: 'DELETE' });
}
/** Upload d'une image (data URL base64) -> handle média Meta (header de carte carousel). */
export function uploadMedia(tenantId: string, dataUrl: string): Promise<{ handle: string }> {
  return request<{ handle: string }>(`/tenants/${tenantId}/media`, { method: 'POST', body: JSON.stringify({ dataUrl }) });
}

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
export function listConversations(tenantId: string): Promise<{ conversations: Conversation[] }> {
  return request<{ conversations: Conversation[] }>(`/tenants/${tenantId}/conversations`);
}
/** Nombre de conversations non lues (pastille du menu). Route dédiée : le menu ne rapatrie pas la liste. */
export function countUnreadConversations(tenantId: string): Promise<{ count: number }> {
  return request<{ count: number }>(`/tenants/${tenantId}/conversations/unread-count`);
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

// --- Dashboard (stats + réglages) ---

export interface DailyPoint {
  date: string;
  count: number;
}
export interface DashboardStats {
  contacts: DailyPoint[];
  templates: { utility: DailyPoint[]; marketing: DailyPoint[] };
  exchanged: DailyPoint[];
}
/** Plage de dates des stats (YYYY-MM-DD, Europe/Paris). Absente -> le backend retombe sur 30 jours. */
export interface StatsRange {
  from: string;
  to: string;
}
function rangeQuery(range?: StatsRange): string {
  return range ? `?from=${range.from}&to=${range.to}` : '';
}
export function getStats(tenantId: string, range?: StatsRange): Promise<DashboardStats> {
  return request<DashboardStats>(`/tenants/${tenantId}/stats${rangeQuery(range)}`);
}
/** Funnel d'UNE campagne : envoyés -> délivrés -> lus -> répondus + échecs. */
export interface CampaignFunnel {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
}
export function getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel> {
  return request<CampaignFunnel>(`/tenants/${tenantId}/stats/campaign-funnel?campaignId=${encodeURIComponent(campaignId)}`);
}

/** Une ligne du breakdown d'erreurs Meta : code numérique + template + occurrences. */
export interface ErrorBreakdownRow {
  code: number;
  count: number;
  /** Template de la campagne à l'origine des erreurs (null si non renseigné). */
  templateName: string | null;
}
export function getErrorBreakdown(tenantId: string, range?: StatsRange): Promise<{ errors: ErrorBreakdownRow[] }> {
  return request<{ errors: ErrorBreakdownRow[] }>(`/tenants/${tenantId}/stats/errors${rangeQuery(range)}`);
}

/** Série de coût estimé/jour, par catégorie. `hasRates=false` si Meta n'a fourni aucun tarif. */
export interface CostSeries {
  marketing: DailyPoint[];
  utility: DailyPoint[];
  total: number;
  hasRates: boolean;
}
/** Filtre du graphe de coût. Plusieurs valeurs -> série COMPILÉE. Les deux axes sont mutuellement exclusifs. */
export function getCostSeries(tenantId: string, range?: StatsRange, filter?: { campaignIds?: string[]; templateNames?: string[] }): Promise<CostSeries> {
  const parts: string[] = [];
  if (filter?.campaignIds?.length) parts.push(`campaignIds=${encodeURIComponent(filter.campaignIds.join(','))}`);
  if (filter?.templateNames?.length) parts.push(`templateNames=${encodeURIComponent(filter.templateNames.join(','))}`);
  const base = rangeQuery(range);
  const extra = parts.length ? (base ? `&${parts.join('&')}` : `?${parts.join('&')}`) : '';
  return request<CostSeries>(`/tenants/${tenantId}/stats/cost${base}${extra}`);
}

export interface TemplateBreakdownRow {
  name: string;
  category: string | null;
  count: number;
}
export interface CategoryPricing {
  category: string;
  cost: number;
  volume: number;
  ratePerMessage: number;
}
export interface PricingSummary {
  byCategory: Record<string, CategoryPricing>;
  totalCost: number;
}
export interface TemplateStats {
  breakdown: TemplateBreakdownRow[];
  /** null si Meta indisponible : afficher le volume seul, jamais un faux prix. */
  pricing: PricingSummary | null;
}
export function getTemplateStats(tenantId: string, range?: StatsRange): Promise<TemplateStats> {
  return request<TemplateStats>(`/tenants/${tenantId}/stats/templates${rangeQuery(range)}`);
}

// --- Analyse de conversation (Pièce 1) : agrégats quanti + liste quali. Champs LLM = INDICATIFS. ---
export interface ConversationAnalysisSummary {
  /** Feature d'analyse active côté serveur (empty-state différencié : inactif vs aucune donnée). */
  enabled: boolean;
  total: number;
  sentiment: { positif: number; neutre: number; negatif: number };
  intent: { demande_devis: number; sav: number; reclamation: number; information: number; prise_rdv: number; autre: number };
  resolution: { resolved: number; unresolved: number; rate: number | null };
  handledBy: { humain: number; automatise: number; mba: number };
  exchanges: { avg: number | null; median: number | null };
  actions: { creer_devis: number; rappeler: number; relancer: number; escalader: number; aucune: number };
  topTopics: Array<{ topic: string; count: number }>;
  confidence: { lt50: number; from50to70: number; from70to90: number; gte90: number };
}
export interface AnalyzedConversation {
  conversationId: string;
  waId: string;
  profileName: string | null;
  sentiment: string;
  intent: string;
  topic: string;
  resolved: boolean;
  actionSuggestion: string;
  confidence: number;
  justification: string;
  handledBy: string;
  exchangesCount: number;
  analyzedAt: string;
  /** Lien vers le fil dans l'inbox (/inbox?c=<conversationId>). */
  inboxHref: string;
}
export function getConversationAnalysisSummary(tenantId: string, range?: StatsRange): Promise<ConversationAnalysisSummary> {
  return request<ConversationAnalysisSummary>(`/tenants/${tenantId}/stats/conversations${rangeQuery(range)}`);
}
export function listAnalyzedConversations(
  tenantId: string,
  range?: StatsRange,
  filters?: { sentiment?: string; intent?: string; action?: string; limit?: number },
): Promise<{ conversations: AnalyzedConversation[] }> {
  const parts: string[] = [];
  if (filters?.sentiment) parts.push(`sentiment=${encodeURIComponent(filters.sentiment)}`);
  if (filters?.intent) parts.push(`intent=${encodeURIComponent(filters.intent)}`);
  if (filters?.action) parts.push(`action=${encodeURIComponent(filters.action)}`);
  if (filters?.limit != null) parts.push(`limit=${filters.limit}`);
  const base = rangeQuery(range);
  const extra = parts.length ? (base ? `&${parts.join('&')}` : `?${parts.join('&')}`) : '';
  return request<{ conversations: AnalyzedConversation[] }>(`/tenants/${tenantId}/stats/conversations/list${base}${extra}`);
}

/** Horaires d'un jour. `closed` = fermé (aucune plage). `open`/`close` = 'HH:MM' (heure locale du tenant). */
export interface DayHours { closed: boolean; open: string; close: string }
/** Heures d'ouverture par jour, clés '0'..'6' (0 = dimanche). Miroir de `BusinessHours` serveur. */
export type BusinessHours = Record<string, DayHours>;

export interface TenantSettings {
  /** Durée du gel après prise de main par un opérateur, en secondes. null = défaut du serveur. */
  controlHandbackSeconds: number | null;
  /** Défaut : à la reprise d'un fil pris en main, `resume` (rendu au scénario) ou `inbox` (reste à l'humain).
   *  null = pas de choix explicite -> repli usine `resume`. Surchargeable par conversation. */
  mbaEnabled: boolean;
  /** Canal RCS exploitable : vrai dès qu'un agent RCS est rattaché au tenant. DÉRIVÉ de l'état réel du dépôt,
   *  pas un réglage à basculer. Absent (backend plus ancien que le front) = éteint. */
  rcsEnabled?: boolean;
  hubspotListsEnabled: boolean;
  /** Pause des campagnes via listes HubSpot (F3-b). true = source HubSpot suspendue (pilotée par l'action Pause). */
  campaignsPaused: boolean;
  /** Auto-relance des échecs de livraison (F6). */
  autoRetryEnabled: boolean;
  /** Fuseau IANA du tenant (ex. 'Europe/Paris'). Base des conditions NOW / jour de semaine / heures d'ouverture. */
  timezone: string;
  /** Heures d'ouverture par jour ('0'..'6', 0 = dimanche). */
  businessHours: BusinessHours;
}
export function getSettings(tenantId: string): Promise<TenantSettings> {
  return request<TenantSettings>(`/tenants/${tenantId}/settings`);
}
export function putSettings(tenantId: string, mbaEnabled: boolean): Promise<TenantSettings> {
  return request<TenantSettings>(`/tenants/${tenantId}/settings`, { method: 'PUT', body: JSON.stringify({ mbaEnabled }) });
}
/** Active/désactive le toggle « Campagnes via données HubSpot ». */
export function setHubspotListsEnabled(tenantId: string, enabled: boolean): Promise<{ hubspotListsEnabled: boolean }> {
  return request(`/tenants/${tenantId}/settings/hubspot-lists`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
}
/** Active/désactive l'auto-relance des échecs de livraison (F6). */
export function setAutoRetryEnabled(tenantId: string, enabled: boolean): Promise<{ autoRetryEnabled: boolean }> {
  return request(`/tenants/${tenantId}/settings/auto-retry`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
}

/**
 * Demande au backend un lien d'install/re-consentement HubSpot SIGNÉ (le tenant est dans la signature, plus dans
 * un `?tenant=` en clair forgeable). Route admin-only ; le tenant vient du JWT. `grant='lists'` pour le re-consentement.
 */
export function getHubspotInstallLink(tenantId: string, grant?: 'lists'): Promise<{ installUrl: string }> {
  return request(`/tenants/${tenantId}/hubspot/install-link`, {
    method: 'POST',
    body: JSON.stringify(grant ? { grant } : {}),
  });
}

/** Durée du gel après qu'un opérateur a pris la main, en secondes. null = défaut du serveur, 0 = jamais
 *  de reprise automatique (l'opérateur garde la main jusqu'à ce qu'il la rende). */
export function setControlHandbackSeconds(tenantId: string, seconds: number | null): Promise<{ controlHandbackSeconds: number | null }> {
  return request(`/tenants/${tenantId}/settings/control-handback`, { method: 'PATCH', body: JSON.stringify({ seconds }) });
}

/** Défaut du tenant pour la destination de reprise (C.4). `resume` | `inbox` | null (repli usine `resume`). */

/** Fuseau IANA du tenant (base des conditions temporelles : NOW, jour de semaine, heures d'ouverture). */
export function setTimezone(tenantId: string, timezone: string): Promise<{ timezone: string }> {
  return request(`/tenants/${tenantId}/settings/timezone`, { method: 'PATCH', body: JSON.stringify({ timezone }) });
}
/** Heures d'ouverture par jour (corps `{ '0'..'6': { closed, open 'HH:MM', close 'HH:MM' } }`, 7 jours requis). */
export function setBusinessHours(tenantId: string, businessHours: BusinessHours): Promise<{ businessHours: BusinessHours }> {
  return request(`/tenants/${tenantId}/settings/business-hours`, { method: 'PATCH', body: JSON.stringify({ businessHours }) });
}

// --- Accueil : profil courant + statut compte WhatsApp ---

export interface MeResponse {
  email: string;
  name: string | null;
  role: string;
}
export function getMe(tenantId: string): Promise<MeResponse> {
  return request<MeResponse>(`/tenants/${tenantId}/me`);
}

export type AccountDot = 'green' | 'amber' | 'red' | 'grey';
export interface AccountStatusResponse {
  hasNumber: boolean;
  /** Id Meta du numéro principal (requis pour le PATCH du toggle HubSpot). */
  phoneNumberId: string | null;
  number: string | null;
  tier: string | null;
  quality: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  numberStatus: string | null;
  nameStatus: string | null;
  codeVerificationStatus: string | null;
  throughputLevel: string | null;
  verifiedName: string | null;
  wabaHealthStatus: string | null;
  accountReviewStatus: string | null;
  businessVerificationStatus: string | null;
  /** Onboarding API MM Lite (marketing_messages_lite_api_status). null = non communiqué par Meta. */
  marketingMessagesLiteApiStatus: string | null;
  /** Business propriétaire du WABA (owner_business_info.name). null = inconnu. */
  ownerBusinessName: string | null;
  hubspotConnected: boolean;
  /** Instant de pause de la synchro (F3-a). null = jamais activé OU actif ; non-null + hubspotConnected=false = en pause. */
  hubspotPausedAt: string | null;
  /** Portail HubSpot lié au tenant (mmhs.tenant_portals). connected=false -> proposer « Connecter HubSpot ».
   *  listsScopeGranted -> le portail a accordé crm.lists.read (import de listes sans re-consentement). */
  hubspotPortal: { connected: boolean; hubId?: string; hubDomain?: string | null; listsScopeGranted?: boolean };
  status: { dot: AccountDot; label: string; reason: string };
}
export function getAccountStatus(tenantId: string): Promise<AccountStatusResponse> {
  return request<AccountStatusResponse>(`/tenants/${tenantId}/account-status`);
}
/** Active/coupe/pause la synchro HubSpot d'un numéro (toggle admin). `catchupTriggered` = true si on vient de
 *  reprendre après une pause (le rattrapage des analyses accumulées est en cours côté worker). */
export function setHubspotConnected(tenantId: string, phoneNumberId: string, connected: boolean): Promise<{ phoneNumberId: string; hubspotConnected: boolean; catchupTriggered: boolean }> {
  return request(`/tenants/${tenantId}/phone-numbers/${encodeURIComponent(phoneNumberId)}/hubspot`, {
    method: 'PATCH',
    body: JSON.stringify({ connected }),
  });
}
/** Déconnexion COMPLÈTE (candidat 2) : délie le portail HubSpot du tenant (le connecteur révoque le token si dernier
 *  tenant) et coupe la synchro de TOUS les numéros du tenant. `disconnected:false` = déjà délié (succès idempotent). */
export function disconnectHubspot(tenantId: string, phoneNumberId: string): Promise<{ phoneNumberId: string; hubspotConnected: boolean; disconnected: boolean }> {
  return request(`/tenants/${tenantId}/phone-numbers/${encodeURIComponent(phoneNumberId)}/hubspot`, {
    method: 'PATCH',
    body: JSON.stringify({ connected: false, action: 'disconnect' }),
  });
}

// --- Import de listes HubSpot (3e source de campagne) ---

export interface HubspotList { listId: string; name: string; size: number | null; processingType: string }
/**
 * Réponse du GET /hubspot/lists : `available:false` si le toggle est OFF (sans reason) OU si la synchro est en pause
 * (`reason:'paused'`, F3-b) ; sinon lists (ou re-consentement requis).
 */
export interface HubspotListsResult {
  available: boolean;
  reason?: 'reconsent_required' | 'paused';
  reconsentUrl?: string;
  lists?: HubspotList[];
}
export function listHubspotLists(tenantId: string, query?: string): Promise<HubspotListsResult> {
  const qs = query ? `?query=${encodeURIComponent(query)}` : '';
  return request<HubspotListsResult>(`/tenants/${tenantId}/hubspot/lists${qs}`);
}
/** Une étape de deal du portail. `closed` = étape de fin (gagné/perdu), signalée à l'écran. */
export interface HubspotDealStage { id: string; label: string; closed: boolean }
export interface HubspotDealPipeline { id: string; label: string; stages: HubspotDealStage[] }
/**
 * Pipelines du portail avec les libellés de leurs étapes, pour régler une automation « étape de deal » sans
 * aller recopier un identifiant opaque dans HubSpot. `connected:false` = aucun portail lié (pas une erreur).
 */
export function listHubspotDealStages(tenantId: string): Promise<{ connected: boolean; pipelines: HubspotDealPipeline[] }> {
  return request(`/tenants/${tenantId}/hubspot/deal-stages`);
}

/**
 * Crée UN contact à la main (le mini-CRM ne savait le faire que par import CSV). `status` dit si le contact a
 * été créé ou si un contact portant ce numéro EXISTAIT déjà et a été mis à jour : l'écran ne doit pas annoncer
 * une création dans le second cas.
 */
export function createContact(
  tenantId: string,
  input: { phone: string; name?: string; fields?: Record<string, string>; tags?: string[]; optIn?: boolean; bsuid?: string },
): Promise<{ status: 'created' | 'updated'; contactId?: string }> {
  return request(`/tenants/${tenantId}/contacts`, { method: 'POST', body: JSON.stringify(input) });
}

/** Importe une liste HubSpot comme contacts (opt-in jamais activé, tag « HubSpot: <nom> »). `tags` = tag(s)
 *  réellement posé(s) par le serveur (source de vérité pour filtrer les contacts importés). */
export function importHubspotList(tenantId: string, listId: string, listName: string): Promise<ImportReport & { truncated: boolean; skippedNoPhone: number; tags: string[] }> {
  return request(`/tenants/${tenantId}/hubspot/import`, { method: 'POST', body: JSON.stringify({ listId, listName }) });
}

// --- Surface d'exploitation cross-tenant (/ops) : token SÉPARÉ (x-ops-token), PAS la session JWT ---

export interface TenantOverviewRow {
  id: string;
  name: string;
  createdAt: string;
  mbaEnabled: boolean;
  users: number;
  contacts: number;
  messages: number;
  templatesUsed: number;
  lastSendAt: string | null;
  phone: string | null;
  phoneStatus: string | null;
  quality: string | null;
}
export interface QueueLoadRow {
  queue: string;
  backlog: number;
  active: number;
  failed: number;
}
/** Signal de vie du worker (item 4.9). null = aucun battement (worker jamais démarré, ou table absente avant
 *  migration 0044). `ageSeconds` élevé = worker probablement mort (crash-loop invisible côté mba-api). */
export interface WorkerHeartbeat {
  beatAt: string;
  bootedAt: string | null;
  instance: string | null;
  ageSeconds: number;
}
export interface OpsOverview {
  tenants: TenantOverviewRow[];
  daily: DailyPoint[];
  queues: QueueLoadRow[];
  /** Peut être absent d'une réponse antérieure au 4.9 -> traité comme null côté page. */
  worker: WorkerHeartbeat | null;
}

/**
 * Appel dédié à /ops : n'utilise NI getSession NI clearSession (un 401 ops ne doit pas déconnecter la
 * console admin), pose seulement `x-ops-token`. Le token est saisi par l'ops et gardé en localStorage.
 */
export async function getOpsOverview(opsToken: string): Promise<OpsOverview> {
  const res = await fetch(`${BASE}/ops/overview`, { headers: { 'x-ops-token': opsToken } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Erreur ${res.status}`);
  }
  return res.json() as Promise<OpsOverview>;
}

// --- Support (formulaire de contact -> email Resend) ---

/** Le reply-to n'est PAS envoye par le client : le serveur le resout depuis le compte authentifie. */
export function sendSupportMessage(tenantId: string, input: { subject: string; message: string }): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/tenants/${tenantId}/support`, { method: 'POST', body: JSON.stringify(input) });
}

// --- Admin (gestion des comptes) ---

export type UserRole = 'admin' | 'agent';
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  /** Code public « usr_<client>_<ulid> » (schéma A). Absent tant que le backfill n'a pas tourné. */
  code?: string | null;
  /** true = compte révoqué (login bloqué). */
  disabled: boolean;
  /** true = invitation en attente (mot de passe pas encore choisi). */
  pending: boolean;
  createdAt: string;
  /** Dernière connexion réussie (ISO). null = jamais connecté depuis la mise en place du suivi (migration
   *  0037) : on affiche « jamais », on ne retombe PAS sur `createdAt` qui mentirait. */
  lastLoginAt: string | null;
}
export function listUsers(tenantId: string): Promise<{ users: AdminUser[] }> {
  return request<{ users: AdminUser[] }>(`/tenants/${tenantId}/users`);
}
/** Invite un membre (crée un compte en attente + envoie un lien pour choisir son mot de passe). */
export function inviteMember(tenantId: string, email: string, role: UserRole): Promise<{ user: AdminUser; emailSent: boolean }> {
  return request(`/tenants/${tenantId}/invitations`, { method: 'POST', body: JSON.stringify({ email, role }) });
}
/** Accepte une invitation : pose le mot de passe et connecte (renvoie une session comme le login). */
export function acceptInvitation(token: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/invitations/accept', { method: 'POST', body: JSON.stringify({ token, password }) });
}
export function setUserRole(tenantId: string, userId: string, role: UserRole): Promise<{ id: string; role: UserRole }> {
  return request(`/tenants/${tenantId}/users/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
}
export function setUserDisabled(tenantId: string, userId: string, disabled: boolean): Promise<{ id: string; disabled: boolean }> {
  return request(`/tenants/${tenantId}/users/${userId}/disabled`, { method: 'PATCH', body: JSON.stringify({ disabled }) });
}
export function deleteUser(tenantId: string, userId: string): Promise<{ id: string; deleted: boolean }> {
  return request(`/tenants/${tenantId}/users/${userId}`, { method: 'DELETE' });
}

// --- Flows (constructeur de formulaire RICHE : texte / image / champ) ---

export type FlowFieldType =
  | 'text' | 'email' | 'phone' | 'number' | 'passcode'
  | 'textarea' | 'date'
  | 'dropdown' | 'radio' | 'checkbox' | 'optin';
export type FlowTextKind = 'heading' | 'subheading' | 'body' | 'caption';
/** Types de champ qui exigent une liste d'options (dropdown/radio/checkbox). */
export const FLOW_CHOICE_TYPES: FlowFieldType[] = ['dropdown', 'radio', 'checkbox'];

/** Condition de visibilité ENVOYÉE : `field` = LIBELLÉ du champ source (le serveur résout libellé -> clé).
 *  Source admissible : champ dropdown/radio/optin situé AVANT l'élément sur le MÊME écran. */
export interface FlowVisibleIfInput {
  field: string;
  op: 'eq' | 'neq';
  value: string | boolean;
}
/** Condition de visibilité STOCKÉE : `fieldKey` = clé dérivée du champ source (pour re-seeder l'édition). */
export interface FlowVisibleIf {
  fieldKey: string;
  op: 'eq' | 'neq';
  value: string | boolean;
}
/** Élément riche envoyé à la création d'un flow, dans l'ordre. `saveTo` (sur un champ) : clé du user field
 *  cible ; absent -> le serveur crée un user field d'après le libellé (mapping par défaut). `options` :
 *  requis pour les champs de choix (dropdown/radio/checkbox). `visibleIf` : affichage conditionnel. */
export type FlowElementInput =
  | { kind: FlowTextKind; text: string; visibleIf?: FlowVisibleIfInput }
  | { kind: 'image'; src: string; visibleIf?: FlowVisibleIfInput }
  | { kind: 'field'; label: string; type: FlowFieldType; required: boolean; saveTo?: string; options?: string[]; visibleIf?: FlowVisibleIfInput };

export interface FlowField {
  label: string;
  type: FlowFieldType;
  required: boolean;
  key: string;
}
/** Élément riche STOCKÉ (les champs portent leur clé dérivée) — sert à pré-remplir l'édition. */
export type FlowElement =
  | { kind: FlowTextKind; text: string; visibleIf?: FlowVisibleIf }
  | { kind: 'image'; src: string; visibleIf?: FlowVisibleIf }
  | { kind: 'field'; label: string; type: FlowFieldType; required: boolean; key: string; options?: string[]; visibleIf?: FlowVisibleIf };
/** Écran STOCKÉ (le serveur normalise : un flow mono-écran historique arrive comme [{ elements }]).
 *  `cta` = bouton « Continuer » d'un écran intermédiaire ; le DERNIER écran porte le cta global du flow. */
export interface FlowScreen {
  title?: string;
  cta?: string;
  elements: FlowElement[];
}
/** Écran ENVOYÉ à la création/édition (1 à 10 écrans, chaque écran >= 1 élément). */
export interface FlowScreenInput {
  title?: string;
  cta?: string;
  elements: FlowElementInput[];
}
export interface FlowSummary {
  id: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED';
  /** Champs dérivés (kind='field') — pour l'aperçu de la liste. */
  fields: FlowField[];
  /** Écrans riches (null pour les flows antérieurs au modèle) : aperçu détaillé + pré-remplissage de l'édition. */
  screens?: FlowScreen[] | null;
  /** Mapping clé champ -> clé user field, pour restaurer le « enregistrer dans » à l'édition. */
  mapping?: Record<string, string> | null;
  /** Libellé du bouton final (Footer du dernier écran) : null/absent = défaut « Envoyer ». */
  cta?: string | null;
  createdAt: string;
}
export function listFlows(tenantId: string): Promise<{ flows: FlowSummary[] }> {
  return request<{ flows: FlowSummary[] }>(`/tenants/${tenantId}/flows`);
}
export function createFlow(tenantId: string, input: { name: string; screens: FlowScreenInput[]; cta?: string }): Promise<{ id: string; status: string; name: string; fields: FlowField[] }> {
  return request(`/tenants/${tenantId}/flows`, { method: 'POST', body: JSON.stringify(input) });
}
/** Édite un flow DRAFT (réécrit le flow_json). 409 si le flow est PUBLISHED (immuable). */
export function updateFlow(tenantId: string, flowId: string, input: { name: string; screens: FlowScreenInput[]; cta?: string }): Promise<{ id: string; status: string; name: string; fields: FlowField[] }> {
  return request(`/tenants/${tenantId}/flows/${flowId}`, { method: 'PATCH', body: JSON.stringify(input) });
}
/** « Dupliquer pour modifier » : clone un flow (publié ou draft) en un nouveau DRAFT éditable. */
export function duplicateFlow(tenantId: string, flowId: string): Promise<{ id: string; status: string; name: string; fields: FlowField[] }> {
  return request(`/tenants/${tenantId}/flows/${flowId}/duplicate`, { method: 'POST' });
}
export function publishFlow(tenantId: string, flowId: string): Promise<{ id: string; status: string }> {
  return request(`/tenants/${tenantId}/flows/${flowId}/publish`, { method: 'POST' });
}
/** Supprime un formulaire : un DRAFT est supprimé, un PUBLISHED est déprécié côté Meta (immuable). */
export function deleteFlow(tenantId: string, flowId: string): Promise<{ id: string; deleted: boolean }> {
  return request(`/tenants/${tenantId}/flows/${flowId}`, { method: 'DELETE' });
}

// --- Workflows (bot builder : graphe de blocs) ---

// `rcs_message` : envoi sur le canal RCS, DEUX sorties ('sent' / 'unreachable') -> permet de brancher un
// repli WhatsApp sur les contacts que le RCS n'atteint pas.
// `email` : envoi via une boîte SMTP connectée (node « Envoi de mail »). Action SYNCHRONE best-effort (un
// échec est journalisé côté serveur, jamais bloquant) -> une seule sortie, comme tag/field/action.
export type WorkflowNodeType = 'template' | 'quick_message' | 'inbox' | 'flow' | 'tag' | 'field' | 'condition' | 'action' | 'wait' | 'mba_handoff' | 'mba_disable' | 'rcs_message' | 'email';
export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}
export interface WorkflowSummary {
  id: string;
  name: string;
  /** Code public « scn_<client>_<ulid> » (schéma A). Absent tant que le backfill n'a pas tourné. */
  code?: string | null;
  graph: WorkflowGraph;
  createdAt: string;
  updatedAt: string;
}
export function listWorkflows(tenantId: string): Promise<{ workflows: WorkflowSummary[] }> {
  return request<{ workflows: WorkflowSummary[] }>(`/tenants/${tenantId}/workflows`);
}
export function createWorkflow(tenantId: string, name: string, graph?: WorkflowGraph): Promise<{ id: string; name: string; graph: WorkflowGraph }> {
  return request(`/tenants/${tenantId}/workflows`, { method: 'POST', body: JSON.stringify({ name, ...(graph ? { graph } : {}) }) });
}
export function getWorkflow(tenantId: string, id: string): Promise<{ workflow: WorkflowSummary }> {
  return request<{ workflow: WorkflowSummary }>(`/tenants/${tenantId}/workflows/${id}`);
}
export function updateWorkflow(tenantId: string, id: string, patch: { name?: string; graph?: WorkflowGraph }, opts?: { keepalive?: boolean }): Promise<unknown> {
  // `keepalive` : la requête survit au déchargement de la page (flush auto-save sur beforeunload / fermeture d'onglet).
  return request(`/tenants/${tenantId}/workflows/${id}`, { method: 'PATCH', body: JSON.stringify(patch), ...(opts?.keepalive ? { keepalive: true } : {}) });
}
export function deleteWorkflow(tenantId: string, id: string): Promise<unknown> {
  return request(`/tenants/${tenantId}/workflows/${id}`, { method: 'DELETE' });
}
/** Duplique un scénario (nom « X (copie) », graphe cloné avec codes de node frais). Renvoie le nouveau scénario. */
export function duplicateWorkflow(tenantId: string, id: string): Promise<{ id: string; name: string; graph: WorkflowGraph }> {
  return request(`/tenants/${tenantId}/workflows/${id}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
}

/** Un bloc (node) aplati depuis les scénarios, pour la page Contenu > Blocs. `code` = nod_... ou null. */
export interface NodeListItem {
  code: string | null;
  type: WorkflowNodeType;
  /** Nom libre du bloc (data.name), vide si non renseigné. */
  name: string;
  workflowId: string;
  workflowName: string;
  summary: string;
}
/** Liste tous les blocs des scénarios du tenant, optionnellement filtrés par type. */
export function listNodes(tenantId: string, type?: WorkflowNodeType): Promise<{ nodes: NodeListItem[] }> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : '';
  return request<{ nodes: NodeListItem[] }>(`/tenants/${tenantId}/nodes${qs}`);
}

// --- Contenu : Tags + User fields (édition) ---

export interface TagCount {
  tag: string;
  count: number;
  /** Code public « tag_<client>_<ulid> » (schéma A). null pour un tag utilisé mais jamais déclaré, ou avant backfill. */
  code?: string | null;
}
export function listTags(tenantId: string): Promise<{ tags: TagCount[] }> {
  return request<{ tags: TagCount[] }>(`/tenants/${tenantId}/tags`);
}
export function createTag(tenantId: string, name: string): Promise<{ name: string; created: boolean }> {
  return request(`/tenants/${tenantId}/tags`, { method: 'POST', body: JSON.stringify({ name }) });
}
export function renameTag(tenantId: string, from: string, to: string): Promise<{ renamed: number }> {
  return request(`/tenants/${tenantId}/tags`, { method: 'PATCH', body: JSON.stringify({ from, to }) });
}
export function deleteTag(tenantId: string, tag: string): Promise<{ removed: number }> {
  return request(`/tenants/${tenantId}/tags?tag=${encodeURIComponent(tag)}`, { method: 'DELETE' });
}

// --- Clés d'API (surface publique /v1) ---

/** Scopes reconnus. Doit rester aligné sur `VALID_API_SCOPES` du serveur (`src/http/api-keys.ts`). */
export const API_SCOPES = ['contacts:write', 'sends:create'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  /** Dernier appel authentifié par cette clé. null = jamais utilisée. */
  lastUsedAt: string | null;
  /** Instant de révocation. Non null = la clé ne peut plus rien : la ligne RESTE dans la liste. */
  revokedAt: string | null;
}
/** Réponse de création. `key` est la clé EN CLAIR, renvoyée UNE SEULE FOIS et jamais re-consultable. */
export interface ApiKeyCreated {
  id: string;
  key: string;
  name: string;
  scopes: string[];
}

export function listApiKeys(tenantId: string): Promise<{ keys: ApiKeyRow[] }> {
  return request<{ keys: ApiKeyRow[] }>(`/tenants/${tenantId}/api-keys`);
}
export function createApiKey(tenantId: string, name: string, scopes: string[]): Promise<ApiKeyCreated> {
  return request(`/tenants/${tenantId}/api-keys`, { method: 'POST', body: JSON.stringify({ name, scopes }) });
}
/** Révoque une clé. Elle reste listée, avec `revokedAt` renseigné : ce n'est pas une suppression. */
export function revokeApiKey(tenantId: string, id: string): Promise<{ id: string; revoked: boolean }> {
  return request(`/tenants/${tenantId}/api-keys/${id}`, { method: 'DELETE' });
}

// Types de champ perso : source runtime `USER_FIELD_KINDS` + type dérivé, dans `./field-kinds` (module PUR).
// Ré-exportés ici pour ne pas casser les imports existants (`import { UserFieldKind } from '@/lib/api'`).
export { USER_FIELD_KINDS } from './field-kinds';
export type { UserFieldKind } from './field-kinds';
export interface UserFieldDef {
  key: string;
  label: string;
  type: UserFieldKind;
  /** Code public « fld_<client>_<ulid> » (schéma A). Absent tant que le backfill n'a pas tourné. */
  code?: string | null;
}
export function listUserFields(tenantId: string): Promise<{ fields: UserFieldDef[]; tenantCode?: string }> {
  return request<{ fields: UserFieldDef[]; tenantCode?: string }>(`/tenants/${tenantId}/user-fields`);
}
export function createUserField(tenantId: string, input: { label: string; type: UserFieldKind }): Promise<UserFieldDef> {
  return request<UserFieldDef>(`/tenants/${tenantId}/user-fields`, { method: 'POST', body: JSON.stringify(input) });
}
export function updateUserField(tenantId: string, key: string, patch: { label?: string; type?: UserFieldKind }): Promise<unknown> {
  return request(`/tenants/${tenantId}/user-fields/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteUserField(tenantId: string, key: string): Promise<unknown> {
  return request(`/tenants/${tenantId}/user-fields/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

/** Embedded Signup Meta (connexion du numéro WhatsApp, Tech Provider). */
export interface EsConfig {
  enabled: boolean;
  appId: string;
  configId: string;
  graphVersion: string;
}
export function getEsConfig(tenantId: string): Promise<EsConfig> {
  return request<EsConfig>(`/tenants/${tenantId}/embedded-signup/config`);
}
export interface EsCompleteResult {
  connected: boolean;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  warnings?: string[];
}
/** `wabaId`/`phoneNumberId` FACULTATIFS : la popup ne les annonce pas sur un parcours déjà abouti chez Meta,
 *  le serveur les retrouve alors depuis le token (sinon le client resterait bloqué sans recours). */
export function completeEmbeddedSignup(
  tenantId: string,
  input: { code: string; wabaId?: string; phoneNumberId?: string },
): Promise<EsCompleteResult> {
  return request<EsCompleteResult>(`/tenants/${tenantId}/embedded-signup/complete`, { method: 'POST', body: JSON.stringify(input) });
}

// --- Automations (Lot E : déclencher un scénario sur un événement) ---

/** Types de déclencheur proposés à la création. Miroir de `AUTOMATION_TRIGGER_KINDS` serveur. */
export type AutomationTriggerKind = 'keyword' | 'new_contact' | 'tag_added' | 'conversation_analyzed' | 'hubspot_deal_stage';

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  triggerKind: AutomationTriggerKind;
  triggerConfig: Record<string, unknown>;
  conditionGroup: { match: 'all' | 'any'; clauses: unknown[] } | null;
  workflowId: string;
  startNodeId: string | null;
  /** null = anti-rebond par défaut du service. 0 = aucun garde-fou. */
  cooldownSeconds: number | null;
}

export interface AutomationInput {
  name: string;
  triggerKind: AutomationTriggerKind;
  triggerConfig: Record<string, unknown>;
  workflowId: string;
  enabled?: boolean;
  conditionGroup?: unknown;
  startNodeId?: string | null;
  cooldownSeconds?: number | null;
}

export function listAutomations(tenantId: string): Promise<{ automations: Automation[] }> {
  return request(`/tenants/${tenantId}/automations`);
}
export function createAutomation(tenantId: string, input: AutomationInput): Promise<{ id: string }> {
  return request(`/tenants/${tenantId}/automations`, { method: 'POST', body: JSON.stringify(input) });
}
export function updateAutomation(tenantId: string, id: string, patch: Partial<AutomationInput>): Promise<{ id: string }> {
  return request(`/tenants/${tenantId}/automations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteAutomation(tenantId: string, id: string): Promise<void> {
  return request(`/tenants/${tenantId}/automations/${id}`, { method: 'DELETE' });
}

/** Lien de test d'un scénario (Lot F) : jeton stable + lien wa.me pré-rempli. `link` null = aucun numéro connecté. */
export interface WorkflowTestLink { token: string; phone: string | null; link: string | null }
export function createWorkflowTestLink(tenantId: string, workflowId: string): Promise<WorkflowTestLink> {
  return request(`/tenants/${tenantId}/workflows/${workflowId}/test-link`, { method: 'POST' });
}

// --- Email : boîtes SMTP du node « Envoi de mail » (Compte > Boîtes email, admin-only) ---

export interface EmailAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  /** Dernier test d'envoi réussi (ISO). null = jamais testée. */
  verifiedAt: string | null;
  createdAt: string;
  /** Toujours `true` : le mot de passe n'est JAMAIS renvoyé par le serveur, ce booléen dit juste qu'il est défini. */
  hasPassword: true;
}
export interface EmailAccountInput {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName?: string | null;
  replyTo?: string | null;
}
export function listEmailAccounts(tenantId: string): Promise<{ accounts: EmailAccount[] }> {
  return request<{ accounts: EmailAccount[] }>(`/tenants/${tenantId}/email/accounts`);
}
export function createEmailAccount(tenantId: string, input: EmailAccountInput): Promise<EmailAccount> {
  return request<EmailAccount>(`/tenants/${tenantId}/email/accounts`, { method: 'POST', body: JSON.stringify(input) });
}
/** Édition : le mot de passe n'est re-chiffré que si `password` est fourni (l'omettre le laisse inchangé). */
export function updateEmailAccount(tenantId: string, id: string, patch: Partial<EmailAccountInput>): Promise<EmailAccount> {
  return request<EmailAccount>(`/tenants/${tenantId}/email/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteEmailAccount(tenantId: string, id: string): Promise<{ ok: true }> {
  return request(`/tenants/${tenantId}/email/accounts/${id}`, { method: 'DELETE' });
}
/** Envoie un email de test via cette boîte. Un échec SMTP répond 422 : `request()` le transforme en `ApiError`
 *  (message = celui du serveur), il n'y a donc jamais de branche `{ ok:false }` à lire ici, uniquement un rejet. */
export function testEmailAccount(tenantId: string, id: string, to: string): Promise<{ ok: true }> {
  return request(`/tenants/${tenantId}/email/accounts/${id}/test`, { method: 'POST', body: JSON.stringify({ to }) });
}

// --- Email : modèles (Contenu > Modèles d'email) ---

export type EmailTemplateFormat = 'basic' | 'html';
export interface EmailTemplate {
  id: string;
  name: string;
  format: EmailTemplateFormat;
  subject: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
export interface EmailTemplateInput {
  name: string;
  format: EmailTemplateFormat;
  subject: string;
  body: string;
}
export function listEmailTemplates(tenantId: string): Promise<{ templates: EmailTemplate[] }> {
  return request<{ templates: EmailTemplate[] }>(`/tenants/${tenantId}/email/templates`);
}
export function createEmailTemplate(tenantId: string, input: EmailTemplateInput): Promise<EmailTemplate> {
  return request<EmailTemplate>(`/tenants/${tenantId}/email/templates`, { method: 'POST', body: JSON.stringify(input) });
}
export function updateEmailTemplate(tenantId: string, id: string, patch: Partial<EmailTemplateInput>): Promise<EmailTemplate> {
  return request<EmailTemplate>(`/tenants/${tenantId}/email/templates/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteEmailTemplate(tenantId: string, id: string): Promise<{ ok: true }> {
  return request(`/tenants/${tenantId}/email/templates/${id}`, { method: 'DELETE' });
}
