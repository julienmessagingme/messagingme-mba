import { waIdOf } from './identity';

export type ParamSource =
  | { type: 'field'; key: string }
  | { type: 'attribute'; key: 'name' | 'phone' | 'bsuid' | 'wa_id' }
  | { type: 'now' }
  | { type: 'literal'; value: string }
  /**
   * Une variable du destinataire, passée par l'API publique dans `recipients[].variables` : elle ne vit que le
   * temps d'un envoi et n'est jamais écrite sur la fiche. Acceptée seulement par `/v1/sends`
   * (`accepterVariables: true`) : dans un mapping de la console, elle écarterait tous les destinataires en
   * `missing_variable`.
   */
  | { type: 'variable'; key: string };

/**
 * Le nom d'une variable de destinataire : la même classe de caractères que les `{{nom}}` d'un message RCS
 * (`MOTIF`, `src/rcs/variables.ts`), pour qu'une variable nommée ici puisse y être appelée.
 */
export const CLE_VARIABLE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Fuseau par défaut de la source NOW. Aucun chemin d'envoi ne fournit `tz` aujourd'hui : NOW s'affiche donc
 *  toujours dans ce fuseau, même si le tenant en a configuré un autre (respecté, lui, par les conditions). */
const DEFAULT_NOW_TZ = 'Europe/Paris';

/** Contexte de résolution non lié au contact : `now` (source NOW) et fuseau d'affichage. Optionnel pour un
 *  template qui n'utilise pas la source NOW. */
export interface ResolveOpts {
  now?: Date;
  tz?: string;
  /** Les variables du destinataire (source `variable`). Absentes = aucune, donc toute source `variable` manque. */
  variables?: Readonly<Record<string, string>>;
}

/** Formate la source NOW en date du jour (JJ/MM/AAAA) dans le fuseau du tenant. */
export function formatNow(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz }).format(now);
}

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

function isValidSource(s: unknown, accepterVariables = false): s is ParamSource {
  if (typeof s !== 'object' || s === null) return false;
  const src = s as { type?: unknown; key?: unknown; value?: unknown };
  if (src.type === 'variable') return accepterVariables && typeof src.key === 'string' && CLE_VARIABLE.test(src.key);
  if (src.type === 'literal') return typeof src.value === 'string';
  if (src.type === 'field') return typeof src.key === 'string' && src.key !== '';
  if (src.type === 'attribute') return src.key === 'name' || src.key === 'phone' || src.key === 'bsuid' || src.key === 'wa_id';
  if (src.type === 'now') return true;
  return false;
}

/**
 * Valide un paramMapping non fiable (corps HTTP) : positions entières, sources bien formées, et positions 1..N
 * contiguës et uniques (l'invariant de resolveTemplateParams, sans throw). Rend le tableau typé, ou null pour
 * que la route réponde 400 plutôt qu'un 500.
 */
export function validateParamMapping(raw: unknown, options: { accepterVariables?: boolean } = {}): TemplateParam[] | null {
  if (!Array.isArray(raw)) return null;
  const params: TemplateParam[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const p = item as { position?: unknown; source?: unknown; fallback?: unknown };
    if (typeof p.position !== 'number' || !Number.isInteger(p.position)) return null;
    if (!isValidSource(p.source, options.accepterVariables === true)) return null;
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
 * Valide des indices variable -> champ posés au design. Contrairement au paramMapping, ils sont épars (un
 * `{{n}}` tapé à la main n'en a pas) : pas de suite 1..N exigée, seulement des positions entières >= 1 uniques
 * et des sources bien formées. Rend les indices typés, ou null si malformé.
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

function valueOf(source: ParamSource, c: ResolvableContact, opts?: ResolveOpts): unknown {
  switch (source.type) {
    case 'literal':
      return source.value;
    case 'now':
      // NOW ne dépend pas du contact. Sans `now` fourni par l'appelant, la valeur est absente -> position
      // `missing`, jamais un envoi faux.
      return opts?.now ? formatNow(opts.now, opts.tz ?? DEFAULT_NOW_TZ) : undefined;
    case 'attribute':
      // Switch exhaustif par clé : un ternaire binaire ferait retomber bsuid et wa_id sur le téléphone.
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
    case 'variable':
      // `Object.hasOwn` et pas une lecture directe : `constructor` est un nom de variable valide, et
      // `{}['constructor']` rendrait la fonction du prototype, envoyée ensuite en texte à Meta.
      return opts?.variables && Object.hasOwn(opts.variables, source.key) ? opts.variables[source.key] : undefined;
  }
}

/**
 * Résultat de résolution : les valeurs ordonnées par position (`values`) et les positions manquantes
 * (`missing`, 1-based). Une variable manquante ne part jamais à Meta en `text:''` (rejet 132012) : le
 * destinataire est sauté en amont. On ne remplit pas avec l'exemple de design du template.
 */
export interface ResolvedParams {
  values: string[];
  missing: number[];
}

/**
 * Nombre de variables d'un corps de template = le maximum des positions `{{n}}` (Meta attend des params pour
 * 1..N) : compter les `{{n}}` distincts sous-compterait un corps non contigu (132000). 0 si aucune.
 */
export function countTemplateVariables(body: string): number {
  const positions = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return positions.length > 0 ? Math.max(...positions) : 0;
}

/** Valeur d'une source pour un contact : non vide -> string, sinon `undefined` (donc `missing`). `fallback`,
 *  défaut explicite du design, compte comme rempli. */
function resolveOne(source: ParamSource, contact: ResolvableContact, fallback?: string, opts?: ResolveOpts): string | undefined {
  const v = valueOf(source, contact, opts);
  const s = v === null || v === undefined || v === '' ? undefined : String(v);
  const withFallback = s ?? (fallback !== undefined && fallback !== '' ? fallback : undefined);
  return withFallback;
}

/**
 * Résout les variables d'un template pour un contact (mapping 1..N contigu). Valeur absente -> position
 * marquée `missing`, jamais `''` envoyé.
 */
export function resolveTemplateParams(params: TemplateParam[], contact: ResolvableContact, opts?: ResolveOpts): ResolvedParams {
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
    const resolved = resolveOne(p.source, contact, p.fallback, opts);
    if (resolved === undefined) missing.push(p.position);
    values.push(resolved ?? '');
  });
  return { values, missing };
}

/**
 * Résout les `count` variables du corps d'un template à partir d'indices épars posés au design : chaque
 * position 1..count prend la valeur du contact si elle est mappée, sinon elle est `missing`. Rend toujours
 * `count` valeurs (pas de 132000), mais toute position `missing` doit faire sauter le destinataire (pas de 132012).
 */
export function resolveHintParams(
  hints: Array<{ position: number; source: ParamSource }>,
  count: number,
  contact: ResolvableContact,
  opts?: ResolveOpts,
): ResolvedParams {
  const byPos = new Map(hints.map((h) => [h.position, h.source]));
  const values: string[] = [];
  const missing: number[] = [];
  for (let pos = 1; pos <= count; pos += 1) {
    const src = byPos.get(pos);
    const resolved = src ? resolveOne(src, contact, undefined, opts) : undefined;
    if (resolved === undefined) missing.push(pos);
    values.push(resolved ?? '');
  }
  return { values, missing };
}

/**
 * Rafraîchit les positions NOW de params déjà résolus, à l'instant de l'envoi : une campagne résout le reste à
 * la création, mais NOW doit refléter le jour de l'envoi. Les autres positions restent inchangées. À appeler au
 * plus près de l'envoi.
 */
export function refreshNowParams(resolvedParams: string[], paramMapping: TemplateParam[], opts: ResolveOpts): string[] {
  if (!opts.now || !paramMapping.some((p) => p.source.type === 'now')) return resolvedParams;
  const out = [...resolvedParams];
  const nowStr = formatNow(opts.now, opts.tz ?? DEFAULT_NOW_TZ);
  for (const p of paramMapping) {
    if (p.source.type === 'now' && p.position >= 1 && p.position <= out.length) out[p.position - 1] = nowStr;
  }
  return out;
}
