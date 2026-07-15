import { waIdOf } from './identity';

export type ParamSource =
  | { type: 'field'; key: string }
  | { type: 'attribute'; key: 'name' | 'phone' | 'bsuid' | 'wa_id' }
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
  bsuid?: string | null;
  profile_name?: string | null;
  fields?: Record<string, unknown>;
}

function isValidSource(s: unknown): s is ParamSource {
  if (typeof s !== 'object' || s === null) return false;
  const src = s as { type?: unknown; key?: unknown; value?: unknown };
  if (src.type === 'literal') return typeof src.value === 'string';
  if (src.type === 'field') return typeof src.key === 'string' && src.key !== '';
  if (src.type === 'attribute') return src.key === 'name' || src.key === 'phone' || src.key === 'bsuid' || src.key === 'wa_id';
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
      // Switch EXHAUSTIF par clé : un ternaire binaire ferait retomber bsuid/wa_id sur le téléphone (bug muet).
      switch (source.key) {
        case 'name':
          return c.profile_name;
        case 'phone':
          return c.phone_e164;
        case 'bsuid':
          return c.bsuid;
        case 'wa_id':
          return waIdOf(c.phone_e164, c.bsuid);
      }
      return undefined;
    case 'field':
      return c.fields?.[source.key];
  }
}

/**
 * Résultat de résolution : les valeurs ordonnées par position (`values`) + les positions dont la valeur est
 * MANQUANTE (`missing`, 1-based). Une variable manquante ne doit JAMAIS partir à Meta en `text:''` (rejet 132012) :
 * le destinataire est sauté en amont (cf. `buildRecipients`, worker). On ne remplit PAS avec l'exemple Meta du
 * template (échantillon de design, ex. « Jean » -> l'envoyer à tout le monde serait faux).
 */
export interface ResolvedParams {
  values: string[];
  missing: number[];
}

/**
 * Nombre de variables d'un corps de template = MAX des positions `{{n}}` (Meta attend des params pour 1..N). Le simple
 * nombre de `{{n}}` distincts sous-compterait un corps non contigu (`{{1}} ... {{3}}` = 3 params attendus, pas 2 ->
 * évite 132000). 0 si aucune variable.
 */
export function countTemplateVariables(body: string): number {
  const positions = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return positions.length > 0 ? Math.max(...positions) : 0;
}

/** Valeur d'une source pour un contact : non-vide -> string, sinon `undefined` (déclenche `missing`). `fallback` = défaut design explicite, compte comme rempli. */
function resolveOne(source: ParamSource, contact: ResolvableContact, fallback?: string): string | undefined {
  const v = valueOf(source, contact);
  const s = v === null || v === undefined || v === '' ? undefined : String(v);
  const withFallback = s ?? (fallback !== undefined && fallback !== '' ? fallback : undefined);
  return withFallback;
}

/**
 * Résout les variables d'un template pour un contact (voie directe : mapping 1..N contigu). Valeur absente ->
 * position marquée `missing` (jamais `''` envoyé). C'est la glue « coller les infos du CRM dans les templates ».
 */
export function resolveTemplateParams(params: TemplateParam[], contact: ResolvableContact): ResolvedParams {
  const sorted = [...params].sort((a, b) => a.position - b.position);
  // Les params WhatsApp sont positionnels : on exige 1..N contigus et uniques,
  // sinon l'array résolu (indexé par ordre) désalignerait les variables.
  sorted.forEach((p, i) => {
    if (p.position !== i + 1) {
      throw new Error('positions de template invalides (attendu 1..N contigu, sans doublon)');
    }
  });
  const values: string[] = [];
  const missing: number[] = [];
  sorted.forEach((p) => {
    const resolved = resolveOne(p.source, contact, p.fallback);
    if (resolved === undefined) missing.push(p.position);
    values.push(resolved ?? '');
  });
  return { values, missing };
}

/**
 * Résout les `count` variables du corps d'un template à partir d'indices SPARSE (variable {{position}} -> champ,
 * posés au design). On part du NOMBRE de variables connu du template live et on remplit CHAQUE position 1..count :
 * indice mappé -> valeur du contact, sinon position marquée `missing`. Renvoie TOUJOURS `count` valeurs (le compte
 * fourni à Meta correspond -> pas de 132000) MAIS toute position `missing` doit faire SAUTER le destinataire en
 * amont (pas d'envoi `text:''` -> pas de 132012). C'est ce qui « colle le prénom » sans re-demander.
 */
export function resolveHintParams(
  hints: Array<{ position: number; source: ParamSource }>,
  count: number,
  contact: ResolvableContact,
): ResolvedParams {
  const byPos = new Map(hints.map((h) => [h.position, h.source]));
  const values: string[] = [];
  const missing: number[] = [];
  for (let pos = 1; pos <= count; pos += 1) {
    const src = byPos.get(pos);
    const resolved = src ? resolveOne(src, contact) : undefined;
    if (resolved === undefined) missing.push(pos);
    values.push(resolved ?? '');
  }
  return { values, missing };
}
