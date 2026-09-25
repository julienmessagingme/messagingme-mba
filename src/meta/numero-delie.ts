import { cacheCourt } from '../lib/cache-court';

/**
 * LE NUMÉRO DÉLIÉ, VU DU POINT DE PASSAGE DES ENVOIS (migration 0180, bloc « Canaux et services » de l'Accueil).
 *
 * Délier le numéro d'un espace ne touche à rien chez Meta : le numéro reste relié à son compte WhatsApp, et Meta
 * accepterait nos envois. C'est donc NOUS qui devons refuser, et au seul endroit que tous les envois traversent :
 * `MetaClientFactory.clientForTenant` (campagne, scénario, automation, réponse d'Inbox, API publique, MCP).
 * Refuser plus haut, chemin par chemin, laisserait passer le prochain chemin d'envoi écrit sans y penser.
 */

/**
 * Le motif, tel que l'opérateur le lit. Aucun identifiant dedans : il part tel quel dans une réponse HTTP (le
 * gestionnaire d'erreurs du serveur rend `err.message` sur un 4xx) et dans la trace d'un parcours.
 */
export const MESSAGE_NUMERO_DELIE =
  'Le numéro WhatsApp de cet espace est délié : aucun message ne part tant qu’un administrateur ne l’a pas relié depuis l’Accueil.';

/**
 * Un envoi refusé parce que le numéro est délié.
 *
 * 🔴 `statusCode = 409`, ET C'EST CE QUI REND LE REFUS LISIBLE PARTOUT D'UN COUP. Le gestionnaire d'erreurs de
 * `src/server.ts` rend `err.message` pour tout code sous 500 : une route d'envoi qui laisse remonter cette
 * erreur (réponse d'Inbox, envoi de modèle, API publique, MCP) répond donc 409 avec la phrase ci-dessus, sans
 * qu'aucune n'ait à la connaître. Sans ce code, elle sortirait en 500 opaque, que Cloudflare remplace par sa
 * propre page.
 */
export class NumeroDelieError extends Error {
  readonly statusCode = 409;
  constructor(readonly phoneNumberId: string) {
    super(MESSAGE_NUMERO_DELIE);
    this.name = 'NumeroDelieError';
  }
}

/**
 * Durée de vie de la réponse « délié ou non ».
 *
 * 🔴 CE CACHE EST UNE DÉCISION, ET SA FENÊTRE EST ASSUMÉE. `cache-court.ts` prévient qu'il convient à ce qui
 * tolère quelques secondes de retard, « jamais à une décision ». Celle-ci en est une, mais sans cache la garde
 * coûterait une requête PAR ENVOI : le runtime de scénario construit un client par message (`wiring.ts`), et le
 * dépôt a déjà retiré ce genre de lecture par destinataire (`numero-espace.ts`). Cinq secondes, c'est le pas
 * auquel un run de campagne relit son statut (`DEFAULT_STATUS_POLL_MS`) : les deux effets du geste « Délier »
 * (la campagne en pause, l'envoi refusé) tombent donc dans la MÊME fenêtre.
 *
 * Coût : au plus une lecture par clé primaire par numéro, toutes les cinq secondes, par process (API et worker
 * ont chacun le leur), mutualisée entre les appels simultanés.
 *
 * ⚠️ Les DEUX réponses sont gardées, contrairement au numéro de l'espace, parce que les deux deviennent fausses
 * au même rythme (un clic) et que la fenêtre est la même dans les deux sens : un envoi peut encore partir cinq
 * secondes après « Délier », ou être refusé cinq secondes après « Relier ». Dans le process qui porte la route,
 * le geste vide le cache (`invaliderTout`) : la fenêtre n'existe alors que dans l'autre process.
 */
export const NUMERO_DELIE_TTL_MS = 5_000;

export interface GardeNumeroDelie {
  /** Le numéro est-il délié ? `false` pour un numéro inconnu (aucune ligne), c'est-à-dire le comportement d'avant. */
  estDelie(phoneNumberId: string): Promise<boolean>;
  /** Oublie toutes les réponses : à appeler après « Délier » ou « Relier », dans le process qui l'a fait. */
  invaliderTout(): void;
}

/** UNE instance par process : deux instances auraient deux caches, donc deux fois les lectures. */
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
