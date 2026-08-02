// Évaluation d'une CONDITION de scénario (node « Si »). Module PUR (aucune IO, aucun accès DB, aucun import qui
// tire pg) -> testable en unitaire sans base. C'est le cœur du node condition : `evaluateConditionGroup(group, ctx)`
// renvoie un booléen (sortie « Si réunie » vs « Sinon »). Les opérateurs texte (eq/contains/not_contains/empty/
// not_empty) MIROITENT la sémantique SQL de `buildContactWhere` (mini-CRM) : voir `matchStringOp` + test de parité.

import type { ContactFieldOp } from '../crm/contact-store.pg';

/** 0 = dimanche … 6 = samedi (convention getUTCDay / Intl). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type TimeUnit = 'minutes' | 'hours' | 'days';

/** Ops sur un champ texte : STRICTEMENT le jeu du mini-CRM (`ContactFieldOp`) -> une clause de champ texte se
 *  comporte comme un filtre mini-CRM (anti-slop). */
export type StringOp = ContactFieldOp; // 'eq' | 'contains' | 'not_contains' | 'empty' | 'not_empty'
export type NumberOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'empty' | 'not_empty';
export type BoolOp = 'is_true' | 'is_false';
export type DateTimeOp = 'before' | 'after' | 'older_than' | 'newer_than' | 'empty' | 'not_empty';

export type Clause =
  | { kind: 'tag'; op: 'has' | 'not_has'; tag: string }
  | { kind: 'field'; key: string; op: StringOp | NumberOp | BoolOp; value?: string; valueType?: 'number' }
  | { kind: 'datetime'; key: string; op: DateTimeOp; value?: string; amount?: number; unit?: TimeUnit }
  | { kind: 'optin'; value: 'opted_in' | 'opted_out' | 'unknown' }
  | { kind: 'weekday'; op: 'is_weekday' | 'is_weekend' | 'is_one_of'; days?: Weekday[] }
  | { kind: 'business_hours'; op: 'within' | 'outside' }
  | { kind: 'time_of_day'; op: 'before' | 'after'; time: string } // 'HH:MM'
  | { kind: 'identity'; op: 'has_phone' | 'has_bsuid' | 'has_email' };

export interface ConditionGroup { match: 'all' | 'any'; clauses: Clause[] }

/** Horaires d'un jour. `closed` = fermé (aucune plage). `open`/`close` = 'HH:MM' (heure murale locale du tenant). */
export interface DayHours { closed: boolean; open: string; close: string }
/** Semaine d'ouverture, indexée par jour '0'..'6' (0 = dimanche). */
export type BusinessHours = Record<string, DayHours>;

export interface EvalContext {
  fields: Record<string, unknown>;
  tags: string[];
  optIn: string;
  name: string | null;
  phone: string | null;
  bsuid: string | null;
  now: Date;
  timeZone: string; // IANA, ex. 'Europe/Paris'
  businessHours: BusinessHours;
}

/**
 * Évalue un groupe de clauses combinées en ET (`all`) ou OU (`any`). Groupe vide -> `all` vrai (aucune contrainte),
 * `any` faux (`every`/`some` sur []). Chaque clause est isolée (une clause qui ne peut pas s'évaluer -> false).
 */
export function evaluateConditionGroup(group: ConditionGroup, ctx: EvalContext): boolean {
  const results = (group.clauses ?? []).map((c) => {
    try { return evaluateClause(c, ctx); } catch { return false; }
  });
  return group.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

function evaluateClause(c: Clause, ctx: EvalContext): boolean {
  switch (c.kind) {
    case 'tag': {
      const has = ctx.tags.includes(c.tag);
      return c.op === 'has' ? has : !has;
    }
    case 'field': {
      const v = attributeOrField(ctx, c.key);
      if (c.op === 'is_true' || c.op === 'is_false') return matchBoolOp(v, c.op);
      // `eq`/`empty`/`not_empty` sont PARTAGÉS texte/nombre : on ne compare en NUMÉRIQUE que si le champ est
      // typé nombre (`valueType`) OU si l'op n'a de sens QUE numériquement (lt/lte/gt/gte/neq). Sinon sémantique
      // texte (miroir buildContactWhere). Un champ texte gardé `eq` reste une égalité de CHAÎNE — crucial, sinon
      // `Number('Paris')=NaN` renverrait toujours false pour toute égalité de texte.
      if (isNumberOp(c.op) && (c.valueType === 'number' || isNumberOnlyOp(c.op))) {
        return matchNumberOp(v, c.op, c.value ?? '');
      }
      if (isStringOp(c.op)) return matchStringOp(v, c.op, c.value ?? '');
      return false; // op non reconnu pour un champ -> clause non satisfaite (défensif)
    }
    case 'datetime': {
      const raw = attributeOrField(ctx, c.key);
      if (c.op === 'empty') return raw === null || raw.trim() === '';
      if (c.op === 'not_empty') return raw !== null && raw.trim() !== '';
      const inst = raw === null ? null : parseInstant(raw, ctx.timeZone);
      if (inst === null || Number.isNaN(inst.getTime())) return false;
      const nowMs = ctx.now.getTime();
      if (c.op === 'older_than') return inst.getTime() < nowMs - relMs(c.amount, c.unit);
      if (c.op === 'newer_than') return inst.getTime() > nowMs - relMs(c.amount, c.unit);
      // before / after vs une base : 'now' (dynamique) ou une date/heure fixe.
      const base = c.value === 'now' || !c.value ? ctx.now : parseInstant(c.value, ctx.timeZone);
      if (Number.isNaN(base.getTime())) return false;
      return c.op === 'before' ? inst.getTime() < base.getTime() : inst.getTime() > base.getTime();
    }
    case 'optin':
      return ctx.optIn === c.value;
    case 'weekday': {
      const wd = weekdayInZone(ctx.now, ctx.timeZone);
      if (c.op === 'is_weekday') return wd >= 1 && wd <= 5;
      if (c.op === 'is_weekend') return wd === 0 || wd === 6;
      return (c.days ?? []).includes(wd);
    }
    case 'business_hours': {
      const within = withinBusinessHours(ctx.now, ctx.timeZone, ctx.businessHours);
      return c.op === 'within' ? within : !within;
    }
    case 'time_of_day': {
      const cur = minutesInZone(ctx.now, ctx.timeZone);
      const target = hhmmToMinutes(c.time);
      if (target === null) return false;
      return c.op === 'before' ? cur < target : cur > target;
    }
    case 'identity':
      if (c.op === 'has_phone') return !!(ctx.phone && ctx.phone.trim() !== '');
      if (c.op === 'has_bsuid') return !!(ctx.bsuid && ctx.bsuid.trim() !== '');
      return !!strOrNull(ctx.fields.email);
  }
}

// --- Accès aux valeurs ---

/** name/phone/bsuid = attributs (hors `contacts.fields`) ; tout le reste (prenom/email/champs perso) = fields. */
function attributeOrField(ctx: EvalContext, key: string): string | null {
  if (key === 'name') return strOrNull(ctx.name);
  if (key === 'phone') return strOrNull(ctx.phone);
  if (key === 'bsuid') return strOrNull(ctx.bsuid);
  return strOrNull(ctx.fields[key]);
}
function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
}

// --- Opérateurs (matchStringOp = miroir de buildContactWhere) ---

// Ops numériques COMPLET (inclut eq/empty/not_empty, partagés avec le texte). `NUMBER_ONLY_OPS` = le sous-ensemble
// qui n'a de sens QUE numériquement -> force la comparaison numérique même sans `valueType`. `STRING_OPS` = le jeu
// texte (= `ContactFieldOp` du mini-CRM), pour router sans cast.
const NUMBER_OPS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'empty', 'not_empty']);
const NUMBER_ONLY_OPS = new Set(['neq', 'lt', 'lte', 'gt', 'gte']);
const STRING_OPS = new Set(['eq', 'contains', 'not_contains', 'empty', 'not_empty']);
function isNumberOp(op: string): op is NumberOp { return NUMBER_OPS.has(op); }
function isNumberOnlyOp(op: string): boolean { return NUMBER_ONLY_OPS.has(op); }
function isStringOp(op: string): op is StringOp { return STRING_OPS.has(op); }

/** Miroir EXACT de la sémantique SQL de `buildContactWhere` (mini-CRM). `coalesce(value,'')` pour contains ;
 *  `ilike` = insensible à la casse ; eq = égalité stricte, faux si valeur absente. */
export function matchStringOp(value: string | null, op: StringOp, target: string): boolean {
  // PAS de trim : miroir EXACT du SQL `fields ->> key is null or = ''` (buildContactWhere). `strOrNull` a déjà
  // réduit '' à null en amont ; une valeur d'espaces seuls ('  ') reste NON vide, comme en SQL — sinon le node
  // condition et le ciblage mini-CRM classeraient le même contact différemment (rupture de parité anti-slop).
  const empty = value === null || value === '';
  if (op === 'empty') return empty;
  if (op === 'not_empty') return !empty;
  // Cible vide sur eq/contains/not_contains : buildContactWhere NE POSE PAS le filtre (aucune contrainte -> le
  // contact passe). On mirroir : cible vide -> true, jamais une contrainte silencieuse qui exclurait tout le monde.
  if (target === '') return true;
  const hay = (value ?? '').toLowerCase();
  const needle = target.toLowerCase();
  if (op === 'contains') return hay.includes(needle);
  if (op === 'not_contains') return !hay.includes(needle);
  // eq : égalité stricte (sensible à la casse), faux si valeur absente.
  return value !== null && value === target;
}

function matchNumberOp(value: string | null, op: NumberOp, target: string): boolean {
  const empty = value === null || value.trim() === '';
  if (op === 'empty') return empty;
  if (op === 'not_empty') return !empty;
  // Valeur absente/vide -> ne matche AUCUNE comparaison (eq/neq/lt/lte/gt/gte). Sans ce garde, `Number(null)===0`
  // (piège JS, ≠ `Number(undefined)=NaN`) ferait matcher `age < 18` pour TOUT contact sans `age` renseigné.
  // Cohérent avec matchStringOp (eq faux si absent).
  if (empty) return false;
  const a = Number(value);
  const b = Number(target);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  switch (op) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
  }
}

const TRUE_TOKENS = new Set(['true', 'oui', '1']);
const FALSE_TOKENS = new Set(['false', 'non', '0']);
function matchBoolOp(value: string | null, op: BoolOp): boolean {
  const low = (value ?? '').trim().toLowerCase();
  return op === 'is_true' ? TRUE_TOKENS.has(low) : FALSE_TOKENS.has(low);
}

function relMs(amount: number | undefined, unit: TimeUnit | undefined): number {
  const n = Number.isFinite(amount) ? Number(amount) : 0;
  const per = unit === 'days' ? 86400000 : unit === 'hours' ? 3600000 : 60000; // défaut minutes
  return n * per;
}

// --- Fuseau horaire (IANA), 100% pur via Intl ---

/** Parts date/heure d'un instant DANS un fuseau IANA. */
function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
  // Intl peut rendre '24' à minuit selon l'environnement ; on normalise en 0.
  const hour = m.hour === '24' ? 0 : Number(m.hour);
  return { year: Number(m.year), month: Number(m.month), day: Number(m.day), hour, minute: Number(m.minute), second: Number(m.second) };
}

/** Offset (minutes) du fuseau `tz` à l'instant `date`. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

/**
 * Interprète une chaîne date/heure en INSTANT. Avec `Z`/offset -> absolu direct. Sinon (heure MURALE
 * `YYYY-MM-DDTHH:MM`) -> interprétée dans le fuseau tenant. Une date nue `YYYY-MM-DD` est traitée comme minuit
 * local. L'offset est calculé en DEUX passes (voir corps) -> exact jusqu'au bord d'une bascule DST ; seule
 * l'heure inexistante (saut de printemps) ou ambiguë (retour d'automne) du changement d'heure reste un cas limite.
 */
export function parseInstant(value: string, timeZone: string): Date {
  const v = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) return new Date(v); // absolu
  const wall = /T\d{2}:\d{2}/.test(v) ? v : `${v}T00:00`;
  const guess = new Date(`${wall}Z`); // d'abord comme si UTC
  if (Number.isNaN(guess.getTime())) return guess;
  // Deux passes d'offset : l'offset lu depuis le `guess` naïf peut être celui du MAUVAIS côté d'une bascule DST
  // (l'instant corrigé retombe dans l'autre offset -> erreur d'1 h dans la fenêtre de transition). On recalcule
  // l'offset depuis l'instant corrigé, qui est du bon côté hors du saut lui-même.
  const off1 = tzOffsetMinutes(guess, timeZone);
  const corrected = new Date(guess.getTime() - off1 * 60000);
  const off2 = tzOffsetMinutes(corrected, timeZone);
  return new Date(guess.getTime() - off2 * 60000);
}

/** Jour de la semaine (0 dimanche … 6 samedi) dans le fuseau. */
export function weekdayInZone(date: Date, timeZone: string): Weekday {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return (idx < 0 ? 0 : idx) as Weekday;
}

/** Minutes écoulées depuis minuit dans le fuseau. */
export function minutesInZone(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** L'instant `date` tombe-t-il dans les horaires d'ouverture du tenant (fuseau + jour) ? Jour fermé -> false.
 *  Plage `[open, close)`. Une plage `close <= open` (mal saisie) -> jamais ouvert. */
export function withinBusinessHours(date: Date, timeZone: string, hours: BusinessHours): boolean {
  const wd = weekdayInZone(date, timeZone);
  const day = hours?.[String(wd)];
  if (!day || day.closed) return false;
  const open = hhmmToMinutes(day.open);
  const close = hhmmToMinutes(day.close);
  if (open === null || close === null || close <= open) return false;
  const cur = minutesInZone(date, timeZone);
  return cur >= open && cur < close;
}
