import type { ZodError } from 'zod';

/**
 * LE MESSAGE D'UN DÉFAUT DE FORME, en français, le CHEMIN d'abord (spec 2026-09-24, § 9 : « fields.adresse :
 * texte attendu »). Le chemin est ce qui fait corriger : il désigne le champ, là où « Invalid input » envoie
 * relire tout le corps.
 *
 * ⚠️ Les messages de zod sont en anglais : on traduit les cas que nos schémas provoquent (formes relevées
 * sur zod 4.4 : `invalid_type` et son `expected`, `too_small` / `too_big` et leur `origin`,
 * `unrecognized_keys`, `invalid_value`). `precisions` remplace la phrase pour un chemin donné, quand la
 * générique ne dit pas assez (une union de cibles, par exemple).
 *
 * ⚠️ Le chemin et les noms de champs inconnus sont BORNÉS avant d'être recopiés : ils viennent de l'appelant,
 * et une clé de 5 000 caractères reviendrait sinon telle quelle dans la réponse.
 *
 * ⚠️ `raisonDeValidation` (`src/api/contacts-upsert.ts`) reste propre aux contacts : ses phrases nomment des
 * champs de fiche.
 */
const TYPES: Readonly<Record<string, string>> = {
  string: 'texte', number: 'nombre', int: 'entier', boolean: 'booléen', array: 'tableau', object: 'objet',
};

/** L'unité d'une borne : des éléments pour un tableau, des caractères pour un texte, rien pour un nombre. */
const unite = (origine: string): string => (origine === 'array' ? ' élément(s)' : origine === 'string' ? ' caractère(s)' : '');

export function messageDeForme(err: ZodError, precisions: Readonly<Record<string, string>> = {}): string {
  const i = err.issues[0];
  if (!i) return 'corps invalide';
  const chemin = i.path.map(String).join('.').slice(0, 80) || 'corps';
  // `hasOwn` : le chemin vient de l'appelant, et `precisions['constructor']` rendrait la fonction `Object`.
  const precision = Object.hasOwn(precisions, chemin) ? precisions[chemin] : undefined;
  if (precision !== undefined) return `${chemin} : ${precision}`;
  switch (i.code) {
    case 'invalid_type':
      return `${chemin} : ${TYPES[i.expected] ?? i.expected} attendu`;
    // Une borne EXCLUSIVE (`.positive()`, `.gt()`, `.lt()`) : « 0 au moins » annoncerait la valeur refusée.
    case 'too_small':
      return i.inclusive === false
        ? `${chemin} : plus de ${String(i.minimum)}${unite(i.origin)}`
        : `${chemin} : ${String(i.minimum)}${unite(i.origin)} au moins`;
    case 'too_big':
      return i.inclusive === false
        ? `${chemin} : moins de ${String(i.maximum)}${unite(i.origin)}`
        : `${chemin} : ${String(i.maximum)}${unite(i.origin)} au plus`;
    case 'unrecognized_keys':
      return `${chemin} : champ inconnu (${i.keys.slice(0, 5).map((k) => k.slice(0, 40)).join(', ')})`;
    case 'invalid_value':
      return `${chemin} : valeur admise ${i.values.map(String).join(' | ')}`;
    default:
      return `${chemin} : valeur invalide`;
  }
}
