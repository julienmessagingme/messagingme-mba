/**
 * Chemins dans un JSON reçu d'un tiers : `client.tel`, `lignes[0].prix`, `[0].nom`.
 *
 * Module PUR (aucune IO, aucun import qui tire pg) -> testable sans base, comme `automation/match.ts`.
 *
 * ⚠️ GRAMMAIRE DUPLIQUÉE dans `web/lib/chemin-json.ts`, qui FABRIQUE les chemins depuis l'arbre affiché
 * pendant que ce module les LIT. Les deux ne partagent aucun paquet (le front a son propre tsconfig). Un
 * même jeu de chemins d'or est figé dans les tests des DEUX côtés : c'est lui qui garde l'invariant.
 * Filet supplémentaire : la route de configuration REFUSE un chemin qu'elle ne sait pas lire, donc une
 * divergence se voit tout de suite en 4xx au lieu de produire un mapping muet.
 */

/** Un segment : une clé d'objet, ou un index de tableau. */
export type SegmentChemin = { cle: string } | { index: number };

/**
 * Chemin bien formé : un premier jeton (clé ou index), puis une suite de `.cle` ou `[n]`.
 *
 * Une clé ne peut donc contenir ni `.` ni `[` ni `]`. C'est une VRAIE limite : un tiers a le droit
 * d'émettre `{"a.b": 1}`, et cette clé-là est inadressable. Plutôt que d'inventer une syntaxe
 * d'échappement que personne ne saurait relire dans l'écran, on refuse le chemin ; l'arbre côté front ne
 * propose pas ces feuilles.
 */
const CHEMIN_RE = /^(?:[^.[\]]+|\[\d{1,6}\])(?:\.[^.[\]]+|\[\d{1,6}\])*$/;
const JETON_RE = /\[(\d{1,6})\]|\.?([^.[\]]+)/g;

/** Longueur maximale d'un chemin. Un chemin plus long qu'un tweet n'est pas un chemin, c'est une erreur. */
const LONGUEUR_MAX = 300;

/** Découpe un chemin en segments, ou null s'il est mal formé. Ne touche à aucune donnée. */
export function parseChemin(chemin: string): SegmentChemin[] | null {
  const brut = typeof chemin === 'string' ? chemin.trim() : '';
  if (brut === '' || brut.length > LONGUEUR_MAX) return null;
  if (!CHEMIN_RE.test(brut)) return null;

  const segments: SegmentChemin[] = [];
  JETON_RE.lastIndex = 0;
  let m = JETON_RE.exec(brut);
  while (m !== null) {
    if (m[1] !== undefined) segments.push({ index: Number(m[1]) });
    else if (m[2] !== undefined) segments.push({ cle: m[2] });
    m = JETON_RE.exec(brut);
  }
  return segments.length > 0 ? segments : null;
}

/** Le chemin est-il syntaxiquement lisible ? (sans rien lire) */
export function cheminValide(chemin: string): boolean {
  return parseChemin(chemin) !== null;
}

/**
 * Valeur pointée par un chemin, ou `undefined` si le chemin ne résout pas (clé absente, index hors bornes,
 * traversée d'un scalaire, chemin mal formé). Ne lève JAMAIS : le payload vient d'un tiers.
 */
export function litChemin(racine: unknown, chemin: string): unknown {
  const segments = parseChemin(chemin);
  if (!segments) return undefined;

  let courant: unknown = racine;
  for (const s of segments) {
    if (courant === null || courant === undefined) return undefined;
    if ('index' in s) {
      if (!Array.isArray(courant)) return undefined;
      courant = courant[s.index];
      continue;
    }
    if (typeof courant !== 'object' || Array.isArray(courant)) return undefined;
    // Propriétés PROPRES uniquement. Sans cette garde, `a.constructor` ou `a.__proto__.x` remonteraient des
    // valeurs du prototype : un chemin configuré par un utilisateur lirait du code au lieu de sa donnée.
    if (!Object.prototype.hasOwnProperty.call(courant, s.cle)) return undefined;
    courant = (courant as Record<string, unknown>)[s.cle];
  }
  return courant;
}

/**
 * Une valeur est-elle STOCKABLE dans un champ de contact ?
 *
 * 🔴 Seuls les scalaires. Les valeurs de `contacts.fields` sont stockées en chaîne, et `contactVars`
 * transforme en `null` toute valeur non primitive : un objet ou un tableau écrit dans un champ rendrait la
 * variable VIDE dans un template, sans la moindre erreur. `null` n'est pas non plus une valeur (c'est une
 * absence), et un nombre non fini ne se relit pas.
 */
export function estScalaire(v: unknown): v is string | number | boolean {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Plafond de longueur d'une valeur de champ. MÊME valeur que `validateFieldValue` : la dépasser ferait
 * refuser l'écriture en aval.
 */
export const LONGUEUR_VALEUR_MAX = 1000;

/**
 * Forme de STOCKAGE d'une valeur pointée : une chaîne trimée, ou null si la valeur n'est pas stockable
 * (non scalaire, vide une fois trimée, ou trop longue).
 *
 * 🔴 Pourquoi la LONGUEUR est filtrée ici, alors que la validation par TYPE reste au chemin d'écriture
 * partagé. `upsertContactsFromApi` refuse l'enregistrement ENTIER dès qu'une valeur est invalide : un
 * téléphone parfaitement bon serait perdu parce qu'un tiers a envoyé une description de 3000 caractères
 * dans un champ voisin. Ce cas-là n'est pas une erreur de mapping, c'est une inadéquation de forme que
 * personne n'ira corriger chez le tiers, donc on écarte la seule valeur fautive et on la RAPPORTE.
 *
 * Une valeur invalide pour le TYPE du champ (du texte dans un champ nombre) reste, elle, un refus complet
 * avec sa raison : c'est une erreur de configuration, et la faire disparaître en silence empêcherait
 * l'opérateur de la corriger.
 */
export function valeurTexte(v: unknown): string | null {
  if (!estScalaire(v)) return null;
  const s = String(v).trim();
  if (s === '' || s.length > LONGUEUR_VALEUR_MAX) return null;
  return s;
}
