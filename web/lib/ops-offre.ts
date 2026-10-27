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

/** Un entier saisi dans ses bornes : vide = le défaut (`null`). */
function lireEntier(saisie: string, min: number, max: number): number | null | 'invalide' {
  const s = saisie.trim();
  if (s === '') return null;
  if (!/^[0-9]+$/.test(s)) return 'invalide';
  const n = Number(s);
  return n >= min && n <= max ? n : 'invalide';
}

/** Les contacts créés d'une Entreprise (spec offres v2) : vide = sans limite, sinon de 1 à 100 000 000 (les bornes du serveur). */
export const lireContactsEntreprise = (saisie: string): number | null | 'invalide' => lireEntier(saisie, 1, 100_000_000);

/** La commission négociée d'une Entreprise : vide = 10 %, sinon un ENTIER de 0 à 100 (une décimale rendrait la vue illisible). */
export const lireCommissionEntreprise = (saisie: string): number | null | 'invalide' => lireEntier(saisie, 0, 100);

/** Les utilisateurs d'un Business (spec Business) : vide = les cinq de la grille, sinon un entier de 1 à 10 000. */
export const lireUtilisateursBusiness = (saisie: string): number | null | 'invalide' => lireEntier(saisie, 1, 10_000);

/**
 * Le retrait d'une offre posée à la main (Business ou Entreprise) laisse-t-il le numéro fourni sans couverture ? Oui quand
 * aucune autre ne la remplace et que le serveur signale un numéro fourni que rien d'autre ne couvre
 * (`alertes.numeroFourniSansCouverture`) : sa fin se lance, suspendu tout de suite puis résilié 7 jours plus tard. L'écran
 * exige alors une confirmation (jaune 6 de la relecture du sous-lot A).
 */
export function retraitCoupeLeNumero(
  avant: { entreprise: boolean; business: boolean }, apres: { entreprise: boolean; business: boolean }, numeroSansCouverture: boolean,
): boolean {
  return (avant.entreprise || avant.business) && !apres.entreprise && !apres.business && numeroSansCouverture;
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
