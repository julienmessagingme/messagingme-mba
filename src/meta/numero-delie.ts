import { cacheCourt } from '../lib/cache-court';

/**
 * Le numéro délié, vu du point de passage des envois. Délier ne touche à rien chez Meta, qui accepterait nos
 * envois : c'est donc nous qui refusons, dans `MetaClientFactory.clientForTenant`, que tous les envois traversent.
 * Refuser chemin par chemin laisserait passer le prochain chemin d'envoi.
 */

/**
 * Le motif, tel que l'opérateur le lit. Aucun identifiant dedans : il part tel quel dans une réponse HTTP (le
 * gestionnaire d'erreurs du serveur rend `err.message` sur un 4xx) et dans la trace d'un parcours.
 */
export const MESSAGE_NUMERO_DELIE =
  'Le numéro WhatsApp de cet espace est délié : aucun message WhatsApp ne part tant qu’un administrateur ne l’a pas relié depuis l’Accueil.';

/**
 * Un envoi refusé parce que le numéro est délié. `statusCode = 409` : le gestionnaire d'erreurs de
 * `src/server.ts` rend `err.message` sous 500, donc une route qui laisse remonter l'erreur répond un 409 lisible
 * au lieu d'un 500 opaque. Trois surfaces la traduisent elles-mêmes, leur enveloppe n'étant pas `{ error }` :
 * `POST /v1/messages/whatsapp`, `POST /v1/sends` (refus avant création) et le serveur MCP (`RefusOutil`).
 */
export class NumeroDelieError extends Error {
  readonly statusCode = 409;
  constructor(readonly phoneNumberId: string) {
    super(MESSAGE_NUMERO_DELIE);
    this.name = 'NumeroDelieError';
  }
}

/**
 * Durée de vie de la réponse « délié ou non ». Décision mise en cache, fenêtre assumée : sans cache, la garde
 * coûterait une requête par envoi (le runtime de scénario construit un client par message).
 *
 * Les deux réponses sont gardées. La copie de l'API qui sert la route vide son cache au geste (`invaliderTout`) ;
 * dans les autres copies de l'API et dans le worker, l'ancienne réponse peut survivre jusqu'à cinq secondes (aucune
 * invalidation ne traverse les processus, et c'est accepté : la fenêtre est bornée par cette durée) :
 * - après « Délier », un envoi peut encore partir ; une campagne s'arrête quand son run relit son statut ;
 * - après « Relier », un envoi peut être refusé à tort ; une campagne n'écrit pas de pause pour autant
 *   (`numerosDelies.pauserCampagne` relit la base sans ce cache) et le destinataire est rendu à la file.
 * Un parcours qui démarre est vérifié avant ses effets (`verifierNumeroWhatsApp`, qui lit ce même cache).
 */
export const NUMERO_DELIE_TTL_MS = 5_000;

export interface GardeNumeroDelie {
  /** Le numéro est-il délié ? `false` pour un numéro inconnu (aucune ligne). */
  estDelie(phoneNumberId: string): Promise<boolean>;
  /** Oublie toutes les réponses : à appeler après « Délier » ou « Relier », dans le process qui l'a fait. */
  invaliderTout(): void;
}

/** Une instance par process : deux instances auraient deux caches, donc deux fois les lectures. */
export function creerGardeNumeroDelie(
  lire: (phoneNumberId: string) => Promise<boolean>,
  ttlMs: number = NUMERO_DELIE_TTL_MS,
  maintenant: () => number = Date.now,
): GardeNumeroDelie {
  const cache = cacheCourt<boolean>(ttlMs, maintenant);
  return {
    estDelie: (phoneNumberId) => cache.lire(phoneNumberId, () => lire(phoneNumberId)),
    invaliderTout: () => cache.invaliderPrefixe(''),
  };
}
