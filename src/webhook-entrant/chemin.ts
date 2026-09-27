/**
 * Chemins dans un JSON reçu d'un tiers : `client.tel`, `lignes[0].prix`, `[0].nom`. Module pur.
 *
 * Grammaire dupliquée dans `web/lib/chemin-json.ts`, qui fabrique les chemins que ce module lit : un même jeu de
 * chemins d'or est figé dans les tests des deux côtés. La route de configuration refuse un chemin illisible, donc
 * une divergence se voit en 4xx au lieu d'un mapping muet.
 */

/** Un segment : une clé d'objet, ou un index de tableau. */
export type SegmentChemin = { cle: string } | { index: number };

/**
 * Chemin bien formé : un premier jeton (clé ou index), puis une suite de `.cle` ou `[n]`. Une clé ne peut contenir
 * ni `.` ni `[` ni `]` : `{"a.b": 1}` est inadressable, et on refuse plutôt que d'inventer une syntaxe d'échappement.
 */
const CHEMIN_RE = /^(?:[^.[\]]+|\[\d{1,6}\])(?:\.[^.[\]]+|\[\d{1,6}\])*$/;
const JETON_RE = /\[(\d{1,6})\]|\.?([^.[\]]+)/g;

/** Longueur maximale d'un chemin : au-delà, c'est une erreur. */
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
 * Valeur pointée par un chemin, ou `undefined` si le chemin ne résout pas (clé absente, index hors bornes, traversée
 * d'un scalaire, chemin mal formé). Ne lève jamais : le payload vient d'un tiers.
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
    // Propriétés propres uniquement : sinon `a.constructor` ou `a.__proto__.x` liraient le prototype.
    if (!Object.prototype.hasOwnProperty.call(courant, s.cle)) return undefined;
    courant = (courant as Record<string, unknown>)[s.cle];
  }
  return courant;
}

/**
 * Une valeur est-elle stockable dans un champ de contact ? Seuls les scalaires finis : `contactVars` rend `null` pour
 * toute valeur non primitive, un objet écrit dans un champ donnerait une variable vide dans un template, en silence.
 * `null` est une absence, pas une valeur.
 */
export function estScalaire(v: unknown): v is string | number | boolean {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  return typeof v === 'number' && Number.isFinite(v);
}

/** Plafond de longueur d'une valeur de champ, le même que `validateFieldValue`, sinon l'écriture serait refusée en aval. */
export const LONGUEUR_VALEUR_MAX = 1000;

/**
 * Forme de stockage d'une valeur pointée : une chaîne trimée, ou null si elle n'est pas stockable (non scalaire,
 * vide, trop longue).
 *
 * La longueur est filtrée ici parce que `upsertContactsFromApi` refuse l'enregistrement entier sur une valeur
 * invalide : un téléphone bon serait perdu pour une description trop longue dans un champ voisin. On écarte la
 * seule valeur fautive et on la rapporte. Une valeur invalide pour le type du champ reste un refus complet : c'est
 * une erreur de configuration que l'opérateur doit voir.
 */
export function valeurTexte(v: unknown): string | null {
  if (!estScalaire(v)) return null;
  const s = String(v).trim();
  if (s === '' || s.length > LONGUEUR_VALEUR_MAX) return null;
  return s;
}
