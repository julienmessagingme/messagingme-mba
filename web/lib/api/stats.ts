'use client';

/**
 * Analytics : agregats du tableau de bord, reglages de l'espace, analyse de conversation.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request } from '../http';

// --- Dashboard (stats + réglages) ---

export interface DailyPoint {
  date: string;
  count: number;
}
export interface DashboardStats {
  contacts: DailyPoint[];
  templates: { utility: DailyPoint[]; marketing: DailyPoint[] };
  exchanged: DailyPoint[];
  /** Sortants qui ne sont PAS des templates (inbox, scenario dans la fenetre de 24 h). Sous-ensemble d'`exchanged`. */
  service: DailyPoint[];
  /**
   * Les memes messages de service, ventiles par ce qui les a ECRITS (migration 0099). Leur somme egale
   * celle de `service` sur la periode. `indeterminee` vaut zero tant qu'aucun chemin d'ecriture n'a
   * oublie de poser son origine : le montrer est ce qui empeche un tel message d'etre range en silence
   * dans un theme qui l'accueille.
   *
   * Optionnel a la lecture : un backend plus ancien que ce champ ne l'envoie pas, et l'ecran doit alors
   * masquer le tableau plutot que d'afficher trois zeros qui passeraient pour une mesure.
   */
  serviceParOrigine?: { ia: number; scenario: number; humain: number; indeterminee: number };
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
  /** Taps sur un bouton de reponse rapide. Sous-ensemble de `replied`. */
  buttonReplies: number;
  /**
   * Clics sur les liens traces du template, depuis le premier envoi de la campagne.
   * `null` = ce template ne porte aucun lien trace : l etape ne doit pas etre affichee.
   */
  urlClicks: number | null;
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
  /** Devise du compte (ISO 4217) rendue par Meta ; null = inconnue, on affiche le nombre nu. */
  currency: string | null;
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

/** Un tableau ENREGISTRE : une selection (scenario + mesures), jamais des chiffres. */
export interface TableauEnregistre {
  id: string;
  workflowId: string;
  name: string;
  mesures: Array<{ cle: string; label: string; kind: string; handle: string | null }>;
  updatedAt: string;
}

export function listWorkflowReports(tenantId: string): Promise<{ reports: TableauEnregistre[] }> {
  return request<{ reports: TableauEnregistre[] }>(`/tenants/${tenantId}/workflow-reports`);
}

/** Cree, ou met a jour si `id` est fourni. Meme bouton a l'ecran, donc meme route. */
export function saveWorkflowReport(
  tenantId: string,
  input: { id?: string; workflowId: string; name: string; mesures: TableauEnregistre['mesures'] },
): Promise<{ report: TableauEnregistre }> {
  return request(`/tenants/${tenantId}/workflow-reports`, { method: 'POST', body: JSON.stringify(input) });
}

export function deleteWorkflowReport(tenantId: string, id: string): Promise<{ ok: boolean }> {
  return request(`/tenants/${tenantId}/workflow-reports/${id}`, { method: 'DELETE' });
}

/** Une mesure brute d'un bloc de scenario (« Mes tableaux »). */
export interface NodeEventCount {
  nodeId: string;
  kind: string;
  handle: string | null;
  count: number;
  /** Personnes distinctes. null quand la mesure ne sait pas les distinguer (un clic sur un lien de template). */
  contacts: number | null;
}

/** Mesures d'un scenario, bloc par bloc, sur la periode. Brutes : c'est l'ecran qui compose le tableau. */
export function getWorkflowNodeCounts(tenantId: string, workflowId: string, range?: StatsRange): Promise<{ counts: NodeEventCount[] }> {
  return request<{ counts: NodeEventCount[] }>(`/tenants/${tenantId}/stats/workflow/${workflowId}${rangeQuery(range)}`);
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
  /** Devise du WABA (ISO 4217) rendue par Meta ; null = non communiquee. */
  currency: string | null;
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

/**
 * Quand l'agent de Meta passe la main à un humain (écran « Activation »). Miroir de `MbaHandoffMode` serveur.
 * `business_hours` est le seul qui varie dans la journée : c'est un balayage serveur qui le fait suivre l'heure.
 */
export type MbaHandoffMode = 'always' | 'business_hours' | 'never';
/** Défaut usine tant que rien n'a été choisi : l'agent passe la main. */
export const DEFAULT_MBA_HANDOFF_MODE: MbaHandoffMode = 'always';

export interface TenantSettings {
  /** Durée du gel après prise de main par un opérateur, en secondes. null = défaut du serveur. */
  controlHandbackSeconds: number | null;
  /** Quand l'agent de Meta passe la main à un humain. null = jamais réglé (l'écran montre le défaut usine). */
  mbaHandoffMode: MbaHandoffMode | null;
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

/**
 * Quand l'agent de Meta passe la main à un humain. Le choix est enregistré côté serveur ET appliqué chez Meta
 * dans la foulée ; `appliqueChezMeta: false` veut dire que Meta n'a pas répondu et que le balayage rattrapera.
 */
export function setMbaHandoffMode(tenantId: string, mode: MbaHandoffMode): Promise<{ mbaHandoffMode: MbaHandoffMode; appliqueChezMeta: boolean }> {
  return request(`/tenants/${tenantId}/settings/mba-handoff`, { method: 'PATCH', body: JSON.stringify({ mode }) });
}

/** Fuseau IANA du tenant (base des conditions temporelles : NOW, jour de semaine, heures d'ouverture). */
export function setTimezone(tenantId: string, timezone: string): Promise<{ timezone: string }> {
  return request(`/tenants/${tenantId}/settings/timezone`, { method: 'PATCH', body: JSON.stringify({ timezone }) });
}
/** Heures d'ouverture par jour (corps `{ '0'..'6': { closed, open 'HH:MM', close 'HH:MM' } }`, 7 jours requis). */
export function setBusinessHours(tenantId: string, businessHours: BusinessHours): Promise<{ businessHours: BusinessHours }> {
  return request(`/tenants/${tenantId}/settings/business-hours`, { method: 'PATCH', body: JSON.stringify({ businessHours }) });
}
