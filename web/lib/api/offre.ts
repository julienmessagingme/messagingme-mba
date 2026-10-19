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
