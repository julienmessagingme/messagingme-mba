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
  createdAt: string;
}
export function listContacts(tenantId: string): Promise<{ contacts: Contact[] }> {
  return request<{ contacts: Contact[] }>(`/tenants/${tenantId}/contacts`);
}

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ line: number; reason: string }>;
}
export function importCsv(tenantId: string, csv: string, optIn: boolean): Promise<ImportReport> {
  return request<ImportReport>(`/tenants/${tenantId}/contacts/import`, {
    method: 'POST',
    body: JSON.stringify({ csv, optIn }),
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
  name: string;
  status: string;
  category: string;
  language: string;
}
export interface TemplateButtonInput {
  type: 'QUICK_REPLY' | 'URL';
  text: string;
  url?: string;
}
export interface CreateTemplateInput {
  name: string;
  category: 'MARKETING' | 'UTILITY';
  language: string;
  body: string;
  example?: string[];
  buttons?: TemplateButtonInput[];
}
export function listTemplates(tenantId: string): Promise<{ templates: TemplateSummary[] }> {
  return request<{ templates: TemplateSummary[] }>(`/tenants/${tenantId}/templates`);
}
export function createTemplate(tenantId: string, input: CreateTemplateInput): Promise<{ id: string; status: string }> {
  return request(`/tenants/${tenantId}/templates`, { method: 'POST', body: JSON.stringify(input) });
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
}
export function listConversations(tenantId: string): Promise<{ conversations: Conversation[] }> {
  return request<{ conversations: Conversation[] }>(`/tenants/${tenantId}/conversations`);
}
export function getConversationMessages(tenantId: string, conversationId: string): Promise<{ waId: string; messages: InboxMessage[] }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/messages`);
}
export function replyConversation(tenantId: string, conversationId: string, text: string): Promise<{ messageId: string }> {
  return request(`/tenants/${tenantId}/conversations/${conversationId}/reply`, { method: 'POST', body: JSON.stringify({ text }) });
}
