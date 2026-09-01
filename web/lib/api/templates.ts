'use client';

/**
 * Les templates WhatsApp : catalogue, soumission a Meta, statuts.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request } from '../http';
import type { ParamSource } from './campagnes';

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
  /**
   * Média d'en-tête DÉJÀ défini sur le template (lu chez Meta dans `example.header_handle`). C'est lui qu'on
   * renvoie à l'envoi : Meta exige le média à CHAQUE envoi, mais il n'y a aucune raison de le redemander à
   * quelqu'un qui l'a déjà choisi en créant le template. ⚠️ Porte une expiration : à consommer, jamais à
   * mettre en cache.
   */
  headerMediaUrl?: string;
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
