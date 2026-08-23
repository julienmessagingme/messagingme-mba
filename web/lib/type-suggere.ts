import type { UserFieldKind } from './field-kinds';

/**
 * Propose le TYPE d'un champ à créer, d'après un échantillon de valeur reçue d'un outil tiers.
 *
 * Module PUR. C'est une SUGGESTION, pas une décision : l'utilisateur peut la changer dans le menu, et c'est
 * le serveur qui valide pour de bon (`validateFieldValue`). Une suggestion un peu trop prudente ne coûte
 * qu'un clic ; une suggestion trop hardie ferait créer un champ dont les valeurs suivantes seraient refusées.
 *
 * ⚠️ Les règles de date sont volontairement PLUS ÉTROITES que celles du serveur (`src/crm/date-iso.ts`) :
 * ici on ne cherche qu'à deviner une intention, donc on ne propose « date et heure » que sur une forme
 * évidente. Une divergence entre les deux ne casse rien, elle change juste la valeur préremplie du menu.
 */

/** ISO, avec `T` ou avec une espace : c'est ce qu'envoient les outils qui savent écrire une date. */
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const URL_HTTP = /^https?:\/\/\S+$/i;

export function typeSuggere(valeur: unknown): UserFieldKind {
  if (typeof valeur === 'boolean') return 'boolean';
  if (typeof valeur === 'number') return 'number';
  if (typeof valeur !== 'string') return 'text';

  const v = valeur.trim();
  if (INSTANT.test(v)) return 'datetime';
  if (JOUR.test(v)) return 'date';
  if (URL_HTTP.test(v)) return 'url';
  // ⚠️ Une chaîne de chiffres n'est PAS proposée en nombre : « 0612345678 » et « 75001 » sont des textes,
  // et les créer en nombre perdrait le zéro de tête à la première lecture.
  return 'text';
}
