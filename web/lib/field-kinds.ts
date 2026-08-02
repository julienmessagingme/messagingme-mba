// Source RUNTIME des types de champ perso. `UserFieldKind` en dérive (une seule source de vérité côté front).
// Module PUR (aucun 'use client', aucun import navigateur) -> importable depuis la suite de tests racine Node.
// DOIT rester en parité avec `USER_FIELD_TYPES` (src/crm/fields.ts) côté serveur : verrouillé par
// tests/web-field-kinds-parity.test.ts (un ajout de type dans un seul des deux fichiers casse le test).
export const USER_FIELD_KINDS = ['text', 'number', 'date', 'datetime', 'boolean', 'url'] as const;
export type UserFieldKind = (typeof USER_FIELD_KINDS)[number];
