import { ApiError, request } from '../http';
import { lireVueOffre, type VueOffre } from '../offre';

/**
 * L'OFFRE DE L'ESPACE (lot 6), `GET /tenants/:tenantId/offre`, lisible par tout membre.
 *
 * `null` = offre inconnue, donc TOUT RESTE OUVERT : une API plus ancienne n'a pas la route (404 ; Vercel publie la
 * console au push, avant le déploiement de l'API), ou la réponse est illisible. Toute autre erreur remonte : la coquille
 * la traite aussi comme une offre inconnue, sans la garder en mémoire.
 */
export async function lireOffre(tenantId: string): Promise<VueOffre | null> {
  try {
    return lireVueOffre(await request<unknown>(`/tenants/${tenantId}/offre`));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Ouvre le paiement du Pro (lot 6, B1) et rend l'adresse de Stripe où la console redirige ; `portail: true` pour un espace
 * déjà Pro (l'adresse est alors celle du portail). Le corps ne porte que la périodicité, jamais un prix.
 */
export function payerPro(tenantId: string, periodicite: 'mois' | 'an'): Promise<{ url: string; portail: boolean }> {
  return request(`/tenants/${tenantId}/offre/paiement`, { method: 'POST', body: JSON.stringify({ periodicite }) });
}

/** Le portail de Stripe de l'espace : carte, factures, passage du mensuel à l'annuel, résiliation. */
export function portailPro(tenantId: string): Promise<{ url: string }> {
  return request(`/tenants/${tenantId}/offre/portail`, { method: 'POST', body: '{}' });
}

/**
 * Porte les sièges du Pro de `depuis` (ce que l'écran a lu) à `cible`, un siège à la fois (spec offres v2, livraison 7) : un
 * ajout facture le prorata sur la carte du Pro et ne s'applique que s'il est payé (sinon un 402 `paiement_siege_incomplet`
 * avec la facture à régler) ; un retrait ne rembourse rien ; une vue périmée est refusée (409 `sieges_changes`). Rend les
 * sièges que Stripe a appliqués. ⚠️ L'écran oublie ensuite l'offre mémorisée (`oublierOffre`) : la limite a changé, et
 * l'importer ici ferait une boucle (`use-offre` importe ce module).
 */
export function changerSieges(tenantId: string, depuis: number, cible: number): Promise<{ sieges: number }> {
  return request(`/tenants/${tenantId}/offre/sieges`, { method: 'POST', body: JSON.stringify({ depuis, cible }) });
}

/** Rendre le numéro fourni à la fin du Pro, ou revenir sur ce choix (lot 6, B2b). */
export function rendreNumero(tenantId: string, rendre: boolean): Promise<{ rendreNumero: boolean }> {
  return request(`/tenants/${tenantId}/offre/numero`, { method: 'PUT', body: JSON.stringify({ rendre }) });
}

/**
 * Résilier le Pro à la fin de sa période (ou de son essai), ou annuler cette résiliation (2026-10-26). Rend la fin prévue
 * que Stripe dit après le changement ; l'écran relit ensuite la vue (`relireOffre`).
 */
export function resilierPro(tenantId: string, resilier: boolean): Promise<{ finPrevueLe: string | null }> {
  return request(`/tenants/${tenantId}/offre/resiliation`, { method: 'POST', body: JSON.stringify({ resilier }) });
}

export type StatutFacture = 'payee' | 'a_regler' | 'impayee' | 'annulee';

/** Une facture de l'espace, telle que le serveur la rend (`src/stripe/gestion-pro.ts`). Les adresses sont `https`. */
export interface FactureEspace {
  id: string;
  numero: string | null;
  le: string;
  objet: 'pro' | 'numero' | 'autre';
  libelle: string | null;
  totalCentimes: number;
  devise: string;
  statut: StatutFacture;
  urlPage: string | null;
  urlPdf: string | null;
}

const STATUTS_FACTURE: readonly string[] = ['payee', 'a_regler', 'impayee', 'annulee'];
const httpsOuNul = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('https://') ? v : null);

/**
 * Les factures de l'espace (2026-10-26). `null` : une API plus ancienne (404) ou Stripe pas configuré (503), rien à
 * montrer. Une facture illisible est écartée ; une adresse qui n'est pas `https` n'est jamais gardée (l'écran y enverrait
 * un onglet). Toute autre erreur remonte, avec le message du serveur.
 */
export async function lireFactures(tenantId: string): Promise<{ factures: FactureEspace[]; plusSurStripe: boolean } | null> {
  let r: { factures?: unknown; plusSurStripe?: unknown };
  try {
    r = await request<{ factures?: unknown; plusSurStripe?: unknown }>(`/tenants/${tenantId}/offre/factures`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 503)) return null;
    throw err;
  }
  if (!Array.isArray(r.factures)) return null;
  const factures = r.factures.flatMap((f: unknown): FactureEspace[] => {
    if (typeof f !== 'object' || f === null) return [];
    const o = f as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.le !== 'string' || typeof o.totalCentimes !== 'number' || typeof o.devise !== 'string') return [];
    if (typeof o.statut !== 'string' || !STATUTS_FACTURE.includes(o.statut)) return [];
    const objet = o.objet === 'pro' || o.objet === 'numero' ? o.objet : 'autre';
    return [{
      id: o.id, numero: typeof o.numero === 'string' ? o.numero : null, le: o.le, objet,
      libelle: typeof o.libelle === 'string' ? o.libelle : null, totalCentimes: o.totalCentimes, devise: o.devise,
      statut: o.statut as StatutFacture, urlPage: httpsOuNul(o.urlPage), urlPdf: httpsOuNul(o.urlPdf),
    }];
  });
  return { factures, plusSurStripe: r.plusSurStripe === true };
}

/** Le tarif réel du Pro, lu sur son abonnement chez Stripe (`src/stripe/gestion-pro.ts`, `tarifDuPro`). */
export interface TarifPro {
  proHtCentimes: number | null;
  siegeHtCentimes: number | null;
  remise: boolean;
}

const entierOuNul = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * Le tarif réel du Pro de l'espace (2026-10-26). `null` pour toute réponse qui n'en est pas un (API plus ancienne, pas de
 * Pro en cours, Stripe pas configuré) : la carte garde alors le prix de la grille. Une autre erreur remonte.
 */
export async function lireTarifPro(tenantId: string): Promise<TarifPro | null> {
  let r: Record<string, unknown>;
  try {
    r = await request<Record<string, unknown>>(`/tenants/${tenantId}/offre/tarif`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 503)) return null;
    throw err;
  }
  if (typeof r !== 'object' || r === null || typeof r.remise !== 'boolean') return null;
  return { proHtCentimes: entierOuNul(r.proHtCentimes), siegeHtCentimes: entierOuNul(r.siegeHtCentimes), remise: r.remise };
}
