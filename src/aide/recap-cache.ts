import { cacheCourt } from '../lib/cache-court';

/**
 * LE CACHE DU RÉCAP : une entrée par espace et par JOUR.
 *
 * 🔴 IL DIVISE NOTRE FACTURE PAR LE NOMBRE DE PERSONNES DE L'ESPACE, et c'est sa seule raison d'être. Les
 * jetons du bot d'aide sont à NOTRE charge (décision de Julien du 2026-09-11, écrite dans
 * `src/http/aide.ts`) : un récap proposé à chaque ouverture du bot serait une dépense récurrente sur notre
 * clé, pour un contenu IDENTIQUE d'une personne à l'autre dans un même espace. Cent espaces, cinq personnes
 * chacun, un clic par jour, c'est cinq cents appels de modèle quotidiens là où il en faut cent.
 *
 * 🔴 ET LA PARADE EST GRATUITE : le récap porte sur la VEILLE, donc il ne bouge plus. Le premier qui clique
 * dans un espace le fait calculer, tous les autres lisent le même, et tout le monde voit la même chose, ce
 * qui est de toute façon préférable.
 *
 * ⚠️ LA LANGUE EST DANS LA CLÉ, ELLE AUSSI. Le texte est rédigé dans la langue de la personne qui clique :
 * sans elle, le premier arrivé imposerait la sienne à tout l'espace, et un collègue anglophone lirait un
 * récap en français sans comprendre pourquoi. Deux entrées au pire, et seulement dans les espaces qui
 * emploient réellement les deux langues.
 *
 * ⚠️ CE N'EST PAS UN CACHE NEUF, C'EST `cacheCourt` AVEC LE JOUR DANS LA CLÉ. Les deux mécanismes qui
 * comptent y sont déjà : la mutualisation des appels EN VOL (sans elle, cinq personnes qui cliquent dans la
 * même seconde trouvent toutes le cache vide et lancent toutes un appel de modèle, c'est-à-dire exactement
 * le moment où ça fait mal) et le refus de mettre un ÉCHEC en cache. Ce que le jour dans la clé ajoute :
 * l'entrée d'hier devient inatteignable à minuit, sans qu'aucune horloge n'ait à être juste.
 *
 * ⚠️ PAR PROCESS, comme tout `cacheCourt`. L'API et le worker ont chacun le leur ; seule l'API sert cette
 * route, donc la question ne se pose pas aujourd'hui. Avec une SECONDE instance d'API, chacune paierait son
 * premier calcul du jour : deux appels au lieu d'un, pas une panne.
 */

/**
 * Un jour entier.
 *
 * ⚠️ CE N'EST PAS LUI QUI FAIT TOURNER LE RÉCAP AU CHANGEMENT DE JOUR, c'est la clé. Un récap de la veille
 * ne change plus jamais : cette durée ne borne que la MÉMOIRE, en laissant partir l'entrée d'hier.
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
