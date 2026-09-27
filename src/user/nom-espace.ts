import { z } from 'zod';

/**
 * Le nom d'un espace (`tenants.name`), une seule règle pour ses écrivains publics : le renommage
 * (`PATCH /tenants/:tenantId/nom`) et l'inscription (`POST /auth/signup`, Google compris).
 *
 * Ce nom est le seul repère de l'écran de choix d'espace (avec le rôle), et s'affiche dans /ops et l'e-mail
 * d'invitation. Après `trim()` (qui passe avant les bornes : « 81 espaces » est vide, pas trop long) :
 * - de 1 à `NOM_ESPACE_MAX` caractères ;
 * - aucun caractère de contrôle (`\p{Cc}`) : un retour à la ligne ou un octet nul casserait trois écrans ;
 * - aucun caractère de format ni séparateur de ligne ou de paragraphe (`\p{Cf}`, `\p{Zl}`, `\p{Zp}`) : largeur
 *   nulle, inversion du sens d'écriture (U+202E) ou isolat bidirectionnel rendent un nom invisible ou trompeur ;
 * - aucun remplissage hangul (U+115F, U+1160, U+3164, U+FFA0), des « lettres » qui ne s'affichent pas ;
 * - au moins une lettre ou un chiffre.
 * Prix assumé : `\p{Cf}` contient le liant sans chasse (U+200D) de certains émojis composés ; un émoji simple passe.
 * Deux noms identiques restent possibles : aucune unicité ne pèse sur `tenants.name`.
 */
export const NOM_ESPACE_MAX = 80;

const INVISIBLE_OU_CONTROLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0]/u;
const LETTRE_OU_CHIFFRE = /[\p{L}\p{N}]/u;

export const nomEspace = z.string().trim().min(1).max(NOM_ESPACE_MAX)
  .refine((s) => !INVISIBLE_OU_CONTROLE.test(s))
  .refine((s) => LETTRE_OU_CHIFFRE.test(s));

/** Le message de refus, commun aux deux routes : il dit la borne et ce qui est refusé. */
export const MESSAGE_NOM_ESPACE_INVALIDE =
  `nom de l'espace invalide : de 1 à ${NOM_ESPACE_MAX} caractères, avec au moins une lettre ou un chiffre, sans caractère de contrôle ni caractère invisible`;
