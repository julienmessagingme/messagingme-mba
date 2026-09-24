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
export const aucunePubDeRoute: Pick<PubsRouteDeps,
  'listerPubs' | 'creerPub' | 'publierPub' | 'lirePub' | 'basculerPub'
  | 'listerBrouillons' | 'lireBrouillon' | 'creerBrouillon' | 'majBrouillon' | 'supprimerBrouillon'> = {
  listerPubs: async () => [],
  lirePub: async () => null,
  creerPub: () => { throw new Error('aucunePubDeRoute : creerPub ne devrait pas être appelée'); },
  publierPub: () => { throw new Error('aucunePubDeRoute : publierPub ne devrait pas être appelée'); },
  basculerPub: () => { throw new Error('aucunePubDeRoute : basculerPub ne devrait pas être appelée'); },
  /**
   * Les brouillons (migration 0171). Les LECTURES rendent le vide, les ÉCRITURES lèvent.
   *
   * 🔴 L'ASYMÉTRIE EST LA MÊME QUE CI-DESSUS ET ELLE EST DÉLIBÉRÉE. Une lecture qui rend le vide laisse un
   * test monter l'écran sans s'occuper des brouillons ; une écriture qui rendrait silencieusement un
   * succès ferait passer pour vert un test qui appelle une route qu'il ne croyait pas appeler. Un test qui
   * veut écrire le dit en surchargeant, et c'est alors visible dans SON fichier.
   */
  listerBrouillons: async () => [],
  lireBrouillon: async () => null,
  creerBrouillon: () => { throw new Error('aucunePubDeRoute : creerBrouillon ne devrait pas être appelée'); },
  majBrouillon: () => { throw new Error('aucunePubDeRoute : majBrouillon ne devrait pas être appelée'); },
  supprimerBrouillon: () => { throw new Error('aucunePubDeRoute : supprimerBrouillon ne devrait pas être appelée'); },
};
