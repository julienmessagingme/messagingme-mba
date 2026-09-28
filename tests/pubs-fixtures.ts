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
  'publicites' | 'creerPub' | 'publierPub' | 'lirePub' | 'basculerPub' | 'brouillons' | 'videos' | 'audiences'> = {
  publicites: { lister: async () => [], archiver: async () => 'introuvable' },
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
  brouillons: {
    lister: async () => [],
    lire: async () => null,
    creer: () => { throw new Error('aucunePubDeRoute : brouillons.creer ne devrait pas être appelée'); },
    mettreAJour: () => { throw new Error('aucunePubDeRoute : brouillons.mettreAJour ne devrait pas être appelée'); },
    supprimer: () => { throw new Error('aucunePubDeRoute : brouillons.supprimer ne devrait pas être appelée'); },
  },
  /**
   * Le dépôt vidéo et les audiences (migration 0187) : tous appellent Meta, donc tous LÈVENT. Un test qui les
   * atteint le déclare en surchargeant.
   */
  videos: {
    demarrer: () => { throw new Error('aucunePubDeRoute : videos.demarrer ne devrait pas être appelée'); },
    transferer: () => { throw new Error('aucunePubDeRoute : videos.transferer ne devrait pas être appelée'); },
    terminer: () => { throw new Error('aucunePubDeRoute : videos.terminer ne devrait pas être appelée'); },
    etat: () => { throw new Error('aucunePubDeRoute : videos.etat ne devrait pas être appelée'); },
  },
  audiences: () => { throw new Error('aucunePubDeRoute : audiences ne devrait pas être appelée'); },
};
