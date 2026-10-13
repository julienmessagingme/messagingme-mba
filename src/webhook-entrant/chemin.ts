/** Lecture et conversion des valeurs de webhook. La grammaire JSON est partagée avec la console. */
import { estScalaire } from '../../web/lib/partage/chemin-json';

export {
  parseChemin, cheminValide, litChemin, estScalaire,
} from '../../web/lib/partage/chemin-json';
export type { SegmentChemin } from '../../web/lib/partage/chemin-json';

/** Plafond de longueur d'une valeur de champ, identique à `validateFieldValue`. */
export const LONGUEUR_VALEUR_MAX = 1000;

/**
 * Forme stockable d'une valeur pointée : texte trimé, ou null si elle n'est pas scalaire, vide ou trop longue.
 * Une valeur rejetée n'empêche pas l'enregistrement des autres champs du webhook.
 */
export function valeurTexte(v: unknown): string | null {
  if (!estScalaire(v)) return null;
  const s = String(v).trim();
  if (s === '' || s.length > LONGUEUR_VALEUR_MAX) return null;
  return s;
}
