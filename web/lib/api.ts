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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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

export interface Contact {
  id: string;
  phoneE164: string | null;
  profileName: string | null;
  optInStatus: string;
  fields: Record<string, unknown>;
  tags: string[];
  createdAt: string;
}
export function listContacts(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<{ contacts: Contact[] }> {
  const qs = new URLSearchParams();
  if (opts?.limit != null) qs.set('limit', String(opts.limit));
  if (opts?.offset != null) qs.set('offset', String(opts.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<{ contacts: Contact[] }>(`/tenants/${tenantId}/contacts${suffix}`);
}

/** Édite un contact (fiche) : ajoute/met à jour des valeurs de user fields + affecte/retire des tags.
 *  MERGE côté serveur (n'écrase pas les autres champs). Renvoie le contact à jour. */
export function updateContact(
  tenantId: string,
  contactId: string,
  patch: { fields?: Record<string, string>; addTags?: string[]; removeTags?: string[] },
): Promise<{ contact: Contact }> {
  return request<{ contact: Contact }>(`/tenants/${tenantId}/contacts/${contactId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

/** Récupère TOUS les contacts d'un tenant (pagination par pages de 500). Pour la sélection de
 *  campagne : ne jamais tronquer silencieusement (sinon on enverrait à un sous-ensemble). */
export async function listAllContacts(tenantId: string): Promise<Contact[]> {
  const page = 500;
  const all: Contact[] = [];
  for (let offset = 0; offset < 100_000; offset += page) {
    const { contacts } = await listContacts(tenantId, { limit: page, offset });
    all.push(...contacts);
    if (contacts.length < page) break;
  }
  return all;
}

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
  templateName: string;
  templateLanguage: string;
  paramMapping: TemplateParam[];
  /** Contacts choisis. Absent -> tous les contacts éligibles. */
  contactIds?: string[];
}

export function listCampaigns(tenantId: string): Promise<{ campaigns: CampaignSummary[] }> {
  return request<{ campaigns: CampaignSummary[] }>(`/tenants/${tenantId}/campaigns`);
}
export function getCampaign(tenantId: string, campaignId: string): Promise<CampaignDetail> {
  return request<CampaignDetail>(`/tenants/${tenantId}/campaigns/${campaignId}`);
}
export function listPhoneNumbers(tenantId: string): Promise<{ phoneNumbers: PhoneNumber[] }> {
  return request<{ phoneNumbers: PhoneNumber[] }>(`/tenants/${tenantId}/phone-numbers`);
}
export function createCampaign(tenantId: string, input: CreateCampaignInput): Promise<{ campaignId: string; recipientCount: number }> {
  return request(`/tenants/${tenantId}/campaigns`, { method: 'POST', body: JSON.stringify(input) });
}
export function runCampaign(campaignId: string): Promise<{ enqueued: boolean }> {
  return request(`/campaigns/${campaignId}/run`, { method: 'POST' });
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
}
export function updateTemplate(tenantId: string, name: string, input: UpdateTemplateInput): Promise<{ success: boolean; status: string }> {
  return request(`/tenants/${tenantId}/templates/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(input) });
}
export function deleteTemplate(tenantId: string, name: string): Promise<{ success: boolean }> {
  return request(`/tenants/${tenantId}/templates/${encodeURIComponent(name)}`, { method: 'DELETE' });
}
/** Upload d'une image (data URL base64) -> handle média Meta (header de carte carousel). */
export function uploadMedia(tenantId: string, dataUrl: string): Promise<{ handle: string }> {
  return request<{ handle: string }>(`/tenants/${tenantId}/media`, { method: 'POST', body: JSON.stringify({ dataUrl }) });
}

// --- Inbox ---

export interface Conversation {
  id: string;
  waId: string;
  profileName: string | null;
  lastPreview: string | null;
  lastMessageAt: string;
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
  messages: InboxMessage[];
}
export function getConversationMessages(tenantId: string, conversationId: string): Promise<ConversationThread> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/messages`);
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
export interface DeliveryFunnel {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}
export function getDeliveryFunnel(tenantId: string, range?: StatsRange): Promise<DeliveryFunnel> {
  return request<DeliveryFunnel>(`/tenants/${tenantId}/stats/funnel${rangeQuery(range)}`);
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

export interface TenantSettings {
  mbaEnabled: boolean;
}
export function getSettings(tenantId: string): Promise<TenantSettings> {
  return request<TenantSettings>(`/tenants/${tenantId}/settings`);
}
export function putSettings(tenantId: string, mbaEnabled: boolean): Promise<TenantSettings> {
  return request<TenantSettings>(`/tenants/${tenantId}/settings`, { method: 'PUT', body: JSON.stringify({ mbaEnabled }) });
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
  number: string | null;
  tier: string | null;
  quality: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  numberStatus: string | null;
  status: { dot: AccountDot; label: string; reason: string };
}
export function getAccountStatus(tenantId: string): Promise<AccountStatusResponse> {
  return request<AccountStatusResponse>(`/tenants/${tenantId}/account-status`);
}

// --- Support (formulaire de contact -> email Resend) ---

export function sendSupportMessage(tenantId: string, input: { subject: string; message: string; email?: string }): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/tenants/${tenantId}/support`, { method: 'POST', body: JSON.stringify(input) });
}

// --- Admin (gestion des comptes) ---

export type UserRole = 'admin' | 'agent';
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  /** true = compte révoqué (login bloqué). */
  disabled: boolean;
  createdAt: string;
}
export function listUsers(tenantId: string): Promise<{ users: AdminUser[] }> {
  return request<{ users: AdminUser[] }>(`/tenants/${tenantId}/users`);
}
export interface CreateUserInput {
  email: string;
  password: string;
  role: UserRole;
  name?: string;
}
export function createUser(tenantId: string, input: CreateUserInput): Promise<{ user: AdminUser }> {
  return request<{ user: AdminUser }>(`/tenants/${tenantId}/users`, { method: 'POST', body: JSON.stringify(input) });
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

export type FlowFieldType = 'text' | 'email' | 'phone' | 'number' | 'textarea' | 'date';
export type FlowTextKind = 'heading' | 'subheading' | 'body' | 'caption';

/** Élément riche envoyé à la création d'un flow, dans l'ordre. `saveTo` (sur un champ) : clé du user field
 *  cible ; absent -> le serveur crée un user field d'après le libellé (mapping par défaut). */
export type FlowElementInput =
  | { kind: FlowTextKind; text: string }
  | { kind: 'image'; src: string }
  | { kind: 'field'; label: string; type: FlowFieldType; required: boolean; saveTo?: string };

export interface FlowField {
  label: string;
  type: FlowFieldType;
  required: boolean;
  key: string;
}
/** Élément riche STOCKÉ (les champs portent leur clé dérivée) — sert à pré-remplir l'édition. */
export type FlowElement =
  | { kind: FlowTextKind; text: string }
  | { kind: 'image'; src: string }
  | { kind: 'field'; label: string; type: FlowFieldType; required: boolean; key: string };
export interface FlowSummary {
  id: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED';
  /** Champs dérivés (kind='field') — pour l'aperçu de la liste. */
  fields: FlowField[];
  /** Éléments riches (null pour les flows antérieurs au modèle) — pour pré-remplir l'édition. */
  elements?: FlowElement[] | null;
  /** Mapping clé champ -> clé user field — pour restaurer le « enregistrer dans » à l'édition. */
  mapping?: Record<string, string> | null;
  createdAt: string;
}
export function listFlows(tenantId: string): Promise<{ flows: FlowSummary[] }> {
  return request<{ flows: FlowSummary[] }>(`/tenants/${tenantId}/flows`);
}
export function createFlow(tenantId: string, input: { name: string; elements: FlowElementInput[] }): Promise<{ id: string; status: string; name: string; fields: FlowField[] }> {
  return request(`/tenants/${tenantId}/flows`, { method: 'POST', body: JSON.stringify(input) });
}
/** Édite un flow DRAFT (réécrit le flow_json). 409 si le flow est PUBLISHED (immuable). */
export function updateFlow(tenantId: string, flowId: string, input: { name: string; elements: FlowElementInput[] }): Promise<{ id: string; status: string; name: string; fields: FlowField[] }> {
  return request(`/tenants/${tenantId}/flows/${flowId}`, { method: 'PATCH', body: JSON.stringify(input) });
}
/** « Dupliquer pour modifier » : clone un flow (publié ou draft) en un nouveau DRAFT éditable. */
export function duplicateFlow(tenantId: string, flowId: string): Promise<{ id: string; status: string; name: string; fields: FlowField[] }> {
  return request(`/tenants/${tenantId}/flows/${flowId}/duplicate`, { method: 'POST' });
}
export function publishFlow(tenantId: string, flowId: string): Promise<{ id: string; status: string }> {
  return request(`/tenants/${tenantId}/flows/${flowId}/publish`, { method: 'POST' });
}

// --- Contenu : Tags + User fields (édition) ---

export interface TagCount {
  tag: string;
  count: number;
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

export type UserFieldKind = 'text' | 'number' | 'date' | 'boolean' | 'url';
export interface UserFieldDef {
  key: string;
  label: string;
  type: UserFieldKind;
}
export function listUserFields(tenantId: string): Promise<{ fields: UserFieldDef[] }> {
  return request<{ fields: UserFieldDef[] }>(`/tenants/${tenantId}/user-fields`);
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
