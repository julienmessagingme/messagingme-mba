// Source RUNTIME des types de champ perso. `UserFieldKind` en dérive (une seule source de vérité côté front).
// Module PUR (aucun 'use client', aucun import navigateur) -> importable depuis la suite de tests racine Node.
// DOIT rester en parité avec `USER_FIELD_TYPES` (src/crm/fields.ts) côté serveur : verrouillé par
// tests/web-field-kinds-parity.test.ts (un ajout de type dans un seul des deux fichiers casse le test).
export const USER_FIELD_KINDS = ['text', 'number', 'date', 'datetime', 'boolean', 'url'] as const;
export type UserFieldKind = (typeof USER_FIELD_KINDS)[number];

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
