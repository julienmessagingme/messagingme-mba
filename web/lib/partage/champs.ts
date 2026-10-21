/**
 * Les champs d'un contact que le serveur et la console doivent nommer pareil : les types d'un champ perso, les
 * champs de base (« système ») et les champs socle.
 */

/** Les types d'un champ perso : la console les propose, le serveur les accepte (la base les contraint aussi, ce que
 *  `tests/integration/user-fields-types.integration.test.ts` vérifie). */
export const USER_FIELD_KINDS = ['text', 'number', 'date', 'datetime', 'boolean', 'url'] as const;
export type UserFieldKind = (typeof USER_FIELD_KINDS)[number];

/**
 * Les champs de BASE, dans l'ordre d'affichage : attributs du contact (`name`, `phone`, `bsuid`, `wa_id`, lus hors de
 * `contacts.fields`) et champs socle (`prenom`, `email`). Non supprimables, non renommables. Leur code public se
 * calcule (`fld_<code>_sys_<clé>`) et le serveur le résout sans toucher la base.
 */
export const SYSTEM_FIELD_KEYS = ['name', 'prenom', 'nom_de_famille', 'phone', 'bsuid', 'wa_id', 'email'] as const;
export type SystemFieldKey = (typeof SYSTEM_FIELD_KEYS)[number];

/**
 * Le libellé de chaque champ de base, `[fr, en]`. La console l'affiche ; le serveur refuse qu'un champ perso porte
 * l'un d'eux, dans l'une ou l'autre langue, sinon il fabriquerait un doublon indiscernable.
 */
export const SYSTEM_FIELD_LABELS: Readonly<Record<SystemFieldKey, readonly [string, string]>> = {
  // Le nom du PROFIL WhatsApp (`contacts.profile_name`), que chaque message entrant réécrit : « Nom WhatsApp » depuis
  // qu'un vrai « Nom » existe (2026-10-21), sinon deux champs de base portaient le même libellé.
  name: ['Nom WhatsApp', 'WhatsApp name'],
  prenom: ['Prénom', 'First name'],
  // Le nom de famille, rangé sur la fiche (`contacts.fields`) et jamais écrasé. Clé `nom_de_famille` et non `nom` :
  // `nom` désigne déjà le nom du profil dans les connecteurs, les paramètres d'outils et les adresses de boutons.
  nom_de_famille: ['Nom', 'Last name'],
  phone: ['Téléphone', 'Phone'],
  bsuid: ['BSUID', 'BSUID'],
  wa_id: ['WhatsApp ID', 'WhatsApp ID'],
  email: ['Email', 'Email'],
};

/**
 * Les champs SOCLE : des champs de base rangés dans `contacts.fields`, que le serveur MATÉRIALISE à la première
 * écriture (avec ce libellé et ce type). Ils n'existent donc pas dans `user_fields` tant que personne ne les a
 * remplis : la fiche contact leur donne une ligne dédiée, toujours affichée, même vide.
 */
export const SOCLE_FIELDS: ReadonlyArray<{ key: SystemFieldKey; label: string; type: UserFieldKind }> = [
  { key: 'prenom', label: 'Prénom', type: 'text' },
  { key: 'nom_de_famille', label: 'Nom', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
];
