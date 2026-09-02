/**
 * LE PLAFOND DE TAILLE D'UNE CAMPAGNE (lot 3 du plan post-audit, 2026-09-02).
 *
 * 🔴 Ce n'est pas un chantier de montée en charge, c'est EMPÊCHER LE SERVEUR D'ACCEPTER PAR ACCIDENT ce que
 * Julien a déjà décidé de ne pas faire. Avant, aucune constante n'existait : le chemin par filtres était
 * borné à 100 000 identifiants par un cap technique enfoui dans le store, la liste explicite n'était bornée
 * que par la taille du corps HTTP, et le chemin « tous les contacts » ne l'était par RIEN.
 *
 * La valeur est celle de Julien, 20 000, et elle vit en configuration (`CAMPAIGN_MAX_RECIPIENTS`) : c'est un
 * garde-fou, pas un objectif de volume, donc il doit pouvoir se relever sans redéployer de code le jour où un
 * vrai client arrive avec plus gros. Pour l'échelle : la base compte aujourd'hui douze contacts, et la plus
 * grosse campagne jamais créée en portait deux.
 *
 * ⚠️ Le refus sort en 422 et JAMAIS en 5xx : Cloudflare remplace le corps de toute réponse 5xx par sa propre
 * page d'erreur, donc un message destiné à l'utilisateur n'y survivrait pas (cf. le CLAUDE.md global).
 */

/** Le plafond par défaut, tranché par Julien le 2026-09-02. */
export const PLAFOND_DESTINATAIRES_DEFAUT = 20_000;

/**
 * Le nombre de destinataires visés est-il refusable ? Rend le MESSAGE de refus, ou `null` si ça passe.
 *
 * Le message porte les deux nombres. Un refus qui dirait seulement « trop de destinataires » obligerait
 * l'opérateur à deviner de combien il dépasse et où est la limite, donc à réessayer à l'aveugle.
 */
export function refusDePlafond(vises: number, plafond: number): string | null {
  if (vises <= plafond) return null;
  return `Cette campagne viserait ${vises.toLocaleString('fr-FR')} destinataires, au-dessus du plafond de ${plafond.toLocaleString('fr-FR')}. Restreignez la sélection.`;
}
