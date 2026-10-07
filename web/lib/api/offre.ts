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
