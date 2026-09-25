import { z } from 'zod';

/**
 * LE NOM D'UN ESPACE (`tenants.name`), tel que ses DEUX écrivains publics l'acceptent : le renommage depuis
 * Compte & équipe (`PATCH /tenants/:tenantId/nom`) et l'inscription (`POST /auth/signup`). L'inscription par
 * Google construit le sien (`Espace de <nom Google>`) et passe par la même règle.
 *
 * 🔴 UNE SEULE RÈGLE POUR LES DEUX, et c'est tout l'intérêt de ce module (relecture du 2026-09-25) : le renommage
 * la tenait seul, et l'inscription laissait entrer un nom de 500 Ko ou un saut de ligne. Un invariant tenu par un
 * seul de ses écrivains n'en est pas un.
 *
 * Ce nom est le SEUL repère de l'écran de choix d'espace à la connexion (avec le rôle), il s'affiche dans /ops et
 * dans l'e-mail d'invitation. D'où, après `trim()` et dans cet ordre :
 * - de 1 à `NOM_ESPACE_MAX` caractères ;
 * - aucun caractère de CONTRÔLE (`\p{Cc}` : C0, DEL, C1) : un retour à la ligne ou un octet nul casserait trois
 *   écrans à la fois ;
 * - aucun caractère de FORMAT ni séparateur de ligne ou de paragraphe (`\p{Cf}`, `\p{Zl}`, `\p{Zp}`) : un espace
 *   de largeur nulle, une inversion du sens d'écriture (U+202E) ou un isolat bidirectionnel rendent un nom
 *   invisible ou trompeur à l'écran de choix ;
 * - aucun caractère de REMPLISSAGE hangul (U+115F, U+1160, U+3164, U+FFA0) : ce sont des « lettres » pour
 *   Unicode, mais elles ne s'affichent pas ;
 * - au moins une lettre ou un chiffre : un nom fait de ponctuation ou de blancs exotiques ne se distingue de rien.
 *
 * ⚠️ PRIX ASSUMÉ : `\p{Cf}` contient le liant sans chasse (U+200D), qui compose certains émojis (famille, métiers).
 * Un nom d'espace est un nom d'entreprise ; un émoji simple passe toujours.
 *
 * ⚠️ `trim()` passe AVANT les bornes (Zod 4 applique ses vérifications dans l'ordre) : « 81 espaces » est vide, pas
 * trop long, et un nom entouré d'espaces se compte sans eux.
 *
 * ⚠️ DEUX NOMS IDENTIQUES RESTENT POSSIBLES : aucune unicité ne pèse sur `tenants.name`, et l'écran de choix
 * n'affiche que le nom et le rôle. Y ajouter un discriminant est un chantier à part.
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
