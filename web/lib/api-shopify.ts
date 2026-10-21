'use client';

import { request } from './http';

/**
 * LE CONNECTEUR SHOPIFY : la carte de Paramètres > Intégrations (plan 2026-10-21, lot 1). Le réglage passe par Claude
 * Code ; la console lit l'état et coupe.
 *
 * ⚠️ Importé EN DIRECT (`@/lib/api-shopify`), jamais ajouté au barrel `lib/api.ts`, comme `api-salesforce`.
 */

const base = (tenantId: string): string => `/tenants/${tenantId}/integrations/shopify`;

export interface MessageShopifyVue {
  evenement: string;
  modele: string;
  langue: string;
  actif: boolean;
}

export interface EtatShopifyVue {
  boutique: {
    domaine: string;
    nom: string | null;
    etat: 'connectee' | 'coupee';
    dernierEvenementLe: string | null;
    consentementLe: string | null;
  } | null;
  messages: MessageShopifyVue[];
  compteurs: Record<string, number>;
  pageApps: string | null;
}

const texte = (v: unknown): string | null => (typeof v === 'string' ? v : null);

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
    }
    : null;
  const messages = Array.isArray(o.messages)
    ? o.messages.flatMap((m: unknown) => {
      const x = m as Record<string, unknown> | null;
      return x && typeof x.evenement === 'string' && typeof x.modele === 'string'
        ? [{ evenement: x.evenement, modele: x.modele, langue: texte(x.langue) ?? '', actif: x.actif === true }]
        : [];
    })
    : [];
  const compteurs: Record<string, number> = {};
  if (o.compteurs && typeof o.compteurs === 'object') {
    for (const [k, v] of Object.entries(o.compteurs as Record<string, unknown>)) if (typeof v === 'number') compteurs[k] = v;
  }
  return { boutique, messages, compteurs, pageApps: texte(o.pageApps) };
}

export async function lireShopify(tenantId: string): Promise<EtatShopifyVue | null> {
  return lireEtatShopify(await request<unknown>(base(tenantId)));
}

export function couperShopify(tenantId: string): Promise<{ dejaCoupee: boolean; pageApps: string | null }> {
  return request(base(tenantId), { method: 'DELETE' });
}
