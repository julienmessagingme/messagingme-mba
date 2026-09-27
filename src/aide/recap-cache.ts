import { cacheCourt } from '../lib/cache-court';

/**
 * Le cache du récap : une entrée par espace, par jour et par langue.
 *
 * Les jetons du bot d'aide sont à notre charge, et le récap porte sur la veille, donc il ne bouge plus : le
 * premier qui clique dans un espace le fait calculer, les autres lisent le même. La langue est dans la clé (le
 * texte est rédigé dans celle de la personne), sinon le premier arrivé imposerait la sienne à tout l'espace.
 *
 * C'est `cacheCourt` (mutualisation des appels en vol, pas d'échec en cache) avec le jour dans la clé :
 * l'entrée d'hier devient inatteignable à minuit, sans horloge à tenir juste. Par process : une seconde
 * instance d'API paierait son propre premier calcul du jour.
 */

/**
 * Un jour entier. Ce n'est pas lui qui fait tourner le récap au changement de jour, c'est la clé : cette durée
 * ne borne que la mémoire.
 */
export const VIE_RECAP_MS = 24 * 3_600_000;

export interface CacheRecap<T> {
  /** La valeur du jour pour cet espace et cette langue, calculée une fois quel que soit le nombre d'appelants. */
  lire(tenantId: string, jour: string, langue: string, calcul: () => Promise<T>): Promise<T>;
}

export function creerCacheRecap<T>(maintenant?: () => number): CacheRecap<T> {
  const cache = cacheCourt<T>(VIE_RECAP_MS, maintenant);
  return {
    lire: (tenantId, jour, langue, calcul) => cache.lire(`${tenantId}:${jour}:${langue}`, calcul),
  };
}
