import type { PubsRouteDeps } from '../src/http/pubs';

/**
 * LES DÉPENDANCES « PUBLICITÉS » QUE LE COMPILATEUR REND OBLIGATOIRES, pour les tests qui ne parlent pas de
 * publicités. Elles DISENT leur hypothèse au lieu de la cacher, comme `jamaisDesabonne`
 * (`tests/consentement.ts`) et `aucuneArriveePub` (`tests/webhook-fixtures.ts`).
 *
 * 🔴 CELLE-CI RÉPOND « AUCUNE », ET CE N'EST PAS ANODIN. Elle sert la garde du 409 : la suppression d'un
 * scénario est refusée quand une publicité vivante l'utilise. Un test qui la déclare affirme donc « dans ce
 * scénario de test, aucune publicité n'utilise ce scénario », ce qui est vrai et vérifiable, plutôt que de
 * laisser un `undefined` décider à sa place.
 */
export const aucunePubliciteUtilise = async (): Promise<string[]> => [];

/**
 * Les trois dépendances de publicités des routes de connexion, pour les tests qui n'exercent QUE la
 * connexion (lot 2). Elles LÈVENT plutôt que de rendre une valeur inerte : un test qui les atteindrait a
 * changé de sujet sans le savoir, et mieux vaut qu'il le dise bruyamment.
 */
export const aucunePubDeRoute: Pick<PubsRouteDeps, 'listerPubs' | 'creerPub' | 'publierPub'> = {
  listerPubs: async () => [],
  creerPub: () => { throw new Error('aucunePubDeRoute : creerPub ne devrait pas être appelée'); },
  publierPub: () => { throw new Error('aucunePubDeRoute : publierPub ne devrait pas être appelée'); },
};
