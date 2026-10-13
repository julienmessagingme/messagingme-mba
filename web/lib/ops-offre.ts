/**
 * Les règles de la fenêtre « Offre Entreprise » de `/ops` (`web/app/ops/page.tsx`), à part pour être testées : une
 * page Next ne peut rien exporter d'autre que son composant.
 */

/** Une conservation saisie : vide = le défaut de l'instance (`null`), sinon un entier de 0 (jamais purgée) à 3650. */
export function lireConservation(saisie: string): number | null | 'invalide' {
  const s = saisie.trim();
  if (s === '') return null;
  if (!/^[0-9]+$/.test(s)) return 'invalide';
  const n = Number(s);
  return n <= 3650 ? n : 'invalide';
}

/**
 * La nouvelle conservation peut-elle PURGER des conversations ? Oui dès qu'elle n'est pas « jamais » (0) et qu'on ne
 * sait pas qu'elle allonge l'actuelle : l'actuelle infinie (0) ou inconnue (`null`, le défaut de l'instance) ne se
 * compare pas, et un raccourcissement purge, au prochain passage, ce qui est plus ancien. C'est irréversible.
 */
export function conservationPeutPurger(actuelle: number | null, nouvelle: number | null): boolean {
  if (nouvelle === actuelle) return false;
  if (nouvelle === 0) return false;
  if (nouvelle !== null && actuelle !== null && actuelle !== 0 && nouvelle >= actuelle) return false;
  return true;
}
