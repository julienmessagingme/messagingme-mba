/**
 * Identité WhatsApp d'un contact, côté SERVEUR.
 *
 * Un contact WhatsApp est identifié par un NUMÉRO (E.164) OU un BSUID (business-scoped user id, remonté
 * quand le client n'a pas partagé son numéro, post-octobre). La table `contacts` porte les deux colonnes
 * (`phone_e164`, `bsuid`) avec la contrainte « au moins un des deux ».
 *
 * ⚠️ Ce module ne prétend PAS être la source unique de la règle « numéro sinon BSUID ». Cette règle
 * d'AFFICHAGE vit côté front (`web/lib/api.ts`, `contactIdentity`) et est réécrite à la main dans
 * `src/api/sends-build.ts` et `src/campaign/build.ts`. Un `contactIdentity` serveur a existé ici en se
 * décrivant comme « réutilisé partout » alors qu'il n'avait aucun appelant : supprimé le 2026-07-18.
 * Factoriser les trois occurrences restantes est un vrai chantier, pas un commentaire.
 */

/**
 * WhatsApp ID (wa_id) d'un contact : les chiffres du numéro SANS « + » s'il existe, sinon le BSUID. C'est la clé
 * de routage WhatsApp telle que Meta l'émet (cf. `classifyWaId` : un numéro est stocké `'+' + chiffres`). null si aucun.
 */
export function waIdOf(phoneE164: string | null | undefined, bsuid: string | null | undefined): string | null {
  if (phoneE164) return phoneE164.replace(/[^0-9]/g, '');
  return bsuid ?? null;
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
