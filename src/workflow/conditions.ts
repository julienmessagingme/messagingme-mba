// Évaluation d'une condition de scénario (node « Si »). Module pur (aucune IO, aucun import qui tire pg) :
// `evaluateConditionGroup(group, ctx)` dit si un groupe de clauses est vrai, `sortieDeCondition(data, ctx)` choisit
// la sortie du bloc (sa première famille vraie, sinon « Sinon »). Les opérateurs texte reproduisent la sémantique
// SQL de `buildContactWhere` (mini-CRM) : voir `matchStringOp` et son test de parité.

import type { ContactFieldOp } from '../crm/contact-store.pg';
import type { AnalyseDeFiche } from '../analysis/fiche';
import { estCleFiltrable, evaluerFiltreFiche, texteDeLaCopie, type OperateurFicheSeul } from '../crm/filtre-fiche';
import { champFiche } from '../crm/champs-fiche';
import { paysDuNumero } from '../crm/phone';

/** 0 = dimanche … 6 = samedi (convention getUTCDay / Intl). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type TimeUnit = 'minutes' | 'hours' | 'days';

/** Ops sur un champ texte : exactement le jeu du mini-CRM (`ContactFieldOp`), pour qu'une clause de champ
 *  texte se comporte comme un filtre mini-CRM. */
export type StringOp = ContactFieldOp; // 'eq' | 'contains' | 'not_contains' | 'empty' | 'not_empty'
export type NumberOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'empty' | 'not_empty';
export type BoolOp = 'is_true' | 'is_false';
export type DateTimeOp = 'before' | 'after' | 'older_than' | 'newer_than' | 'empty' | 'not_empty';
export type LangueOp = 'is' | 'is_not' | 'empty' | 'not_empty';

export type Clause =
  | { kind: 'tag'; op: 'has' | 'not_has'; tag: string }
  | { kind: 'field'; key: string; op: StringOp | NumberOp | BoolOp | OperateurFicheSeul; value?: string; valueType?: 'number' }
  | { kind: 'datetime'; key: string; op: DateTimeOp; value?: string; amount?: number; unit?: TimeUnit }
  | { kind: 'optin'; value: 'opted_in' | 'opted_out' | 'unknown' }
  | { kind: 'weekday'; op: 'is_weekday' | 'is_weekend' | 'is_one_of'; days?: Weekday[] }
  | { kind: 'business_hours'; op: 'within' | 'outside' }
  | { kind: 'time_of_day'; op: 'before' | 'after'; time: string } // 'HH:MM'
  | { kind: 'identity'; op: 'has_phone' | 'has_bsuid' | 'has_email' }
  /**
   * Les champs SYSTÈME (RC5) : ce que la plateforme sait du contact sans qu'il l'ait saisi. Les deux premiers coûtent
   * une lecture, faite seulement si un bloc les teste (`besoinsDesClauses`) ; absents, ils valent VIDE, jamais une
   * valeur inventée. Le pays se déduit du numéro déjà dans le contexte, sans lecture.
   */
  | { kind: 'dernier_message_recu'; op: DateTimeOp; value?: string; amount?: number; unit?: TimeUnit }
  | { kind: 'langue_detectee'; op: LangueOp; value?: string }
  | { kind: 'pays'; op: 'is_one_of'; values: string[] };

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
  /**
   * Le dernier message écrit par le contact, chargé seulement si un bloc s'en sert (`buildCtx`) : une requête
   * de plus que la plupart des scénarios n'ont pas à payer. Absent = le bloc pose une valeur vide, jamais une
   * valeur inventée.
   */
  derniereSaisie?: string | null;
  /**
   * Date (ISO 8601) du dernier message REÇU du contact, tous canaux, réaction exclue : le champ système « dernier
   * message reçu ». Chargée seulement si un bloc la teste, sur le modèle de `derniereSaisie` ; absente = vide.
   */
  dernierMessageRecu?: string | null;
  /**
   * `contacts.langue_detectee` (ISO 639-1, APPRISE par la traduction, migration 0137) : le champ système « langue
   * détectée ». Chargée seulement si un bloc la teste ; absente ou jamais apprise = vide, jamais « français ».
   */
  langueDetectee?: string | null;
  /**
   * La dernière analyse de la fiche (colonnes `analyse_*`, migration 0196), `null` si elle n'a jamais été analysée.
   * 🔴 Un membre SÉPARÉ de `fields`, jamais fusionné dedans : la fonction JS d'un scénario reçoit `fields`, et
   * l'analyse ne doit pas y entrer (amendement 7 de la spec). Requis : un câblage qui l'oublierait ne compile pas,
   * au lieu de rendre toute condition d'analyse fausse sans le dire.
   */
  analyse: AnalyseDeFiche | null;
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

/**
 * Coerce des `data` de node opaques (issues du graphe JSON, potentiellement malformées) en `ConditionGroup`
 * sûr : `match` par défaut 'all', `clauses` -> [] si absent/non-array. Les clauses individuelles restent
 * opaques : `evaluateClause` est défensif (kind inconnu -> false, throw isolé -> false).
 */
export function coerceConditionGroup(data: unknown): ConditionGroup {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return {
    match: d.match === 'any' ? 'any' : 'all',
    clauses: Array.isArray(d.clauses) ? (d.clauses as Clause[]) : [],
  };
}

// --- Les familles d'un bloc Condition (RC5) ---

/** Nombre maximal de familles d'un bloc. ⚠️ Miroir : `web/lib/condition-familles.ts`, parité tenue par un test. */
export const MAX_FAMILLES_CONDITION = 10;
/** La sortie « Sinon » : aucune famille n'est vraie. Le code d'avant les familles, inchangé. */
export const SORTIE_SINON = 'false';
/** Le code (et la poignée) de la famille d'un bloc d'avant les familles : sa sortie « Si réunie », inchangée. */
export const CODE_PREMIERE_FAMILLE = 'true';
/** Un code de famille : court, sans « : » (il entre dans une poignée), jamais celui de « Sinon ». */
const CODE_FAMILLE_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Une famille : un nom (affiché sur sa sortie), son propre groupe de clauses en ET ou en OU, un code STABLE. */
export interface FamilleDeCondition { code: string; nom: string; groupe: ConditionGroup }

/**
 * Les familles d'un bloc Condition, dans l'ordre où elles se testent, lues défensivement (`data` est opaque :
 * `parseGraph` ne le regarde pas).
 *
 * 🔴 COMPATIBILITÉ SANS MIGRATION : un bloc SANS `familles` (tous ceux d'avant RC5) se lit comme UNE famille de code
 * `true`, portant son `match` / `clauses` d'origine. Sa sortie reste donc `true`, « Sinon » reste `false`, et ni le
 * graphe publié ni ses arêtes ne bougent d'un octet. Dès que `familles` est un tableau, il fait foi, même vide.
 *
 * Bornée ICI et pas à la publication, comme les destinataires d'un mail (`MAX_DESTINATAIRES_EMAIL`) : au-delà de
 * dix, le surplus est ignoré ; un code invalide ou déjà vu dans le bloc écarte sa famille. L'écran ne produit ni
 * l'un ni l'autre ; c'est la ceinture d'un graphe posé par l'API.
 */
export function famillesDeCondition(data: unknown): FamilleDeCondition[] {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  if (!Array.isArray(d.familles)) return [{ code: CODE_PREMIERE_FAMILLE, nom: '', groupe: coerceConditionGroup(d) }];
  const vus = new Set<string>();
  const out: FamilleDeCondition[] = [];
  for (const brut of d.familles) {
    if (out.length === MAX_FAMILLES_CONDITION) break;
    const f = brut && typeof brut === 'object' && !Array.isArray(brut) ? (brut as Record<string, unknown>) : {};
    const code = typeof f.code === 'string' ? f.code.trim() : '';
    if (!CODE_FAMILLE_RE.test(code) || code === SORTIE_SINON || vus.has(code)) continue;
    vus.add(code);
    out.push({ code, nom: typeof f.nom === 'string' ? f.nom.trim() : '', groupe: coerceConditionGroup(f.groupe) });
  }
  return out;
}

/** La poignée (le `sourceHandle` des arêtes) d'une famille : `true` pour la première d'origine, `famille:<code>` sinon. */
export function poigneeDeFamille(code: string): string {
  return code === CODE_PREMIERE_FAMILLE ? CODE_PREMIERE_FAMILLE : `famille:${code}`;
}

/**
 * TOUTES les sorties d'un bloc Condition, dans l'ordre : une par famille, puis « Sinon ». Le seul endroit qui les
 * nomme : chaque lecteur du graphe (le moteur, l'analyse de fenêtre, l'éligibilité de campagne, et leurs miroirs
 * console) l'appelle au lieu d'écrire `true` / `false`. Un lecteur qui l'oublierait ne verrait pas une famille neuve,
 * sans aucune erreur. Un bloc d'avant les familles rend `['true', 'false']`, exactement ce qui était écrit en dur.
 */
export function sortiesDeCondition(node: { data: Record<string, unknown> }): string[] {
  return [...famillesDeCondition(node.data).map((f) => poigneeDeFamille(f.code)), SORTIE_SINON];
}

/** La sortie que prend le contact : la PREMIÈRE famille vraie, de haut en bas ; aucune vraie, « Sinon ». */
export function sortieDeCondition(data: unknown, ctx: EvalContext): string {
  for (const f of famillesDeCondition(data)) {
    if (evaluateConditionGroup(f.groupe, ctx)) return poigneeDeFamille(f.code);
  }
  return SORTIE_SINON;
}

/** Toutes les clauses d'un bloc Condition, familles confondues : de quoi savoir ce que son contexte doit charger. */
export function clausesDuBloc(data: unknown): Clause[] {
  return famillesDeCondition(data).flatMap((f) => f.groupe.clauses);
}

/**
 * Ce que le contexte d'un contact doit charger EN PLUS de la fiche, chacun au prix d'une requête. Un scénario ou une
 * automation ne le paie que si l'un de ses blocs (ou sa condition) le demande.
 */
export interface BesoinsContexte {
  derniereSaisie: boolean;
  dernierMessageRecu: boolean;
  langueDetectee: boolean;
}

/** Les champs système que ces clauses lisent. Lecture défensive : une clause est du JSON libre, `null` compris. */
export function besoinsDesClauses(clauses: readonly unknown[]): Pick<BesoinsContexte, 'dernierMessageRecu' | 'langueDetectee'> {
  const kinds = new Set(clauses.map((c) => (c && typeof c === 'object' ? (c as { kind?: unknown }).kind : undefined)));
  return { dernierMessageRecu: kinds.has('dernier_message_recu'), langueDetectee: kinds.has('langue_detectee') };
}

function evaluateClause(c: Clause, ctx: EvalContext): boolean {
  switch (c.kind) {
    case 'tag': {
      const has = ctx.tags.includes(c.tag);
      return c.op === 'has' ? has : !has;
    }
    case 'field': {
      // Un champ de la dernière analyse : la sémantique des filtres de la liste des contacts, lue sur la copie,
      // jamais sur un champ perso homonyme. Un opérateur que le champ ne connaît pas rend `false`.
      if (estCleFiltrable(c.key)) return evaluerFiltreFiche(c.key, c.op, c.value ?? '', ctx.analyse, ctx.now);
      const v = attributeOrField(ctx, c.key);
      if (c.op === 'is_true' || c.op === 'is_false') return matchBoolOp(v, c.op);
      // `eq`/`empty`/`not_empty` sont partagés texte/nombre : comparaison numérique seulement si le champ est typé
      // nombre (`valueType`) ou si l'op n'a de sens que numériquement. Sinon `eq` reste une égalité de chaîne, sans
      // quoi `Number('Paris')` = NaN rendrait fausse toute égalité de texte.
      if (isNumberOp(c.op) && (c.valueType === 'number' || isNumberOnlyOp(c.op))) {
        return matchNumberOp(v, c.op, c.value ?? '');
      }
      if (isStringOp(c.op)) return matchStringOp(v, c.op, c.value ?? '');
      return false; // op non reconnu pour un champ -> clause non satisfaite (défensif)
    }
    case 'datetime':
      return comparerInstant(attributeOrField(ctx, c.key), c, ctx);
    // Les opérateurs d'un champ date, sur la date du dernier message reçu. Jamais chargée = vide.
    case 'dernier_message_recu':
      return comparerInstant(strOrNull(ctx.dernierMessageRecu), c, ctx);
    case 'langue_detectee': {
      // Comparée sur la langue PRINCIPALE, sans casse : le modèle qui l'apprend peut écrire `EN` ou `en-US`.
      // Une langue jamais apprise vaut vide : « n'est pas l'anglais » est alors vrai, « est l'anglais » faux.
      const langue = langueDe(ctx.langueDetectee);
      if (c.op === 'empty') return langue === '';
      if (c.op === 'not_empty') return langue !== '';
      // Une cible vide ne contraint rien (doctrine de `matchStringOp`) : sinon « est » vide retiendrait tous les contacts
      // dont la langue n'a jamais été apprise, c'est-à-dire presque tous (relecture de RC5).
      const cible = langueDe(c.value);
      if (cible === '') return true;
      return c.op === 'is_not' ? langue !== cible : langue === cible;
    }
    case 'pays': {
      // Déduit du numéro de la fiche (`paysDuNumero`) ; sans numéro, ou d'une plage inconnue, aucun pays. Une liste
      // vide ne retient personne, comme « est un de ces jours » sans jour coché.
      const pays = paysDuNumero(ctx.phone);
      const liste = Array.isArray(c.values) ? c.values.map((v) => String(v ?? '').trim().toUpperCase()) : [];
      return pays !== null && liste.includes(pays);
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

/**
 * Les opérateurs d'une date : vide / renseignée, plus vieille ou plus récente qu'une durée, avant ou après une base
 * (`now` ou une date fixe). Partagé par un champ date de la fiche et par la date du dernier message reçu, pour qu'un
 * « remonte à plus de 7 jours » veuille dire la même chose sur les deux.
 */
function comparerInstant(raw: string | null, c: { op: DateTimeOp; value?: string; amount?: number; unit?: TimeUnit }, ctx: EvalContext): boolean {
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

/** La langue principale d'un code (`en-US` -> `en`), en minuscules ; vide si absente. */
function langueDe(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

// --- Accès aux valeurs ---

/** name/phone/bsuid = attributs (hors `contacts.fields`) ; un champ filtrable de la dernière analyse = la copie de la
 *  fiche, avant le jsonb (dates en ISO), et le sujet rien ; tout le reste (prenom/email/champs perso) = fields. */
function attributeOrField(ctx: EvalContext, key: string): string | null {
  if (key === 'name') return strOrNull(ctx.name);
  if (key === 'phone') return strOrNull(ctx.phone);
  if (key === 'bsuid') return strOrNull(ctx.bsuid);
  // Le sujet (texte libre) n'est lisible nulle part comme critère (décision 12) : jamais une valeur, ici non plus.
  if (champFiche(key)?.provenance === 'analyse') return estCleFiltrable(key) ? texteDeLaCopie(key, ctx.analyse ?? null) : null;
  return strOrNull(ctx.fields[key]);
}
function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
}

// --- Opérateurs (matchStringOp = miroir de buildContactWhere) ---

// `NUMBER_OPS` inclut eq/empty/not_empty, partagés avec le texte ; `NUMBER_ONLY_OPS` force la comparaison
// numérique même sans `valueType` ; `STRING_OPS` = `ContactFieldOp` du mini-CRM, pour router sans cast.
const NUMBER_OPS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'empty', 'not_empty']);
const NUMBER_ONLY_OPS = new Set(['neq', 'lt', 'lte', 'gt', 'gte']);
const STRING_OPS = new Set(['eq', 'contains', 'not_contains', 'empty', 'not_empty']);
function isNumberOp(op: string): op is NumberOp { return NUMBER_OPS.has(op); }
function isNumberOnlyOp(op: string): boolean { return NUMBER_ONLY_OPS.has(op); }
function isStringOp(op: string): op is StringOp { return STRING_OPS.has(op); }

/** Miroir exact de la sémantique SQL de `buildContactWhere` (mini-CRM). `coalesce(value,'')` pour contains ;
 *  `ilike` = insensible à la casse ; eq = égalité stricte, faux si valeur absente. */
export function matchStringOp(value: string | null, op: StringOp, target: string): boolean {
  // Pas de trim, comme le SQL `fields ->> key is null or = ''` (`strOrNull` a déjà réduit '' à null) : une
  // valeur d'espaces seuls reste non vide, sinon le node condition et le ciblage mini-CRM classeraient le même
  // contact différemment.
  const empty = value === null || value === '';
  if (op === 'empty') return empty;
  if (op === 'not_empty') return !empty;
  // Cible vide sur eq/contains/not_contains : buildContactWhere ne pose pas le filtre, donc true ici aussi
  // (jamais une contrainte silencieuse qui exclurait tout le monde).
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
  // Seuil vide = pas de contrainte, comme matchStringOp. Sinon `Number('') === 0` ferait matcher `x >= 0` pour
  // presque tout contact renseigné (seuil oublié dans l'UI).
  if (target.trim() === '') return true;
  // Valeur absente -> aucune comparaison ne matche : `Number(null) === 0` ferait matcher `age < 18` pour tout
  // contact sans `age`. Cohérent avec matchStringOp (eq faux si absent).
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
  // Coercer avant de valider : `amount` vient de node.data opaque et peut être une chaîne ('24'), que
  // `Number.isFinite` refuse sans coercer (-> 0 -> older_than vrai pour toute date passée).
  const num = Number(amount);
  const n = Number.isFinite(num) ? num : 0;
  const per = unit === 'days' ? 86400000 : unit === 'hours' ? 3600000 : 60000; // défaut minutes
  return n * per;
}

// --- Fuseau horaire (IANA), 100% pur via Intl ---

/** Parts date/heure d'un instant dans un fuseau IANA. */
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
 * Interprète une chaîne date/heure en instant. Avec `Z`/offset -> absolu. Sinon (heure murale
 * `YYYY-MM-DDTHH:MM`, ou date nue = minuit) -> dans le fuseau du tenant. Offset calculé en deux passes, exact
 * jusqu'au bord d'une bascule DST ; seule l'heure inexistante ou ambiguë du changement d'heure reste un cas limite.
 */
export function parseInstant(value: string, timeZone: string): Date {
  const v = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) return new Date(v); // absolu
  const wall = /T\d{2}:\d{2}/.test(v) ? v : `${v}T00:00`;
  const guess = new Date(`${wall}Z`); // d'abord comme si UTC
  if (Number.isNaN(guess.getTime())) return guess;
  // Deux passes : l'offset lu depuis le `guess` naïf peut être celui du mauvais côté d'une bascule DST (erreur
  // d'une heure) ; on le recalcule depuis l'instant corrigé.
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
