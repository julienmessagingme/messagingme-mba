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
  'Le numéro WhatsApp de cet espace est délié : aucun message WhatsApp ne part tant qu’un administrateur ne l’a pas relié depuis l’Accueil.';

/**
 * Un envoi refusé parce que le numéro est délié.
 *
 * 🔴 `statusCode = 409`, ET C'EST CE QUI REND LE REFUS LISIBLE SUR LES ROUTES DE LA CONSOLE D'UN COUP. Le
 * gestionnaire d'erreurs de `src/server.ts` rend `err.message` pour tout code sous 500 : une route qui laisse
 * remonter cette erreur (réponse d'Inbox, envoi de modèle) répond donc 409 `{ error }` avec la phrase ci-dessus,
 * sans avoir à la connaître. Sans ce code, elle sortirait en 500 opaque, que Cloudflare remplace par sa page.
 *
 * ⚠️ TROIS SURFACES NE S'EN REMETTENT PAS À CE GESTIONNAIRE, parce que leur enveloppe n'est pas `{ error }` :
 * - `POST /v1/messages/whatsapp` l'attrape pour rendre `{ error, code: 'number_unlinked' }` (`v1-messages.ts`) ;
 * - `POST /v1/sends` refuse AVANT de créer l'envoi, par une lecture de la garde (`v1-sends.ts`), en 409
 *   `number_unlinked` : sans ce refus, l'envoi était accepté en 201 puis restait en pause sans raison visible ;
 * - le serveur MCP la traduit en `RefusOutil` (`reply_in_open_window`, `src/mcp/outils.ts`) : sans quoi elle
 *   sortait en `-32603` « échec interne », et l'agent tiers réessayait au lieu de lire la raison.
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
 * dépôt a déjà retiré ce genre de lecture par destinataire (`numero-espace.ts`).
 *
 * Coût : au plus une lecture par clé primaire par numéro, toutes les cinq secondes, par process (API et worker
 * ont chacun le leur), mutualisée entre les appels simultanés.
 *
 * ⚠️ Les DEUX réponses sont gardées, contrairement au numéro de l'espace, parce que les deux deviennent fausses
 * au même rythme (un clic). Dans le process qui porte la route, le geste vide le cache (`invaliderTout`) ; dans
 * l'autre (le worker), la réponse d'avant le geste peut survivre jusqu'à cinq secondes, et la fenêtre a deux sens :
 *
 * - APRÈS « DÉLIER », UN ENVOI PEUT ENCORE PARTIR du worker pendant ce délai. Une campagne de modèles n'interroge
 *   même pas cette garde en cours de run : son client est construit une fois, au démarrage. Elle s'arrête quand
 *   le run relit son statut, que « Délier » a passé en pause (au plus `DEFAULT_STATUS_POLL_MS`, cinq secondes).
 * - APRÈS « RELIER », UN ENVOI PEUT ÊTRE REFUSÉ à tort pendant ce délai. Une campagne n'écrit pas de pause pour
 *   autant : sa pause s'écrit en une instruction qui relit la base SANS ce cache (`pauserSiNumeroDelie`,
 *   `run-job.ts` et `engine.ts`) et, reliée, rien n'est écrit : le destinataire en vol est rendu à la file et le
 *   balayage de reprise relance la campagne. Seul le destinataire d'un étage « message et scénario » reste `sent`,
 *   son message parti et son scénario non démarré. Une automation efface son tir (`runner.ts`, sauf `avant_date`),
 *   donc le prochain événement la redéclenche. La suite d'un parcours qu'une réponse fait avancer échoue comme tout
 *   envoi refusé, et se lit dans le journal des échecs d'avance.
 *
 * ⚠️ UN PARCOURS QUI DÉMARRE est vérifié AVANT ses effets (`WorkflowExecutorDeps.verifierNumeroWhatsApp`, appelée
 * par `runFrom` dès que le parcours enverra par WhatsApp) : l'e-mail ou l'appel API placés avant le premier envoi
 * WhatsApp ne partent donc pas, et ne se rejouent pas au « Relier ». Cette vérification lit ce même cache.
 *
 * L'Inbox et l'API publique envoient depuis le process qui porte la route : le geste y vide le cache, sans fenêtre.
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
