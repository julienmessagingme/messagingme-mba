export type ParamSource =
  | { type: 'field'; key: string }
  | { type: 'attribute'; key: 'name' | 'phone' }
  | { type: 'literal'; value: string };

export interface TemplateParam {
  /** Position de la variable dans le template ({{1}} -> 1). */
  position: number;
  source: ParamSource;
  /** Valeur de repli si la source est vide/absente. */
  fallback?: string;
}

export interface ResolvableContact {
  phone_e164?: string | null;
  profile_name?: string | null;
  fields?: Record<string, unknown>;
}

function isValidSource(s: unknown): s is ParamSource {
  if (typeof s !== 'object' || s === null) return false;
  const src = s as { type?: unknown; key?: unknown; value?: unknown };
  if (src.type === 'literal') return typeof src.value === 'string';
  if (src.type === 'field') return typeof src.key === 'string' && src.key !== '';
  if (src.type === 'attribute') return src.key === 'name' || src.key === 'phone';
  return false;
}

/**
 * Valide un paramMapping non fiable (issu d'un body HTTP) : chaque entrée doit avoir une
 * position entière et une source bien formée, et l'ensemble des positions doit être 1..N
 * contigu et unique (même invariant que resolveTemplateParams, mais SANS throw). Retourne
 * le tableau typé si valide, sinon null -> la route répond 400 plutôt que de laisser
 * resolveTemplateParams throw en 500.
 */
export function validateParamMapping(raw: unknown): TemplateParam[] | null {
  if (!Array.isArray(raw)) return null;
  const params: TemplateParam[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const p = item as { position?: unknown; source?: unknown; fallback?: unknown };
    if (typeof p.position !== 'number' || !Number.isInteger(p.position)) return null;
    if (!isValidSource(p.source)) return null;
    if (p.fallback !== undefined && typeof p.fallback !== 'string') return null;
    const tp: TemplateParam = { position: p.position, source: p.source };
    if (typeof p.fallback === 'string') tp.fallback = p.fallback;
    params.push(tp);
  }
  const sorted = [...params].sort((a, b) => a.position - b.position);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i]!.position !== i + 1) return null; // positions non 1..N contiguës/uniques
  }
  return params;
}

/**
 * Valide des « indices » variable -> champ (posés au design d'un template). Contrairement à
 * validateParamMapping, ils sont SPARSE (seules les variables insérées via le sélecteur ont un indice ; les
 * `{{n}}` tapés à la main n'en ont pas) : on n'exige donc PAS une suite 1..N contiguë. Chaque entrée = une
 * position entière >= 1 (unique) + une source bien formée. Retourne les indices typés, ou null si malformé.
 */
export function parseParamHints(raw: unknown): Array<{ position: number; source: ParamSource }> | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: Array<{ position: number; source: ParamSource }> = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const h = item as { position?: unknown; source?: unknown };
    if (typeof h.position !== 'number' || !Number.isInteger(h.position) || h.position < 1) return null;
    if (!isValidSource(h.source)) return null;
    if (seen.has(h.position)) return null; // une position ne peut pas avoir deux sources
    seen.add(h.position);
    out.push({ position: h.position, source: h.source });
  }
  return out;
}

function valueOf(source: ParamSource, c: ResolvableContact): unknown {
  switch (source.type) {
    case 'literal':
      return source.value;
    case 'attribute':
      return source.key === 'name' ? c.profile_name : c.phone_e164;
    case 'field':
      return c.fields?.[source.key];
  }
}

/**
 * Résout les variables d'un template pour un contact : renvoie les valeurs ordonnées
 * par position. Valeur manquante -> fallback -> chaîne vide. C'est la glue « coller les
 * infos du CRM dans les templates ».
 */
export function resolveTemplateParams(params: TemplateParam[], contact: ResolvableContact): string[] {
  const sorted = [...params].sort((a, b) => a.position - b.position);
  // Les params WhatsApp sont positionnels : on exige 1..N contigus et uniques,
  // sinon l'array résolu (indexé par ordre) désalignerait les variables.
  sorted.forEach((p, i) => {
    if (p.position !== i + 1) {
      throw new Error('positions de template invalides (attendu 1..N contigu, sans doublon)');
    }
  });
  return sorted.map((p) => {
    const v = valueOf(p.source, contact);
    const s = v === null || v === undefined || v === '' ? undefined : String(v);
    return s ?? p.fallback ?? '';
  });
}
