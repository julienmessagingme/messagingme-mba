'use client';

import { getSession, clearSession } from './session';

const BASE = '/api/backend';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Un 5xx sur une LECTURE est très majoritairement transitoire (pool Postgres saturé une fraction de seconde,
 * conteneur qui vient de redémarrer). Une seule reprise, après une courte pause, évite d'infliger un écran
 * d'erreur pour un hoquet. On ne rejoue QUE les requêtes idempotentes : rejouer un POST enverrait des messages
 * WhatsApp en double, ce qu'aucun gain d'ergonomie ne justifie.
 */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD']);
const RETRY_DELAY_MS = 400;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const canRetry = RETRYABLE_METHODS.has(method);
  try {
    return await attempt<T>(path, init);
  } catch (err) {
    const transient = err instanceof ApiError ? err.status >= 500 : true; // panne réseau -> pas d'ApiError
    if (!canRetry || !transient) throw err;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return attempt<T>(path, init);
  }
}

async function attempt<T>(path: string, init: RequestInit): Promise<T> {
  const session = getSession();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (session) headers.set('authorization', `Bearer ${session.token}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, 'Session expirée, reconnecte-toi.');
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Erreur ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

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
  patch: { fields?: Record<string, string>; removeFields?: string[]; addTags?: string[]; removeTags?: string[]; profileName?: string | null },
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

/** Un filtre sur la valeur d'un champ perso (jsonb, valeur texte) : égalité exacte ou sous-chaîne. */
export interface ContactFieldFilter { key: string; op: 'eq' | 'contains'; value: string }

/** Critères composables de la « Liste de contacts » (source de campagne). Tous optionnels. */
export interface ContactFilters {
  tags?: string[];
  tagMode?: 'and' | 'or';
  optIn?: 'opted_in' | 'opted_out' | 'unknown';
  phonePrefix?: string;
  phoneContains?: string;
  nameSearch?: string;
  fieldFilters?: ContactFieldFilter[];
}

/** Encode des ContactFilters en query string (miroir de parseFilters côté serveur). */
function filtersToQuery(f: ContactFilters): URLSearchParams {
  const qs = new URLSearchParams();
  if (f.tags && f.tags.length > 0) qs.set('tags', f.tags.join(','));
  if (f.tagMode === 'or') qs.set('tagMode', 'or');
  if (f.optIn) qs.set('optIn', f.optIn);
  if (f.phonePrefix) qs.set('phonePrefix', f.phonePrefix);
  if (f.phoneContains) qs.set('phoneContains', f.phoneContains);
  if (f.nameSearch) qs.set('nameSearch', f.nameSearch);
  if (f.fieldFilters && f.fieldFilters.length > 0) qs.set('fields', JSON.stringify(f.fieldFilters));
  return qs;
}

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
  templateName: string;
  templateLanguage: string;
  createdAt: string;
  /** Instant de lancement programmé (ISO UTC) quand status = 'scheduled'. null sinon. */
  scheduledAt: string | null;
  /** Instant d'archivage (ISO UTC). null = campagne active. Indépendant du statut. */
  archivedAt: string | null;
  counts: RecipientCounts;
}
export interface CampaignRecipient {
  id: string;
  toE164: string;
  status: string;
  messageId: string | null;
  error: string | null;
  sentAt: string | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
}
export interface CampaignDetail extends CampaignSummary {
  recipients: CampaignRecipient[];
}
export interface PhoneNumber {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
}
export interface ParamSource {
  type: 'attribute' | 'field' | 'literal';
  key?: string;
  value?: string;
}
export interface TemplateParam {
  position: number;
  source: ParamSource;
}
export interface CreateCampaignInput {
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
}

/** Campagnes actives par défaut ; `archived: true` renvoie la corbeille (les deux ensembles sont disjoints). */
export function listCampaigns(tenantId: string, opts?: { archived?: boolean }): Promise<{ campaigns: CampaignSummary[] }> {
  return request<{ campaigns: CampaignSummary[] }>(`/tenants/${tenantId}/campaigns${opts?.archived ? '?archived=1' : ''}`);
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
  skipped: Array<{ contactId: string; toE164: string; reason: string; missing: number[] }>;
}
export function createCampaign(tenantId: string, input: CreateCampaignInput): Promise<CampaignCreated> {
  return request(`/tenants/${tenantId}/campaigns`, { method: 'POST', body: JSON.stringify(input) });
}
/** Lance une campagne : maintenant (sans `scheduledAt`) ou à une date future (ISO UTC absolu -> programmée). */
export function runCampaign(campaignId: string, scheduledAt?: string): Promise<{ enqueued?: boolean; scheduled?: boolean; scheduledAt?: string }> {
  return request(`/campaigns/${campaignId}/run`, { method: 'POST', ...(scheduledAt ? { body: JSON.stringify({ scheduledAt }) } : {}) });
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
  /** true = carousel : édition non supportée (header_handle non récupérable). */
  isCarousel?: boolean;
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

export interface Conversation {
  id: string;
  waId: string;
  profileName: string | null;
  lastPreview: string | null;
  lastMessageAt: string;
  controlOwner: ControlOwner;
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
}
export function listConversations(tenantId: string): Promise<{ conversations: Conversation[] }> {
  return request<{ conversations: Conversation[] }>(`/tenants/${tenantId}/conversations`);
}
export interface ConversationThread {
  waId: string;
  windowOpen: boolean;
  lastInboundAt: string | null;
  controlOwner: ControlOwner;
  messages: InboxMessage[];
}
export function getConversationMessages(tenantId: string, conversationId: string): Promise<ConversationThread> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/messages`);
}
/** L'opérateur rend la main : le scénario (ou l'agent de Meta) reprend la conversation. */
export function releaseConversation(tenantId: string, conversationId: string): Promise<{ controlOwner: ControlOwner }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/release`, { method: 'POST' });
}
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
export function getCostSeries(tenantId: string, range?: StatsRange, filter?: { campaignId?: string; templateName?: string }): Promise<CostSeries> {
  const parts: string[] = [];
  if (filter?.campaignId) parts.push(`campaignId=${encodeURIComponent(filter.campaignId)}`);
  if (filter?.templateName) parts.push(`templateName=${encodeURIComponent(filter.templateName)}`);
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

export interface TenantSettings {
  /** Durée du gel après prise de main par un opérateur, en secondes. null = défaut du serveur. */
  controlHandbackSeconds: number | null;
  mbaEnabled: boolean;
  hubspotListsEnabled: boolean;
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

/** Durée du gel après qu'un opérateur a pris la main, en secondes. null = défaut du serveur, 0 = jamais
 *  de reprise automatique (l'opérateur garde la main jusqu'à ce qu'il la rende). */
export function setControlHandbackSeconds(tenantId: string, seconds: number | null): Promise<{ controlHandbackSeconds: number | null }> {
  return request(`/tenants/${tenantId}/settings/control-handback`, { method: 'PATCH', body: JSON.stringify({ seconds }) });
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
  hubspotConnected: boolean;
  /** Portail HubSpot lié au tenant (mmhs.tenant_portals). connected=false -> proposer « Connecter HubSpot ».
   *  listsScopeGranted -> le portail a accordé crm.lists.read (import de listes sans re-consentement). */
  hubspotPortal: { connected: boolean; hubId?: string; hubDomain?: string | null; listsScopeGranted?: boolean };
  status: { dot: AccountDot; label: string; reason: string };
}
export function getAccountStatus(tenantId: string): Promise<AccountStatusResponse> {
  return request<AccountStatusResponse>(`/tenants/${tenantId}/account-status`);
}
/** Active/coupe la synchro HubSpot d'un numéro (toggle admin). Coupe/active vraiment le push d'analyse. */
export function setHubspotConnected(tenantId: string, phoneNumberId: string, connected: boolean): Promise<{ phoneNumberId: string; hubspotConnected: boolean }> {
  return request(`/tenants/${tenantId}/phone-numbers/${encodeURIComponent(phoneNumberId)}/hubspot`, {
    method: 'PATCH',
    body: JSON.stringify({ connected }),
  });
}

// --- Import de listes HubSpot (3e source de campagne) ---

export interface HubspotList { listId: string; name: string; size: number | null; processingType: string }
/** Réponse du GET /hubspot/lists : `available:false` si le toggle est OFF ; sinon lists (ou re-consentement requis). */
export interface HubspotListsResult {
  available: boolean;
  reason?: 'reconsent_required';
  reconsentUrl?: string;
  lists?: HubspotList[];
}
export function listHubspotLists(tenantId: string, query?: string): Promise<HubspotListsResult> {
  const qs = query ? `?query=${encodeURIComponent(query)}` : '';
  return request<HubspotListsResult>(`/tenants/${tenantId}/hubspot/lists${qs}`);
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
export interface OpsOverview {
  tenants: TenantOverviewRow[];
  daily: DailyPoint[];
  queues: QueueLoadRow[];
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

export type WorkflowNodeType = 'template' | 'quick_message' | 'inbox' | 'flow' | 'tag' | 'field';
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

/** Un bloc (node) aplati depuis les scénarios, pour la page Contenu > Blocs. `code` = nod_... ou null. */
export interface NodeListItem {
  code: string | null;
  type: WorkflowNodeType;
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

export type UserFieldKind = 'text' | 'number' | 'date' | 'boolean' | 'url';
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
export function completeEmbeddedSignup(
  tenantId: string,
  input: { code: string; wabaId: string; phoneNumberId: string },
): Promise<EsCompleteResult> {
  return request<EsCompleteResult>(`/tenants/${tenantId}/embedded-signup/complete`, { method: 'POST', body: JSON.stringify(input) });
}
