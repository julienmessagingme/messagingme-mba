// Miroir ÉCRAN de `src/contacts/joignabilite.ts`. Les deux builds ne partagent aucun module, d'où la
// recopie ; `tests/web-joignabilite-parity.test.ts` casse si les deux versions divergent.
//
// 🔴 POURQUOI RECOPIER PLUTÔT QUE RÉ-ÉCRIRE UN « c.whatsappJoignable === false » DANS LE COMPOSANT. Parce
// que la règle n'est PAS « la colonne vaut false » : elle a trois états et une péremption, et la fiche doit
// dire exactement ce que le filtre d'audience et le SQL disent du même contact. Une lecture écrite à la main
// dans un JSX afficherait « injoignable » sur une mesure que le filtre, lui, aurait déjà périmée, et
// personne n'irait chercher pourquoi un contact « injoignable » reçoit quand même des campagnes.

export type Verdict = 'oui' | 'non' | 'inconnu';

/** 90 jours. Miroir de `PEREMPTION_WHATSAPP_MS` côté serveur. */
export const PEREMPTION_WHATSAPP_MS = 90 * 86_400_000;

/**
 * PURE, donc testable sans réseau ni horloge.
 *
 * 🔴 `null` rend `inconnu`, jamais `non`. Un contact jamais sollicité n'a pas été jugé, et l'écran doit
 * écrire « Jamais testé ».
 * ⚠️ Une valeur SANS date rend `inconnu` aussi : une mesure sans instant ne peut pas se périmer, donc elle
 * vaudrait pour toujours.
 */
export function verdictWhatsApp(
  valeur: boolean | null,
  mesureLe: Date | null,
  maintenant: Date,
): Verdict {
  if (valeur === null || mesureLe === null) return 'inconnu';
  if (maintenant.getTime() - mesureLe.getTime() > PEREMPTION_WHATSAPP_MS) return 'inconnu';
  return valeur ? 'oui' : 'non';
}
