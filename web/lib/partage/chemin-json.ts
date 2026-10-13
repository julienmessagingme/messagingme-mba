/**
 * Chemins des valeurs d'un JSON tiers, construits par la console et relus par le serveur.
 * Une clé contenant un point ou un crochet n'est pas adressable : aucun échappement n'est inventé.
 */

export type SegmentChemin = { cle: string } | { index: number };

const CLE_ADRESSABLE = /^[^.[\]]+$/;
const CHEMIN_RE = /^(?:[^.[\]]+|\[\d{1,6}\])(?:\.[^.[\]]+|\[\d{1,6}\])*$/;
const JETON_RE = /\[(\d{1,6})\]|\.?([^.[\]]+)/g;

/** Les chemins plus longs sont refusés lors de l'enregistrement d'un mapping. */
export const LONGUEUR_CHEMIN_MAX = 300;

/** Ajoute une clé d'objet, ou rend null si elle ne pourra pas être relue. */
export function cheminPourCle(base: string | null, cle: string): string | null {
  if (base === null || !CLE_ADRESSABLE.test(cle)) return null;
  const chemin = base === '' ? cle : `${base}.${cle}`;
  return chemin.length <= LONGUEUR_CHEMIN_MAX ? chemin : null;
}

/** Ajoute un index de tableau, ou rend null s'il ne pourra pas être relu. */
export function cheminPourIndex(base: string | null, index: number): string | null {
  if (base === null || !Number.isInteger(index) || index < 0 || index > 999999) return null;
  const chemin = `${base}[${index}]`;
  return chemin.length <= LONGUEUR_CHEMIN_MAX ? chemin : null;
}

/** Découpe un chemin bien formé en segments, ou rend null. Les espaces extérieurs sont ignorés. */
export function parseChemin(chemin: string): SegmentChemin[] | null {
  const brut = typeof chemin === 'string' ? chemin.trim() : '';
  if (brut === '' || brut.length > LONGUEUR_CHEMIN_MAX || !CHEMIN_RE.test(brut)) return null;

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

export function cheminValide(chemin: string): boolean {
  return parseChemin(chemin) !== null;
}

/** Lit uniquement les propriétés propres ; un chemin absent ou illisible ne lève jamais. */
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
    if (!Object.prototype.hasOwnProperty.call(courant, s.cle)) return undefined;
    courant = (courant as Record<string, unknown>)[s.cle];
  }
  return courant;
}

/** Seuls les scalaires finis peuvent alimenter un champ de contact. */
export function estScalaire(v: unknown): v is string | number | boolean {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  return typeof v === 'number' && Number.isFinite(v);
}
