/**
 * Les seuls champs du contact dont un paramètre d'outil peut dériver (`source: 'contact'`).
 *
 * 🔴 Liste fermée : la projection du contact passée au tour peut s'élargir, la surface offerte à un connecteur
 * ne doit pas suivre toute seule. `wa_id` ne vient pas de la projection mais du contexte du tour (signature du
 * webhook Meta).
 */
export const CHAMPS_CONTACT_AUTORISES = ['wa_id', 'nom'] as const;

export type ChampContact = (typeof CHAMPS_CONTACT_AUTORISES)[number];

export function estChampContact(v: unknown): v is ChampContact {
  return typeof v === 'string' && (CHAMPS_CONTACT_AUTORISES as readonly string[]).includes(v);
}

/**
 * La valeur d'un champ personnalisé du contact, lue dans la projection du tour.
 *
 * Porte voisine de la liste fermée, pas un remplacement : l'espace des clés est celui que le client a déclaré
 * (`Bibliothèque > Champs`), et on ne lit que sous `champs` (y atteindre `nom` ou `tags` rouvrirait la clé
 * libre). Une valeur non scalaire rend `null`. Un champ absent rend `null` et l'appel part quand même : un
 * paramètre facultatif ne doit pas bloquer l'outil, l'avertissement se pose au clouage.
 */
export function champDuContact(
  contact: Record<string, unknown> | null,
  cle: string,
): string | number | boolean | null {
  const champs = contact?.champs;
  if (typeof champs !== 'object' || champs === null || Array.isArray(champs)) return null;
  const v = (champs as Record<string, unknown>)[cle];
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
}
