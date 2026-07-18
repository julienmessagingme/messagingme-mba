/**
 * Règles PURES du mapping « champ de formulaire -> champ contact ». Zéro import (ni React, ni Next, ni le reste
 * de lib/) : ce module est testé depuis la suite racine (`tests/web-flow-mapping.test.ts`) par import relatif,
 * ce qui n'est possible que s'il ne tire rien de l'arbre web (le tsconfig racine n'a pas la lib DOM).
 */

/** Clé du champ booléen de consentement par défaut. Miroir de `src/crm/fields.ts` (WHATSAPP_OPTIN_FIELD_KEY) :
 *  un OptIn qui pointe dessus est un mapping PAR DÉFAUT (saveTo vide dans l'éditeur), pas un choix explicite. */
export const WHATSAPP_OPTIN_FIELD_KEY = 'whatsapp_optin';

/**
 * Cible PAR DÉFAUT d'un champ de formulaire : le serveur l'applique tout seul quand `saveTo` est absent.
 *  - consentement (optin) -> le champ booléen de consentement (`whatsapp_optin`), qui ouvre le statut opt-in ;
 *  - tout autre type -> la clé dérivée du champ lui-même.
 */
export function defaultSaveTo(type: string, fieldKey: string): string {
  return type === 'optin' ? WHATSAPP_OPTIN_FIELD_KEY : fieldKey;
}

/**
 * Cette cible stockée est-elle le mapping PAR DÉFAUT (par opposition à un choix EXPLICITE de l'utilisateur) ?
 *
 * Sert au round-trip d'édition (`toBElems`) : un mapping par défaut doit revenir dans l'éditeur avec un `saveTo`
 * VIDE. Sinon l'éditeur ré-sérialiserait une cible explicite que l'utilisateur n'a jamais choisie, et pour un
 * optin le serveur la revaliderait comme cible booléenne, ce qui peut BLOQUER la ré-édition du formulaire.
 * Une cible absente (champ jamais mappé) compte aussi comme défaut.
 */
export function isDefaultSaveTo(type: string, target: string | undefined, fieldKey: string): boolean {
  if (!target) return true;
  return target === defaultSaveTo(type, fieldKey);
}
