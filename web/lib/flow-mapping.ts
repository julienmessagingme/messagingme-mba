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

/**
 * Cible du champ de base « Nom » (profile_name). SENTINELLE `@profile_name` : le `@` ne peut JAMAIS être produit
 * par `slugify` (qui n'émet que `[a-z0-9]` séparés par `_`), donc la cible « Nom » est IMPOSSIBLE à obtenir par
 * collision de slug d'un libellé quelconque. Le routage report vers profile_name (src/webhooks/flow-mapping.ts,
 * PROFILE_NAME_TARGET) ne se déclenche donc QUE sur le choix EXPLICITE du champ de base, jamais par défaut.
 * ⚠️ Doit rester STRICTEMENT égale à PROFILE_NAME_TARGET côté serveur (test anti-drift).
 */
export const PROFILE_NAME_SAVE_KEY = '@profile_name';

/** Un champ de BASE ciblable comme destination d'un champ de formulaire. `key` = cible serveur : `email`/`prenom`
 *  -> contacts.fields ; PROFILE_NAME_SAVE_KEY (« Nom ») -> profile_name (routé au report, sentinelle anti-collision). */
export interface BaseSaveField { key: string; label: string }
export const BASE_SAVE_FIELDS: BaseSaveField[] = [
  { key: PROFILE_NAME_SAVE_KEY, label: 'Nom' },
  { key: 'prenom', label: 'Prénom' },
  { key: 'email', label: 'Email' },
];

const COMBINING = /[̀-ͯ]/g;
const normalizeLabel = (s: string): string => s.normalize('NFD').replace(COMBINING, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Synonymes (normalisés) -> champ de base. Correspondance EXACTE sur le libellé normalisé : « prenom » et
// « nom » ne se marchent donc jamais dessus (pas de piège de sous-chaîne « nom » ⊂ « prenom »).
const SYNONYMS: Record<string, string[]> = {
  email: ['email', 'e-mail', 'mail', 'courriel', 'adresse email', 'adresse e-mail', 'adresse mail'],
  prenom: ['prenom', 'first name', 'firstname', 'given name'],
  [PROFILE_NAME_SAVE_KEY]: ['nom', 'name', 'nom de famille', 'last name', 'lastname', 'surname', 'family name'],
};

/**
 * Suggère le champ de BASE correspondant au libellé d'un champ de formulaire (ex. « Email » -> email, « Nom » ->
 * name, « Prénom » -> prenom), insensible à la casse et aux accents. null si le libellé ne correspond à aucun
 * champ de base. Sert à proposer « enregistrer sur le champ de base » dans le builder (jamais imposé).
 */
export function suggestBaseField(label: string): BaseSaveField | null {
  const n = normalizeLabel(label);
  if (n === '') return null;
  for (const f of BASE_SAVE_FIELDS) {
    if (SYNONYMS[f.key]!.includes(n)) return f;
  }
  return null;
}
