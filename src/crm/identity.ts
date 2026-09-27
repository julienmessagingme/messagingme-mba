/**
 * Identité WhatsApp d'un contact, côté serveur : un numéro (E.164) ou un BSUID (business-scoped user id, quand
 * le client n'a pas partagé son numéro). `contacts` porte les deux colonnes, avec « au moins un des deux ».
 * La règle d'affichage « numéro sinon BSUID » n'est pas centralisée ici : elle vit côté front
 * (`web/lib/api.ts`, `contactIdentity`) et est réécrite dans `src/api/sends-build.ts` et `src/campaign/build.ts`.
 */

/**
 * WhatsApp ID (wa_id) d'un contact : les chiffres du numéro sans « + » s'il existe, sinon le BSUID ; null si aucun.
 * C'est la clé de routage telle que Meta l'émet (cf. `classifyWaId` : un numéro est stocké `'+' + chiffres`).
 */
export function waIdOf(phoneE164: string | null | undefined, bsuid: string | null | undefined): string | null {
  if (phoneE164) return phoneE164.replace(/[^0-9]/g, '');
  return bsuid ?? null;
}

/**
 * Même règle pour une cible d'envoi qui porte les deux identités dans un seul champ (le `toE164` d'un
 * destinataire de campagne : E.164 avec « + », ou BSUID opaque). Une divergence créerait deux conversations
 * pour un même contact.
 */
export function waIdOfTarget(toE164OrBsuid: string): string {
  return toE164OrBsuid.startsWith('+') ? toE164OrBsuid.replace(/[^0-9]/g, '') : toE164OrBsuid;
}

/**
 * Classe le `wa_id` d'un message entrant en numéro ou BSUID. 7 à 15 chiffres = numéro (E.164), stocké
 * `'+' + chiffres` (cohérent avec le matching `'+' || wa_id` de l'inbox) ; tout le reste est un BSUID opaque.
 * Heuristique à confirmer le jour où Meta enverra un vrai BSUID.
 */
export function classifyWaId(waId: string): { phoneE164?: string; bsuid?: string } {
  const t = waId.trim();
  if (/^\d{7,15}$/.test(t)) return { phoneE164: `+${t}` };
  return { bsuid: t };
}
