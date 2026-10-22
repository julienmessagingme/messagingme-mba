'use client';

import { request } from './http';

/**
 * LE CONNECTEUR SHOPIFY : la carte de Paramètres > Intégrations (plan 2026-10-21, lot 1 ; conception 2026-10-22). La
 * console lit l'état, branche une boutique (l'app créée à la main sur le tableau de bord de Shopify), règle ses messages
 * par l'assistant, importe ses clients abonnés et coupe.
 *
 * ⚠️ Importé EN DIRECT (`@/lib/api-shopify`), jamais ajouté au barrel `lib/api.ts`, comme `api-salesforce`.
 */

const base = (tenantId: string): string => `/tenants/${tenantId}/integrations/shopify`;

export interface MessageShopifyVue {
  evenement: string;
  modele: string;
  langue: string;
  /** Les données Shopify de {{1}}, {{2}}... dans l'ordre : de quoi rendre le texte du modèle à l'assistant. */
  variables: string[];
  actif: boolean;
}

export interface AttenteShopifyVue {
  evenement: string;
  modele: string;
  langue: string;
  variables: string[];
  creeLe: string | null;
}

export interface EtatShopifyVue {
  boutique: {
    domaine: string;
    nom: string | null;
    etat: 'connectee' | 'coupee';
    dernierEvenementLe: string | null;
    consentementLe: string | null;
    delaiPanierMinutes: number | null;
    /** `console` : branchée par la carte ; `claude_code` : par la skill du plugin. */
    origine: 'console' | 'claude_code';
  } | null;
  messages: MessageShopifyVue[];
  compteurs: Record<string, number>;
  /** Les paniers des 7 derniers jours, leur durée de vie (lot 2). */
  paniers: { relances: Record<string, number>; fermesATemps: number; enAttente: number };
  pageApps: string | null;
  /** Les messages préparés par l'assistant, dont le modèle attend l'approbation de Meta. */
  attentes: AttenteShopifyVue[];
}

const texte = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const textes = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Lu défensivement : une réponse d'une API plus ancienne ou plus récente que la console ne casse pas l'écran. */
export function lireEtatShopify(brut: unknown): EtatShopifyVue | null {
  if (typeof brut !== 'object' || brut === null) return null;
  const o = brut as Record<string, unknown>;
  const b = o.boutique as Record<string, unknown> | null | undefined;
  const boutique = b && typeof b === 'object' && typeof b.domaine === 'string' && (b.etat === 'connectee' || b.etat === 'coupee')
    ? {
      domaine: b.domaine, nom: texte(b.nom), etat: b.etat === 'coupee' ? 'coupee' as const : 'connectee' as const,
      dernierEvenementLe: texte(b.dernierEvenementLe),
      consentementLe: texte((b.consentement as Record<string, unknown> | null | undefined)?.le),
      delaiPanierMinutes: typeof b.delaiPanierMinutes === 'number' ? b.delaiPanierMinutes : null,
      origine: b.origine === 'console' ? 'console' as const : 'claude_code' as const,
    }
    : null;
  const messages = Array.isArray(o.messages)
    ? o.messages.flatMap((m: unknown) => {
      const x = m as Record<string, unknown> | null;
      return x && typeof x.evenement === 'string' && typeof x.modele === 'string'
        ? [{ evenement: x.evenement, modele: x.modele, langue: texte(x.langue) ?? '', variables: textes(x.variables), actif: x.actif === true }]
        : [];
    })
    : [];
  const compteurs: Record<string, number> = {};
  if (o.compteurs && typeof o.compteurs === 'object') {
    for (const [k, v] of Object.entries(o.compteurs as Record<string, unknown>)) if (typeof v === 'number') compteurs[k] = v;
  }
  const p = (o.paniers ?? {}) as Record<string, unknown>;
  const relances: Record<string, number> = {};
  if (p.relances && typeof p.relances === 'object') {
    for (const [k, v] of Object.entries(p.relances as Record<string, unknown>)) if (typeof v === 'number') relances[k] = v;
  }
  const nombre = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const paniers = { relances, fermesATemps: nombre(p.fermesATemps), enAttente: nombre(p.enAttente) };
  const attentes = Array.isArray(o.attentes)
    ? o.attentes.flatMap((a: unknown) => {
      const x = a as Record<string, unknown> | null;
      return x && typeof x.evenement === 'string' && typeof x.modele === 'string'
        ? [{ evenement: x.evenement, modele: x.modele, langue: texte(x.langue) ?? '', variables: textes(x.variables), creeLe: texte(x.creeLe) }]
        : [];
    })
    : [];
  return { boutique, messages, compteurs, paniers, pageApps: texte(o.pageApps), attentes };
}

export async function lireShopify(tenantId: string): Promise<EtatShopifyVue | null> {
  return lireEtatShopify(await request<unknown>(base(tenantId)));
}

export function couperShopify(tenantId: string): Promise<{ dejaCoupee: boolean; pageApps: string | null }> {
  return request(base(tenantId), { method: 'DELETE' });
}

export function brancherShopify(tenantId: string, corps: { boutique: string; clientId: string; secret: string }): Promise<unknown> {
  return request(base(tenantId), { method: 'POST', body: JSON.stringify(corps) });
}

export interface PreparationShopify {
  evenement: string;
  texte: string;
  langue: string;
  delaiMinutes?: number;
  consentementAffirme?: boolean;
}

/** `actif` : Meta a approuvé tout de suite ; `en_validation` : le message s'activera seul à l'approbation. */
export function preparerMessageShopify(tenantId: string, corps: PreparationShopify): Promise<{ etat: 'actif' | 'en_validation'; modele: string }> {
  return request(`${base(tenantId)}/messages`, { method: 'POST', body: JSON.stringify(corps) });
}

export function reglerMessageShopify(
  tenantId: string, evenement: string, corps: { delaiMinutes?: number; consentementAffirme?: boolean },
): Promise<{ relanceArretee: boolean }> {
  return request(`${base(tenantId)}/messages/${encodeURIComponent(evenement)}`, { method: 'PATCH', body: JSON.stringify(corps) });
}

export interface ApercuClientsShopify {
  abonnes: number;
  sansTelephone: number;
  dejaDansLEspace: number;
  nouveaux: number;
  placesLibres: number | null;
  importables: number;
  complet: boolean;
}

export function apercuClientsShopify(tenantId: string): Promise<ApercuClientsShopify> {
  return request(`${base(tenantId)}/clients/apercu`);
}

export function importerClientsShopify(
  tenantId: string, maximum: number,
): Promise<{ importes: number; retablis: number; restent: number; placesLibres: number | null; etiquette: string; complet: boolean }> {
  return request(`${base(tenantId)}/clients/import`, { method: 'POST', body: JSON.stringify({ maximum }) });
}
