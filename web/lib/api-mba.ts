'use client';

import { request } from './http';

/**
 * Appels de configuration de l'agent Meta Business Agent, tous indexés PAR NUMÉRO (c'est ainsi que Meta
 * modélise la ressource, pas par espace client). Module séparé de `api.ts` : cette surface a son propre
 * vocabulaire et son propre cycle de vie, la mêler aux 200 fonctions du fichier historique ne rendrait service
 * à personne.
 *
 * ⚠️ Toutes les fonctions sont préfixées `Mba` sans exception. `api.ts` expose déjà `getSettings`/`putSettings`
 * pour les réglages de l'ESPACE (`mbaEnabled`, `hubspotListsEnabled`), qui gatent les blocs MBA du constructeur
 * de scénario. Ce sont deux systèmes différents ; une collision de nom finirait par faire écrire l'un pour
 * l'autre.
 */

const base = (tenantId: string, phoneNumberId: string): string => `/tenants/${tenantId}/mba/${phoneNumberId}`;

// --- État général et réglages ---------------------------------------------------------------------

export interface MbaSettings {
  agent_id?: string;
  channel?: string;
  rollout?: { enabled?: boolean };
  ai_audience?: 'EVERYONE' | 'ALLOWLISTED_ONLY';
  followup?: { enabled?: boolean; followup_interval_in_seconds?: number };
  never_say_phrases?: string[];
  [autre: string]: unknown;
}

export interface MbaStatus {
  phoneNumberId: string;
  /** Meta a-t-il ouvert l'agent pour ce numéro (pays, secteur, conditions acceptées) ? */
  eligible: boolean;
  /** Une configuration existe déjà. `false` n'est PAS un blocage : seules les compétences exigent un agent_id. */
  onboarded: boolean;
  agentId: string | null;
  settings: MbaSettings | null;
}

export function getMbaStatus(tenantId: string, phoneNumberId: string): Promise<MbaStatus> {
  return request<MbaStatus>(`${base(tenantId, phoneNumberId)}/status`);
}

export interface MbaSettingsPatch {
  aiAudience?: 'EVERYONE' | 'ALLOWLISTED_ONLY';
  neverSay?: string[];
  followupEnabled?: boolean;
}

export function patchMbaSettings(tenantId: string, phoneNumberId: string, patch: MbaSettingsPatch): Promise<MbaSettings> {
  return request<MbaSettings>(`${base(tenantId, phoneNumberId)}/settings`, { method: 'PATCH', body: JSON.stringify(patch) });
}

/** Allumage. Route séparée côté serveur : l'effet est asymétrique, ce n'est pas un interrupteur ordinaire. */
export function putMbaRollout(tenantId: string, phoneNumberId: string, enabled: boolean): Promise<MbaSettings> {
  return request<MbaSettings>(`${base(tenantId, phoneNumberId)}/rollout`, { method: 'PUT', body: JSON.stringify({ enabled }) });
}

// --- Informations business ------------------------------------------------------------------------

export interface MbaBusinessInfo {
  business_description?: string;
  payment_method?: string;
  return_policy?: string;
  purchase_info?: string;
  delivery_and_shipping?: string;
  contact_info?: { email?: string; hours_of_operation?: string; address?: string } | null;
}

export interface MbaBusinessInfoPatch {
  description?: string;
  paymentMethod?: string;
  returnPolicy?: string;
  purchaseInfo?: string;
  deliveryAndShipping?: string;
  contact?: { email?: string; hours_of_operation?: string; address?: string };
}

export function getMbaBusinessInfo(tenantId: string, phoneNumberId: string): Promise<MbaBusinessInfo> {
  return request<MbaBusinessInfo>(`${base(tenantId, phoneNumberId)}/business-info`);
}

/** PATCH et non PUT : le serveur relit l'existant et fusionne, donc n'envoyer que ce qui change est SÛR. */
export function patchMbaBusinessInfo(tenantId: string, phoneNumberId: string, patch: MbaBusinessInfoPatch): Promise<MbaBusinessInfo> {
  return request<MbaBusinessInfo>(`${base(tenantId, phoneNumberId)}/business-info`, { method: 'PATCH', body: JSON.stringify(patch) });
}

// --- FAQ ------------------------------------------------------------------------------------------

export interface MbaFaq {
  id?: string;
  question: string;
  answer: string;
  metadata?: Record<string, string>;
}

export function listMbaFaqs(tenantId: string, phoneNumberId: string): Promise<{ faqs: MbaFaq[]; count: number }> {
  return request(`${base(tenantId, phoneNumberId)}/faq`);
}

export function createMbaFaq(tenantId: string, phoneNumberId: string, faq: { question: string; answer: string }): Promise<MbaFaq> {
  return request(`${base(tenantId, phoneNumberId)}/faq`, { method: 'POST', body: JSON.stringify(faq) });
}

export function updateMbaFaq(tenantId: string, phoneNumberId: string, faqId: string, faq: { question: string; answer: string }): Promise<MbaFaq> {
  return request(`${base(tenantId, phoneNumberId)}/faq/${faqId}`, { method: 'PUT', body: JSON.stringify(faq) });
}

export function deleteMbaFaq(tenantId: string, phoneNumberId: string, faqId: string): Promise<{ deleted: string }> {
  return request(`${base(tenantId, phoneNumberId)}/faq/${faqId}`, { method: 'DELETE' });
}

/** Source d'un chargement en lot. Une seule des trois clés est envoyée à la fois. */
export type MbaFaqSource = { items: Array<{ question: string; answer: string }> } | { csv: string } | { url: string };

export interface MbaFaqPreview {
  source: string;
  total: number;
  aCreer: Array<{ question: string; answer: string }>;
  aMettreAJour: Array<{ id: string; question: string; answer: string }>;
  inchangees: number;
}

export interface MbaFaqImportResult {
  source: string;
  created: number;
  updated: number;
  unchanged: number;
  /** Restant à écrire quand l'import s'est arrêté en cours (réponse 207). */
  remaining: number;
  ids: { created: string[]; updated: string[] };
  /** Non-null = import interrompu. Relancer la MÊME source reprend sans dupliquer. */
  failed: { question: string; error: string } | null;
}

export function previewMbaFaqImport(tenantId: string, phoneNumberId: string, source: MbaFaqSource): Promise<MbaFaqPreview> {
  return request(`${base(tenantId, phoneNumberId)}/faq/preview`, { method: 'POST', body: JSON.stringify(source) });
}

/**
 * ⚠️ Répond **207** quand l'import s'est arrêté en chemin. `fetch` considère 207 comme un succès, donc aucune
 * exception ne sera levée : c'est à l'appelant de regarder `failed`. Confondre les deux ferait passer un import
 * à moitié écrit pour un import réussi.
 */
export function importMbaFaq(tenantId: string, phoneNumberId: string, source: MbaFaqSource): Promise<MbaFaqImportResult> {
  return request(`${base(tenantId, phoneNumberId)}/faq/import`, { method: 'POST', body: JSON.stringify(source) });
}

// --- Compétences ----------------------------------------------------------------------------------

export interface MbaSkill {
  id?: string;
  title: string;
  description: string;
  skill: string;
}

export function listMbaSkills(tenantId: string, phoneNumberId: string): Promise<{ skills: MbaSkill[]; agentId: string | null }> {
  return request(`${base(tenantId, phoneNumberId)}/skills`);
}

export function createMbaSkill(tenantId: string, phoneNumberId: string, skill: MbaSkill): Promise<MbaSkill> {
  return request(`${base(tenantId, phoneNumberId)}/skills`, { method: 'POST', body: JSON.stringify(skill) });
}

export function updateMbaSkill(tenantId: string, phoneNumberId: string, skillId: string, skill: MbaSkill): Promise<MbaSkill> {
  return request(`${base(tenantId, phoneNumberId)}/skills/${skillId}`, { method: 'PUT', body: JSON.stringify(skill) });
}

export function deleteMbaSkill(tenantId: string, phoneNumberId: string, skillId: string): Promise<{ deleted: string }> {
  return request(`${base(tenantId, phoneNumberId)}/skills/${skillId}`, { method: 'DELETE' });
}

// --- Sites web ------------------------------------------------------------------------------------

export interface MbaWebsite {
  id?: string;
  url: string;
  /** Casse NON garantie par Meta (« completed » dans la description, « COMPLETED » dans l'exemple). */
  crawl_status?: string;
  pages_crawled?: number;
  last_crawled_at?: string;
}

export function listMbaWebsites(tenantId: string, phoneNumberId: string): Promise<{ websites: MbaWebsite[] }> {
  return request(`${base(tenantId, phoneNumberId)}/websites`);
}

export function createMbaWebsite(tenantId: string, phoneNumberId: string, url: string): Promise<MbaWebsite> {
  return request(`${base(tenantId, phoneNumberId)}/websites`, { method: 'POST', body: JSON.stringify({ url }) });
}

export function deleteMbaWebsite(tenantId: string, phoneNumberId: string, websiteId: string): Promise<{ deleted: string }> {
  return request(`${base(tenantId, phoneNumberId)}/websites/${websiteId}`, { method: 'DELETE' });
}

// --- Fichiers de connaissance ---------------------------------------------------------------------

export interface MbaFile {
  id: string;
  file_name?: string;
  status?: string;
  created_at?: string;
  /** Posé par notre serveur : un 201 de Meta veut dire « reçu », jamais « indexé ». */
  indexationInconnue?: boolean;
}

export function listMbaFiles(tenantId: string, phoneNumberId: string): Promise<{ files: MbaFile[] }> {
  return request(`${base(tenantId, phoneNumberId)}/files`);
}

export function uploadMbaFile(tenantId: string, phoneNumberId: string, fileName: string, dataUrl: string): Promise<MbaFile> {
  return request(`${base(tenantId, phoneNumberId)}/files`, { method: 'POST', body: JSON.stringify({ fileName, dataUrl }) });
}

export function deleteMbaFile(tenantId: string, phoneNumberId: string, fileId: string): Promise<{ deleted: string }> {
  return request(`${base(tenantId, phoneNumberId)}/files/${fileId}`, { method: 'DELETE' });
}

// --- Liste d'autorisation -------------------------------------------------------------------------

export interface MbaAllowlistEntry {
  id?: string;
  consumer_phone_number: string;
}

export function listMbaAllowlist(tenantId: string, phoneNumberId: string): Promise<{ allowlist: MbaAllowlistEntry[] }> {
  return request(`${base(tenantId, phoneNumberId)}/allowlist`);
}

export function addMbaAllowlistEntry(tenantId: string, phoneNumberId: string, phone: string): Promise<MbaAllowlistEntry> {
  return request(`${base(tenantId, phoneNumberId)}/allowlist`, { method: 'POST', body: JSON.stringify({ phone }) });
}

export function removeMbaAllowlistEntry(tenantId: string, phoneNumberId: string, entryId: string): Promise<{ deleted: string }> {
  return request(`${base(tenantId, phoneNumberId)}/allowlist/${entryId}`, { method: 'DELETE' });
}

// --- Bac à sable ----------------------------------------------------------------------------------

export interface MbaTestReply {
  agent_response?: string;
  conversation_id?: string;
  handoff_reason?: string;
  no_response_reason?: string;
  quick_replies?: unknown[];
}

/** Meta ne facture PAS les jetons consommés ici, et aucun message réel n'est envoyé. */
export function testMbaAgent(tenantId: string, phoneNumberId: string, message: string, conversationId?: string): Promise<MbaTestReply> {
  return request(`${base(tenantId, phoneNumberId)}/test`, {
    method: 'POST',
    body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }),
  });
}
