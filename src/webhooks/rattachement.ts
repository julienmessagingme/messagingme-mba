import type { InboundMessage } from './inbound';

/**
 * Le rattachement d'un élément du webhook à l'espace de son numéro business. `handleWebhookJob` le fait une fois
 * pour tout le job et passe aux étapes des éléments déjà rattachés : aucune étape ne lit le numéro elle-même, sinon
 * un message entrant coûterait une lecture par étape.
 */

/** Ce que la réception lit pour rattacher un numéro à son espace (`PgInboxStore.phoneNumberTenant`). */
export interface NumeroVersEspace {
  /** Espace propriétaire du numéro business, `null` si le numéro nous est inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
}

/** L'espace d'un numéro business, `null` si inconnu. */
export type EspaceDuNumero = (phoneNumberId: string) => Promise<string | null>;

/**
 * Un message entrant et l'espace de son numéro. `tenantId` à `null` : numéro inconnu, et chaque étape garde sa
 * réponse à ce cas (se taire ou journaliser).
 */
export interface EntrantRattache {
  message: InboundMessage;
  tenantId: string | null;
}

/**
 * Une lecture par numéro distinct pour la durée d'un job : la réponse est retenue, `null` compris. Rien ne survit
 * au job, donc un numéro relié entre deux webhooks est vu au suivant. Une lecture en échec lève et n'est pas
 * retenue : l'appelant décide si elle fait échouer le job.
 */
export function uneLectureParNumero(numeros: NumeroVersEspace): EspaceDuNumero {
  const lus = new Map<string, string | null>();
  return async (phoneNumberId) => {
    const connu = lus.get(phoneNumberId);
    if (connu !== undefined) return connu;
    const tenantId = await numeros.phoneNumberTenant(phoneNumberId);
    lus.set(phoneNumberId, tenantId);
    return tenantId;
  };
}

/**
 * Rattache chaque message à son espace, dans l'ordre du payload. Les lectures se font une à une : la première en
 * échec arrête tout, et aucune n'est lancée pour rien.
 */
export async function rattacherLesEntrants(messages: readonly InboundMessage[], espaceDe: EspaceDuNumero): Promise<EntrantRattache[]> {
  const entrants: EntrantRattache[] = [];
  for (const message of messages) entrants.push({ message, tenantId: await espaceDe(message.phoneNumberId) });
  return entrants;
}
