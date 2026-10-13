/**
 * LES LONGUEURS QUE META ACCEPTE DANS UN TEMPLATE WHATSAPP, relues dans sa documentation le 2026-10-13 (« Template
 * components » et « Media card carousel templates ») : titre 60, corps 1 024, pied de page 60, libellé d'un bouton 25,
 * texte d'une carte de carrousel 160. Au-delà, Meta refuse le template, après l'aller-retour de sa revue.
 *
 * ⚠️ On compte en unités de `String.length`, comme l'attribut `maxLength` des champs qui les bornent déjà : un compteur
 * qui compterait autrement annoncerait « 2 restants » sur un champ qui refuse déjà la frappe. Un emoji en vaut deux,
 * c'est le sens prudent.
 */
export const LIMITES_TEMPLATE = {
  entete: 60,
  corps: 1024,
  pied: 60,
  bouton: 25,
  carteCorps: 160,
} as const;

/** Un nombre écrit comme l'écran le lit, « 1 024 » (espace entre les milliers) : le message suit la constante. */
export function enClair(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Ce qu'il reste à `texte` avant `max` : négatif quand il déborde. */
export function caracteresRestants(texte: string, max: number): number {
  return max - texte.length;
}
