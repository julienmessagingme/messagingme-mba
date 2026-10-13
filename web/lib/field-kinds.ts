// Les types de champ perso viennent du dossier partagé avec le serveur ; ce module PUR y ajoute leurs libellés.
import type { UserFieldKind } from './partage/champs';

export { USER_FIELD_KINDS, type UserFieldKind } from './partage/champs';

/**
 * Libellé de chaque type, `[fr, en]`. Même convention que `SYSTEM_FIELDS` : ce module est PUR, `useT()` y
 * est inappelable, donc le rendu fait `t(...USER_FIELD_KIND_LABELS[k])`.
 *
 * Posé ici quand un SECOND écran a eu besoin de ces libellés (le mapping d'un webhook, qui doit montrer la
 * nature du champ visé). Les recopier aurait fait diverger deux listes que l'utilisateur voit côte à côte.
 * Typé en `Record` sur `UserFieldKind` : ajouter un type sans son libellé ne compile pas.
 */
export const USER_FIELD_KIND_LABELS: Record<UserFieldKind, [string, string]> = {
  text: ['Texte', 'Text'],
  number: ['Nombre', 'Number'],
  date: ['Date', 'Date'],
  datetime: ['Date et heure', 'Date & time'],
  boolean: ['Oui/Non', 'Yes/No'],
  url: ['Lien', 'Link'],
};
