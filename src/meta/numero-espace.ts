import { cacheCourt } from '../lib/cache-court';

/**
 * Le numéro Meta de l'espace, mis en cache pour ne pas coûter une requête par destinataire (le runtime de
 * scénario le demande à chaque envoi, sur un pool partagé par tout le process).
 *
 * Seules les réponses positives sont mises en cache. Une réponse positive ne devient fausse que si le numéro
 * change d'espace (geste d'embarquement, et l'envoi échouerait alors visiblement chez Meta). Une réponse nulle
 * devient fausse dès qu'un client branche son premier numéro, dans l'API, alors que le worker a son propre
 * cache : aucune invalidation ne la rattraperait, donc `null` est relu à chaque fois. Cache par process.
 */

/** Durée de vie du cache : elle borne la seule fenêtre de risque, un numéro déplacé d'un espace à l'autre. */
export const NUMERO_ESPACE_TTL_MS = 60_000;

/**
 * Rend l'accesseur mis en cache ; une seule instance par process (deux instances, deux caches).
 * Sert aussi au WABA de l'espace (`getTenantWabaId`) avec la même règle : `resolveForTenant` le demande à chaque
 * construction de client Meta, et geler une réponse nulle retarderait un client fraîchement connecté.
 */
export function creerNumeroDeLEspace(
  lire: (tenantId: string) => Promise<string | null>,
  ttlMs: number = NUMERO_ESPACE_TTL_MS,
  maintenant: () => number = Date.now,
): (tenantId: string) => Promise<string | null> {
  const cache = cacheCourt<string | null>(ttlMs, maintenant);
  return async function numeroDeLEspace(tenantId: string): Promise<string | null> {
    const numero = await cache.lire(tenantId, () => lire(tenantId));
    // La mutualisation des appels en vol a déjà joué ; on retire seulement `null` de la durée de vie.
    if (numero === null) cache.invalider(tenantId);
    return numero;
  };
}
