import { API_KEY_PREFIX } from '../../src/auth/api-key-store.pg';

/**
 * UNE CLÉ D'API AU FORMAT QUE LE PRODUIT ÉMET VRAIMENT.
 *
 * 🔴 IL EXISTE PARCE QUE LES TESTS UTILISAIENT DES CLÉS QUE LE PRODUIT N'ÉMET JAMAIS (`mba_ok`,
 * `mba_valid_key`). Tant que la garde ne regardait que le préfixe, ça ne se voyait pas ; depuis qu'elle
 * contrôle le FORMAT, ces clés sont refusées, et c'est le bon comportement : une clé de quatre caractères
 * n'a jamais pu exister. Un test qui s'authentifie avec un jeton impossible éprouve un chemin que la
 * production n'emprunte pas.
 *
 * ⚠️ LE FORMAT EST CELUI DU GÉNÉRATEUR, PAS UNE CONVENTION : `randomBytes(32).toString('base64url')`
 * (`api-key-store.pg.ts`) rend exactement 43 caractères de l'alphabet base64url. La graine ci-dessous est
 * complétée jusqu'à cette longueur, ce qui garde des clés LISIBLES dans les tests (« mba_valide_xxxx... »)
 * tout en respectant la forme réelle.
 */
export function cleApiDeTest(graine: string): string {
  const corps = graine.replace(/[^A-Za-z0-9_-]/g, '_').padEnd(43, 'x').slice(0, 43);
  return `${API_KEY_PREFIX}${corps}`;
}
