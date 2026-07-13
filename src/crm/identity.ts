/**
 * Encapsulation de l'identité d'un contact (règle unique, réutilisée partout).
 *
 * Un contact WhatsApp est identifié par un NUMÉRO (E.164) OU un BSUID (business-scoped user id, remonté
 * quand le client n'a pas partagé son numéro, post-octobre). La table `contacts` porte les deux colonnes
 * (`phone_e164`, `bsuid`) avec la contrainte « au moins un des deux ». La règle d'affichage/envoi = le
 * numéro s'il existe, sinon le BSUID.
 */

/** Identité messageable d'un contact : le numéro si présent, sinon le BSUID. null si aucun. */
export function contactIdentity(phoneE164: string | null | undefined, bsuid: string | null | undefined): string | null {
  return phoneE164 ?? bsuid ?? null;
}

/**
 * Classe le `wa_id` d'un message entrant en numéro OU BSUID. Un `wa_id` de 7 à 15 chiffres est un numéro
 * (E.164, max 15 chiffres) -> on le stocke `'+' + chiffres` (cohérent avec le matching `'+' || wa_id`
 * de l'inbox). Tout le reste (plus long, ou non numérique) est traité comme un BSUID opaque.
 * ⚠️ Heuristique : à confirmer/ajuster le jour où Meta nous enverra un vrai BSUID en prod (aucun trafic
 * BSUID aujourd'hui -> 100 % des `wa_id` actuels sont des numéros <= 15 chiffres, donc zéro risque).
 */
export function classifyWaId(waId: string): { phoneE164?: string; bsuid?: string } {
  const t = waId.trim();
  if (/^\d{7,15}$/.test(t)) return { phoneE164: `+${t}` };
  return { bsuid: t };
}
