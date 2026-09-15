import { cacheCourt } from '../lib/cache-court';
import type { QualityRating } from './types';

/**
 * LA NOTE DE QUALITÉ DU NUMÉRO, LUE UNE FOIS ET PAS UNE FOIS PAR DESTINATAIRE.
 *
 * 🔴 CE QUE ÇA COÛTAIT. `engine.ts` appelle `quality.getRating(...)` DANS la boucle d'envoi, et
 * `PgQualityProvider.getRating` est un `select quality_rating from phone_numbers where id = $1`. Le numéro ne
 * change pas de tout le run : sur une campagne de 5 000 destinataires, c'était 5 000 fois la même question,
 * sur un pool de 8 connexions partagé avec les tours d'agent et les webhooks.
 *
 * 🔴 POURQUOI METTRE EN CACHE NE DÉSARME PAS LE GARDE-FOU, et c'est la seule chose qui compte ici. Cette note
 * sert à METTRE LA CAMPAGNE EN PAUSE quand Meta passe le numéro au ROUGE (`qualityGate`,
 * `src/campaign/guardrails.ts:31`). Mettre en cache une valeur qui commande un arrêt d'urgence demande une
 * justification, pas une intuition. La voici, mesurée : la colonne n'est PAS écrite en temps réel. Elle est
 * rafraîchie par le balayage `statut-numeros` du worker, dont la cadence par défaut est de
 * `PHONE_STATUS_SWEEP_INTERVAL_MS`, soit **vingt minutes** (`src/config.ts`). La lire cinq mille fois ne rend
 * donc pas cinq mille valeurs fraîches, mais cinq mille copies d'une valeur qui ne peut pas bouger plus vite
 * que ça. Un cache court ne retarde rien qui ne soit déjà retardé de vingt minutes par construction.
 *
 * ⚠️ CETTE JUSTIFICATION TIENT À UN CHIFFRE QUI PEUT CHANGER. Le jour où la qualité arriverait par un webhook
 * Meta plutôt que par un balayage, elle deviendrait fausse et ce cache devrait sauter. Aucun webhook de
 * qualité n'est souscrit ni analysé aujourd'hui, vérifié dans `src/webhooks/`.
 */

/**
 * Durée de vie. Deux ordres de grandeur sous la cadence du balayage qui alimente la colonne : le cache ne peut
 * donc pas devenir la raison pour laquelle une note au ROUGE est vue en retard.
 */
export const NOTE_QUALITE_TTL_MS = 30_000;

export function creerNoteDeQualite(
  lire: (phoneNumberId: string) => Promise<QualityRating>,
  ttlMs: number = NOTE_QUALITE_TTL_MS,
  maintenant: () => number = Date.now,
): (phoneNumberId: string) => Promise<QualityRating> {
  const cache = cacheCourt<QualityRating>(ttlMs, maintenant);
  return (phoneNumberId: string) => cache.lire(phoneNumberId, () => lire(phoneNumberId));
}
