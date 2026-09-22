'use client';

/**
 * Les branchements : cles d'API publiques, automations, boites et modeles d'email.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request } from '../http';
import type { UserFieldKind } from '../field-kinds';

// --- Clés d'API (surface publique /v1) ---

/** Scopes reconnus. Doit rester aligné sur `VALID_API_SCOPES` du serveur (`src/http/api-keys.ts`). */
export const API_SCOPES = ['contacts:write', 'sends:create', 'mcp:read', 'mcp:write'] as const;
/**
 * Ce qui est COCHÉ D'AVANCE à la création d'une clé.
 *
 * 🔴 Les deux scopes MCP n'y sont volontairement PAS. L'écran cochait tout par défaut quand il n'y avait
 * que deux droits ; laisser ce geste tel quel aurait donné à toute clé neuve le droit d'ENVOYER des
 * WhatsApp au nom du client, sans que personne ne l'ait décidé. Ouvrir MCP doit rester une case qu'on coche.
 */
export const API_SCOPES_PAR_DEFAUT = ['contacts:write', 'sends:create'] as const;
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
export { USER_FIELD_KINDS } from '../field-kinds';
export type { UserFieldKind } from '../field-kinds';
export interface UserFieldDef {
  key: string;
  label: string;
  type: UserFieldKind;
  /** Code public « fld_<client>_<ulid> » (schéma A). Absent tant que le backfill n'a pas tourné. */
  code?: string | null;
}
/**
 * Combien de fiches ont chaque champ REMPLI (`parChamp`), sur `total` fiches. Sert au sélecteur de
 * destinataire du bloc « Envoi de mail » : un champ vide partout, c'est un bloc qui n'enverra jamais rien.
 */
export function listUserFieldUsage(tenantId: string): Promise<{ total: number; parChamp: Record<string, number> }> {
  return request<{ total: number; parChamp: Record<string, number> }>(`/tenants/${tenantId}/user-fields/usage`);
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
  /** Le numéro est rattaché mais PAS activable : la v4 laisse finir le parcours sans vérification par code. */
  aActiver?: boolean;
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

/**
 * « Activer le numéro » : finir dans la console ce que la fenêtre Meta a laissé en plan.
 *
 * 🔴 AUCUN APPEL AUTOMATIQUE À CES DEUX-LÀ. Meta ne permet que DIX requêtes par numéro sur 72 heures, toutes
 * étapes confondues ; au-delà, le numéro est bloqué trois jours. Elles se déclenchent sur un clic, jamais sur
 * un minuteur, un `useEffect` de montage ou une relance après échec.
 */
export type CanalCodeNumero = 'VOICE' | 'SMS';
/** Demande à Meta d'envoyer le code. VOICE (appel) par défaut : Meta déconseille le SMS sur un numéro VoIP. */
export function demanderCodeNumero(tenantId: string, methode: CanalCodeNumero = 'VOICE'): Promise<{ envoye: boolean; methode: CanalCodeNumero }> {
  return request(`/tenants/${tenantId}/numero/code`, { method: 'POST', body: JSON.stringify({ methode }) });
}
/** Vérifie le code s'il le faut, puis enregistre le numéro sur la Cloud API. `deja` = il l'était déjà. */
export function activerNumero(tenantId: string, code?: string): Promise<{ actif: boolean; deja?: boolean }> {
  return request(`/tenants/${tenantId}/numero/activer`, { method: 'POST', body: JSON.stringify(code === undefined ? {} : { code }) });
}

// --- Automations (Lot E : déclencher un scénario sur un événement) ---

/**
 * Types de déclencheur proposés à la création. Miroir de `AUTOMATION_TRIGGER_KINDS` serveur, MOINS `webhook`.
 *
 * ⚠️ `webhook` est absent VOLONTAIREMENT : ces automations sont possédées par leur webhook entrant, l'écran
 * Automation ne les liste pas et la route refuse d'en créer (migration 0074). L'ajouter ici offrirait dans le
 * menu un type que le serveur rejette en 400.
 */
export type AutomationTriggerKind = 'keyword' | 'new_contact' | 'tag_added' | 'conversation_analyzed' | 'hubspot_deal_stage' | 'avant_date' | 'ctwa_ad';

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

/* ------------------------------------------------------------------ Webhooks entrants (menu Tools) */

/** Une règle de mapping : un chemin dans le JSON reçu -> une destination dans la fiche contact. */
export interface RegleMappingWebhook { chemin: string; cible: string }

export interface WebhookEntrant {
  id: string;
  name: string;
  enabled: boolean;
  code: string;
  /** URL complète à coller chez le tiers. Calculée par le serveur : le front ne recompose jamais une URL. */
  url: string;
  /** Un secret est-il exigé ? Le clair n'est rendu QU'À sa génération, jamais ici. */
  hasSecret: boolean;
  mapping: RegleMappingWebhook[];
  createContact: boolean;
  /** Les contacts nés de ce webhook sont-ils considérés comme consentants ? Affirmé par l'opérateur. */
  optIn: boolean;
  workflowId: string | null;
  startNodeId: string | null;
  cooldownSeconds: number | null;
  /** Le DERNIER appel reçu, jamais un historique. C'est lui qui alimente l'arbre de mapping. */
  lastPayload: unknown;
  lastReceivedAt: string | null;
  contactsCreated: number;
  createdAt: string;
}

export interface WebhookEntrantInput {
  name?: string;
  enabled?: boolean;
  mapping?: RegleMappingWebhook[];
  createContact?: boolean;
  optIn?: boolean;
  workflowId?: string | null;
  startNodeId?: string | null;
  cooldownSeconds?: number | null;
}

export function listWebhooks(tenantId: string): Promise<{ webhooks: WebhookEntrant[] }> {
  return request(`/tenants/${tenantId}/webhooks`);
}
export function getWebhook(tenantId: string, id: string): Promise<{ webhook: WebhookEntrant }> {
  return request(`/tenants/${tenantId}/webhooks/${id}`);
}
export function createWebhook(tenantId: string, input: WebhookEntrantInput): Promise<{ id: string; code: string; url: string }> {
  return request(`/tenants/${tenantId}/webhooks`, { method: 'POST', body: JSON.stringify(input) });
}
export function updateWebhook(tenantId: string, id: string, patch: WebhookEntrantInput): Promise<{ id: string }> {
  return request(`/tenants/${tenantId}/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteWebhook(tenantId: string, id: string): Promise<void> {
  return request(`/tenants/${tenantId}/webhooks/${id}`, { method: 'DELETE' });
}
/** Le clair n'est rendu QU'ICI, une seule fois : l'écran doit le montrer tout de suite. */
export function rotateWebhookSecret(tenantId: string, id: string): Promise<{ secret: string; entete: string }> {
  return request(`/tenants/${tenantId}/webhooks/${id}/secret`, { method: 'POST' });
}
export function clearWebhookSecret(tenantId: string, id: string): Promise<void> {
  return request(`/tenants/${tenantId}/webhooks/${id}/secret`, { method: 'DELETE' });
}
export function forgetWebhookPayload(tenantId: string, id: string): Promise<void> {
  return request(`/tenants/${tenantId}/webhooks/${id}/payload`, { method: 'DELETE' });
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
