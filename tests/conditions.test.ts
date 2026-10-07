import { describe, it, expect } from 'vitest';
import {
  evaluateConditionGroup, matchStringOp, parseInstant, weekdayInZone, minutesInZone, withinBusinessHours,
  type EvalContext, type Clause, type BusinessHours,
} from '../src/workflow/conditions';

const PARIS = 'Europe/Paris';
// Semaine type : Lun-Ven 09:00-18:00, week-end fermé.
const BH: BusinessHours = {
  '0': { closed: true, open: '', close: '' },   // dimanche
  '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' },
  '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' },
  '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },   // samedi
};

function ctx(over: Partial<EvalContext> = {}): EvalContext {
  return {
    fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null, analyse: null,
    now: new Date('2026-08-03T12:00:00Z'), // lundi 14:00 à Paris (été = UTC+2)
    timeZone: PARIS, businessHours: BH, ...over,
  };
}
const grp = (clauses: Clause[], match: 'all' | 'any' = 'all') => ({ match, clauses });

describe('matchStringOp — parité sémantique avec buildContactWhere (mini-CRM)', () => {
  it('eq strict, faux si absent', () => {
    expect(matchStringOp('vip', 'eq', 'vip')).toBe(true);
    expect(matchStringOp('VIP', 'eq', 'vip')).toBe(false); // sensible à la casse (comme le SQL `=`)
    expect(matchStringOp(null, 'eq', 'vip')).toBe(false);
  });
  it('contains / not_contains = ilike insensible à la casse sur coalesce', () => {
    expect(matchStringOp('Grand Paris', 'contains', 'paris')).toBe(true);
    expect(matchStringOp('Lyon', 'contains', 'paris')).toBe(false);
    expect(matchStringOp(null, 'contains', 'paris')).toBe(false);
    expect(matchStringOp('Lyon', 'not_contains', 'paris')).toBe(true);
    expect(matchStringOp(null, 'not_contains', 'paris')).toBe(true);
  });
  it('empty / not_empty (pas de trim : miroir SQL `is null or = ""`)', () => {
    expect(matchStringOp(null, 'empty', '')).toBe(true);
    // '  ' (espaces seuls) n'est PAS vide côté SQL (`'  ' = ''` est faux) : le node condition doit classer pareil.
    expect(matchStringOp('  ', 'empty', '')).toBe(false);
    expect(matchStringOp('  ', 'not_empty', '')).toBe(true);
    expect(matchStringOp('x', 'empty', '')).toBe(false);
    expect(matchStringOp('x', 'not_empty', '')).toBe(true);
  });
  it('cible vide = filtre non posé (buildContactWhere fait `continue`) -> toujours vrai', () => {
    expect(matchStringOp('Lyon', 'eq', '')).toBe(true);
    expect(matchStringOp('Lyon', 'contains', '')).toBe(true);
    expect(matchStringOp('Lyon', 'not_contains', '')).toBe(true);
    expect(matchStringOp(null, 'eq', '')).toBe(true);
  });
});

describe('clause tag', () => {
  it('has / not_has', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'tag', op: 'has', tag: 'vip' }]), ctx({ tags: ['vip'] }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'tag', op: 'has', tag: 'vip' }]), ctx({ tags: ['x'] }))).toBe(false);
    expect(evaluateConditionGroup(grp([{ kind: 'tag', op: 'not_has', tag: 'spam' }]), ctx({ tags: ['vip'] }))).toBe(true);
  });
});

describe('clause field (texte / nombre / booléen / champs de base)', () => {
  it('texte : sur un champ perso', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'ville', op: 'eq', value: 'Paris' }]), ctx({ fields: { ville: 'Paris' } }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'ville', op: 'contains', value: 'par' }]), ctx({ fields: { ville: 'Paris' } }))).toBe(true);
  });
  it('champ de BASE : name/phone via attributs, email via fields', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'name', op: 'eq', value: 'Marc' }]), ctx({ name: 'Marc' }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'phone', op: 'not_empty' }]), ctx({ phone: '+33611' }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'email', op: 'contains', value: '@' }]), ctx({ fields: { email: 'a@b.fr' } }))).toBe(true);
  });
  it('nombre : lt/gte', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'gte', value: '18' }]), ctx({ fields: { age: '18' } }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'lt', value: '18' }]), ctx({ fields: { age: '20' } }))).toBe(false);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'lt', value: '18' }]), ctx({ fields: { age: 'abc' } }))).toBe(false); // non numérique
  });
  it('booléen : is_true / is_false (tolère oui/non/1/0)', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'consent', op: 'is_true' }]), ctx({ fields: { consent: 'true' } }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'consent', op: 'is_true' }]), ctx({ fields: { consent: 'oui' } }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'consent', op: 'is_false' }]), ctx({ fields: { consent: '0' } }))).toBe(true);
  });
});

describe('clause field — nombre typé (valueType) & valeur absente (régressions du reviewer Phase 1)', () => {
  it('eq NUMÉRIQUE quand valueType=number : 5.0 == 5', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'score', op: 'eq', value: '5', valueType: 'number' }]), ctx({ fields: { score: '5.0' } }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'score', op: 'eq', value: '5', valueType: 'number' }]), ctx({ fields: { score: '6' } }))).toBe(false);
  });
  it('eq TEXTE (sans valueType) reste une égalité de chaîne, jamais Number()', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'ref', op: 'eq', value: '5' }]), ctx({ fields: { ref: '5.0' } }))).toBe(false); // '5.0' !== '5'
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'ref', op: 'eq', value: '5' }]), ctx({ fields: { ref: '5' } }))).toBe(true);
    // garde-fou anti-régression : un champ texte gardé `eq` ne doit JAMAIS partir en Number('Paris')=NaN -> false
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'ville', op: 'eq', value: 'Paris' }]), ctx({ fields: { ville: 'Paris' } }))).toBe(true);
  });
  it('champ numérique ABSENT -> ne matche AUCUNE comparaison (piège Number(null)===0)', () => {
    const sans = ctx({ fields: {} }); // aucun champ `age`
    for (const op of ['lt', 'lte', 'gt', 'gte', 'neq', 'eq'] as const) {
      expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op, value: '18', valueType: 'number' }]), sans)).toBe(false);
    }
  });
  it('neq numérique sur valeur présente', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'neq', value: '18', valueType: 'number' }]), ctx({ fields: { age: '20' } }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'neq', value: '18', valueType: 'number' }]), ctx({ fields: { age: '18' } }))).toBe(false);
  });
  it('lte/gte inclusifs, lt/gt exclusifs à la borne d’égalité', () => {
    const eq18 = ctx({ fields: { age: '18' } });
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'lte', value: '18', valueType: 'number' }]), eq18)).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'gte', value: '18', valueType: 'number' }]), eq18)).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'lt', value: '18', valueType: 'number' }]), eq18)).toBe(false);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'gt', value: '18', valueType: 'number' }]), eq18)).toBe(false);
  });
  it('seuil numérique VIDE (oublié dans l’UI) -> pas de contrainte (true), pas `x >= 0`', () => {
    const trente = ctx({ fields: { age: '30' } });
    // avec le bug (Number('')===0), `age < ''` donnerait `30 < 0` -> false ; corrigé -> true (contrainte non posée)
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'lt', value: '', valueType: 'number' }]), trente)).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'field', key: 'age', op: 'gte', value: '', valueType: 'number' }]), trente)).toBe(true);
  });
});

describe('clause optin', () => {
  it('compare le statut', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'optin', value: 'opted_in' }]), ctx({ optIn: 'opted_in' }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'optin', value: 'opted_in' }]), ctx({ optIn: 'unknown' }))).toBe(false);
  });
});

describe('fuseau horaire (DST)', () => {
  it('minutesInZone respecte l’heure d’été/hiver de Paris', () => {
    expect(minutesInZone(new Date('2026-08-03T12:00:00Z'), PARIS)).toBe(14 * 60); // été = UTC+2
    expect(minutesInZone(new Date('2026-01-05T12:00:00Z'), PARIS)).toBe(13 * 60); // hiver = UTC+1
  });
  it('parseInstant : heure murale interprétée dans le fuseau', () => {
    expect(parseInstant('2026-08-03T14:00', PARIS).toISOString()).toBe('2026-08-03T12:00:00.000Z'); // été
    expect(parseInstant('2026-01-05T13:00', PARIS).toISOString()).toBe('2026-01-05T12:00:00.000Z'); // hiver
  });
  it('parseInstant : forme absolue (Z/offset) inchangée', () => {
    expect(parseInstant('2026-08-03T12:00:00Z', PARIS).toISOString()).toBe('2026-08-03T12:00:00.000Z');
  });
  it('parseInstant : heure murale au bord d’une bascule DST (correction 2 passes)', () => {
    // Printemps 2026 Paris : saut à 02:00->03:00 local (01:00 UTC). 01:30 local est ENCORE CET (+1) -> 00:30 UTC.
    expect(parseInstant('2026-03-29T01:30', PARIS).toISOString()).toBe('2026-03-29T00:30:00.000Z');
    // Automne 2026 Paris : retour à 03:00->02:00 local (01:00 UTC). 01:30 local (avant le retour) est CEST (+2) -> 23:30 UTC la veille.
    expect(parseInstant('2026-10-25T01:30', PARIS).toISOString()).toBe('2026-10-24T23:30:00.000Z');
  });
});

describe('clause datetime', () => {
  const base = ctx({ now: new Date('2026-08-10T10:00:00Z') });
  it('before / after NOW', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'rdv', op: 'after', value: 'now' }]), ctx({ ...base, fields: { rdv: '2026-08-20T10:00:00Z' } }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'rdv', op: 'before', value: 'now' }]), ctx({ ...base, fields: { rdv: '2026-08-01T10:00:00Z' } }))).toBe(true);
  });
  it('older_than / newer_than N jours vs NOW', () => {
    const dix = ctx({ ...base, fields: { last: '2026-07-31T10:00:00Z' } }); // il y a 10 jours
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'older_than', amount: 7, unit: 'days' }]), dix)).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'older_than', amount: 30, unit: 'days' }]), dix)).toBe(false);
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'newer_than', amount: 30, unit: 'days' }]), dix)).toBe(true);
  });
  it('empty / not_empty ; valeur illisible -> false', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'rdv', op: 'empty' }]), base)).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'rdv', op: 'after', value: 'now' }]), ctx({ ...base, fields: { rdv: 'pas-une-date' } }))).toBe(false);
  });
  it('before / after vs une DATE FIXE (pas now) ; base fixe illisible -> false', () => {
    const c = ctx({ ...base, fields: { rdv: '2026-08-12T10:00:00Z' } });
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'rdv', op: 'after', value: '2026-08-10T00:00:00Z' }]), c)).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'rdv', op: 'before', value: '2026-08-10T00:00:00Z' }]), c)).toBe(false);
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'rdv', op: 'before', value: 'pas-une-date' }]), c)).toBe(false);
  });
  it('older_than / newer_than : borne EXACTE (diff == amount) -> false des deux côtés (inégalités strictes)', () => {
    const now = new Date('2026-08-10T10:00:00Z');
    const sept = ctx({ now, fields: { last: '2026-08-03T10:00:00Z' } }); // exactement 7 jours
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'older_than', amount: 7, unit: 'days' }]), sept)).toBe(false);
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'newer_than', amount: 7, unit: 'days' }]), sept)).toBe(false);
  });
  it('unités heures / minutes de older_than/newer_than', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const deuxH = ctx({ now, fields: { last: '2026-08-10T10:00:00Z' } }); // il y a 2 h
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'older_than', amount: 1, unit: 'hours' }]), deuxH)).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'older_than', amount: 3, unit: 'hours' }]), deuxH)).toBe(false);
    const demiH = ctx({ now, fields: { last: '2026-08-10T11:30:00Z' } }); // il y a 30 min
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'newer_than', amount: 60, unit: 'minutes' }]), demiH)).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'older_than', amount: 60, unit: 'minutes' }]), demiH)).toBe(false);
  });
  it('amount en STRING numérique (donnée opaque) est coercé, pas traité comme absent', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const vieux = ctx({ now, fields: { last: '2026-08-08T12:00:00Z' } }); // il y a 2 jours
    // amount:'1' coercé -> 1 jour -> 2 jours > 1 jour -> older_than vrai
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'older_than', amount: '1' as unknown as number, unit: 'days' }]), vieux)).toBe(true);
    // amount:'5' coercé -> 5 jours -> 2 jours < 5 jours -> older_than FAUX (avec le bug relMs=0, ce serait vrai)
    expect(evaluateConditionGroup(grp([{ kind: 'datetime', key: 'last', op: 'older_than', amount: '5' as unknown as number, unit: 'days' }]), vieux)).toBe(false);
  });
});

describe('clause weekday (dans le fuseau)', () => {
  it('lundi = jour de semaine ; samedi = week-end', () => {
    expect(weekdayInZone(new Date('2026-08-03T12:00:00Z'), PARIS)).toBe(1); // lundi
    expect(weekdayInZone(new Date('2026-08-01T12:00:00Z'), PARIS)).toBe(6); // samedi
    expect(evaluateConditionGroup(grp([{ kind: 'weekday', op: 'is_weekday' }]), ctx({ now: new Date('2026-08-03T12:00:00Z') }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'weekday', op: 'is_weekend' }]), ctx({ now: new Date('2026-08-01T12:00:00Z') }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'weekday', op: 'is_one_of', days: [1, 3] }]), ctx({ now: new Date('2026-08-03T12:00:00Z') }))).toBe(true);
  });
});

describe('clause business_hours', () => {
  it('within / outside selon l’heure de Paris et le jour', () => {
    // Lundi 14:00 Paris (12:00 UTC) -> dans 09:00-18:00
    expect(withinBusinessHours(new Date('2026-08-03T12:00:00Z'), PARIS, BH)).toBe(true);
    // Lundi 22:00 Paris (20:00 UTC) -> hors
    expect(withinBusinessHours(new Date('2026-08-03T20:00:00Z'), PARIS, BH)).toBe(false);
    // Samedi -> jour fermé
    expect(withinBusinessHours(new Date('2026-08-01T12:00:00Z'), PARIS, BH)).toBe(false);
    expect(evaluateConditionGroup(grp([{ kind: 'business_hours', op: 'within' }]), ctx({ now: new Date('2026-08-03T12:00:00Z') }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'business_hours', op: 'outside' }]), ctx({ now: new Date('2026-08-03T20:00:00Z') }))).toBe(true);
  });
  it('borne [open, close) : open inclus, close exclu ; plage close<=open -> jamais ouvert', () => {
    // Lundi été (UTC+2) : 09:00 Paris = 07:00 UTC (open, inclus) ; 18:00 Paris = 16:00 UTC (close, exclu)
    expect(withinBusinessHours(new Date('2026-08-03T07:00:00Z'), PARIS, BH)).toBe(true);
    expect(withinBusinessHours(new Date('2026-08-03T16:00:00Z'), PARIS, BH)).toBe(false);
    // Plage inversée (open >= close, mal saisie) -> jamais ouvert quelle que soit l'heure
    const inv: BusinessHours = { ...BH, '1': { closed: false, open: '18:00', close: '09:00' } };
    expect(withinBusinessHours(new Date('2026-08-03T12:00:00Z'), PARIS, inv)).toBe(false);
  });
});

describe('clause time_of_day & identity', () => {
  it('time_of_day before/after (heure locale)', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'time_of_day', op: 'after', time: '13:00' }]), ctx({ now: new Date('2026-08-03T12:00:00Z') }))).toBe(true); // 14:00 Paris > 13:00
    expect(evaluateConditionGroup(grp([{ kind: 'time_of_day', op: 'before', time: '13:00' }]), ctx({ now: new Date('2026-08-03T12:00:00Z') }))).toBe(false);
  });
  it('identity has_phone / has_email', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'identity', op: 'has_phone' }]), ctx({ phone: '+33611' }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'identity', op: 'has_phone' }]), ctx({ phone: null }))).toBe(false);
    expect(evaluateConditionGroup(grp([{ kind: 'identity', op: 'has_email' }]), ctx({ fields: { email: 'a@b.fr' } }))).toBe(true);
  });
  it('identity has_bsuid (vrai/faux) & has_email faux', () => {
    expect(evaluateConditionGroup(grp([{ kind: 'identity', op: 'has_bsuid' }]), ctx({ bsuid: 'BSU_abc' }))).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'identity', op: 'has_bsuid' }]), ctx({ bsuid: null }))).toBe(false);
    expect(evaluateConditionGroup(grp([{ kind: 'identity', op: 'has_email' }]), ctx({ fields: {} }))).toBe(false);
  });
});

describe('combinaison ET / OU', () => {
  it('all = ET, any = OU', () => {
    const c = ctx({ tags: ['vip'], fields: { age: '30' } });
    expect(evaluateConditionGroup(grp([{ kind: 'tag', op: 'has', tag: 'vip' }, { kind: 'field', key: 'age', op: 'gte', value: '18' }], 'all'), c)).toBe(true);
    expect(evaluateConditionGroup(grp([{ kind: 'tag', op: 'has', tag: 'vip' }, { kind: 'field', key: 'age', op: 'lt', value: '18' }], 'all'), c)).toBe(false);
    expect(evaluateConditionGroup(grp([{ kind: 'tag', op: 'has', tag: 'absent' }, { kind: 'field', key: 'age', op: 'gte', value: '18' }], 'any'), c)).toBe(true);
  });
  it('groupe vide : all -> vrai, any -> faux', () => {
    expect(evaluateConditionGroup(grp([], 'all'), ctx())).toBe(true);
    expect(evaluateConditionGroup(grp([], 'any'), ctx())).toBe(false);
  });
});

describe('robustesse défensive (Phase 2 nourrira l’évaluateur avec des données de graphe opaques)', () => {
  it('une clause qui throw est isolée -> false, sans casser le groupe', () => {
    // ctx.tags malformé (null) -> `.includes` throw -> la clause vaut false via le try/catch, pas d'exception qui remonte.
    const ctxBad = { ...ctx(), tags: null as unknown as string[] };
    expect(evaluateConditionGroup(grp([{ kind: 'tag', op: 'has', tag: 'vip' }]), ctxBad)).toBe(false);
    // en OU avec une clause valide vraie, le groupe reste évaluable (la clause cassée ne le fait pas planter)
    expect(evaluateConditionGroup(grp([{ kind: 'tag', op: 'has', tag: 'vip' }, { kind: 'optin', value: 'unknown' }], 'any'), ctxBad)).toBe(true);
  });
  it('op non reconnu sur un champ -> clause non satisfaite (false), pas de throw', () => {
    const weird = { kind: 'field', key: 'age', op: 'wat' } as unknown as Clause;
    expect(evaluateConditionGroup(grp([weird]), ctx({ fields: { age: '18' } }))).toBe(false);
  });
});

/**
 * Le bloc Condition sur la dernière analyse (lot 2b « Tout sur la fiche ») : les mêmes opérateurs et le même sens
 * des seuils que les filtres de la liste des contacts, lus sur la copie de la fiche (`ctx.analyse`), jamais sur un
 * champ perso homonyme.
 */
describe('clause field sur la dernière analyse', () => {
  const analyse = {
    intention: 'reclamation', sentiment: 'negatif', satisfaction: 0, urgence: 8, resolue: false, sujet: 'colis',
    traiteePar: 'humain', action: 'rappeler', analyseLe: new Date('2026-08-01T12:00:00Z'),
    fenetreFin: new Date('2026-08-01T11:00:00Z'), conversationId: null,
  } as const satisfies EvalContext['analyse'];
  const si = (c: Clause, o: Partial<EvalContext> = {}) => evaluateConditionGroup(grp([c]), ctx(o));

  it('les opérateurs de la liste des contacts : choix, seuils, oui/non, ancienneté', () => {
    expect(si({ kind: 'field', key: 'analyse_sentiment', op: 'in', value: 'neutre,negatif' }, { analyse })).toBe(true);
    expect(si({ kind: 'field', key: 'analyse_urgence', op: 'gte', value: '7' }, { analyse })).toBe(true);
    expect(si({ kind: 'field', key: 'analyse_urgence', op: 'gte', value: '9' }, { analyse })).toBe(false);
    expect(si({ kind: 'field', key: 'analyse_resolue', op: 'is_false' }, { analyse })).toBe(true);
    // Deux jours avant « maintenant » (2026-08-03 12:00 UTC).
    expect(si({ kind: 'field', key: 'analyse_le', op: 'newer_than_days', value: '3' }, { analyse })).toBe(true);
    expect(si({ kind: 'field', key: 'analyse_le', op: 'newer_than_days', value: '1' }, { analyse })).toBe(false);
  });

  it('🔴 une satisfaction de 0 est une mesure, `null` n’en est pas une', () => {
    expect(si({ kind: 'field', key: 'analyse_satisfaction', op: 'lte', value: '3' }, { analyse })).toBe(true);
    expect(si({ kind: 'field', key: 'analyse_satisfaction', op: 'lte', value: '3' }, { analyse: { ...analyse, satisfaction: null } })).toBe(false);
    expect(si({ kind: 'field', key: 'analyse_satisfaction', op: 'empty' }, { analyse: { ...analyse, satisfaction: null } })).toBe(true);
  });

  it('🔴 une fiche jamais analysée : « non résolue » est faux, seul « vide » est vrai', () => {
    expect(si({ kind: 'field', key: 'analyse_resolue', op: 'is_false' })).toBe(false);
    expect(si({ kind: 'field', key: 'analyse_resolue', op: 'empty' })).toBe(true);
  });

  it('🔴 un champ perso homonyme est IGNORÉ : seule la copie de la fiche compte', () => {
    const fields = { analyse_sentiment: 'negatif', analyse_urgence: '10', analyse_resolue: 'false' };
    expect(si({ kind: 'field', key: 'analyse_sentiment', op: 'in', value: 'negatif' }, { fields })).toBe(false);
    expect(si({ kind: 'field', key: 'analyse_urgence', op: 'gte', value: '7' }, { fields })).toBe(false);
    expect(si({ kind: 'field', key: 'analyse_resolue', op: 'is_false' }, { fields })).toBe(false);
  });

  it('un opérateur que le champ ne connaît pas rend faux, jamais une égalité de texte devinée', () => {
    expect(si({ kind: 'field', key: 'analyse_sentiment', op: 'eq', value: 'negatif' }, { analyse })).toBe(false);
    expect(si({ kind: 'field', key: 'analyse_sentiment', op: 'contains', value: 'neg' }, { analyse })).toBe(false);
  });

  it('une clause datée sur la date d’analyse lit la copie (ISO)', () => {
    expect(si({ kind: 'datetime', key: 'analyse_le', op: 'before', value: '2026-08-02' }, { analyse })).toBe(true);
    expect(si({ kind: 'datetime', key: 'analyse_le', op: 'after', value: '2026-08-02' }, { analyse })).toBe(false);
    expect(si({ kind: 'datetime', key: 'analyse_le', op: 'empty' })).toBe(true);
  });

  it('🔴 le sujet n’est pas un critère (décision 12), même écrit à la main dans un graphe', () => {
    expect(si({ kind: 'field', key: 'analyse_sujet', op: 'contains', value: 'colis' }, { analyse })).toBe(false);
    expect(si({ kind: 'field', key: 'analyse_sujet', op: 'not_empty' }, { analyse })).toBe(false);
  });

  it('un opérateur de colonne sur un champ perso rend faux', () => {
    expect(si({ kind: 'field', key: 'ville', op: 'in', value: 'Paris' }, { fields: { ville: 'Paris' } })).toBe(false);
  });
});

/**
 * LES CHAMPS SYSTÈME (RC5) : ce que la plateforme sait du contact sans qu'il l'ait saisi. Chaque clause est testée
 * valeur PRÉSENTE et valeur ABSENTE : absente (jamais chargée, jamais apprise, pas de numéro) veut dire vide, et une
 * condition ne doit jamais inventer une valeur à sa place.
 */
describe('champs système : dernier message reçu, langue détectée, pays de l’indicatif', () => {
  const si = (c: Clause, over: Partial<EvalContext> = {}) => evaluateConditionGroup(grp([c]), ctx(over));
  // ctx().now = 2026-08-03T12:00:00Z
  const ilYA = (jours: number) => new Date(Date.parse('2026-08-03T12:00:00Z') - jours * 86_400_000).toISOString();

  it('dernier message reçu : plus vieux / plus récent qu’une durée, avant / après une date', () => {
    const vieux = { dernierMessageRecu: ilYA(10) };
    expect(si({ kind: 'dernier_message_recu', op: 'older_than', amount: 7, unit: 'days' }, vieux)).toBe(true);
    expect(si({ kind: 'dernier_message_recu', op: 'newer_than', amount: 7, unit: 'days' }, vieux)).toBe(false);
    expect(si({ kind: 'dernier_message_recu', op: 'newer_than', amount: 7, unit: 'days' }, { dernierMessageRecu: ilYA(2) })).toBe(true);
    expect(si({ kind: 'dernier_message_recu', op: 'before', value: '2026-08-01' }, vieux)).toBe(true);
    expect(si({ kind: 'dernier_message_recu', op: 'after', value: '2026-08-01' }, vieux)).toBe(false);
    expect(si({ kind: 'dernier_message_recu', op: 'not_empty' }, vieux)).toBe(true);
  });

  it('🔴 dernier message reçu ABSENT (jamais écrit, ou non chargé) : vide, et aucune comparaison de date ne passe', () => {
    for (const absent of [{}, { dernierMessageRecu: null }]) {
      expect(si({ kind: 'dernier_message_recu', op: 'empty' }, absent)).toBe(true);
      expect(si({ kind: 'dernier_message_recu', op: 'not_empty' }, absent)).toBe(false);
      // « plus vieux que 7 jours » ne doit PAS être vrai pour quelqu'un dont on ne connaît aucun message.
      expect(si({ kind: 'dernier_message_recu', op: 'older_than', amount: 7, unit: 'days' }, absent)).toBe(false);
      expect(si({ kind: 'dernier_message_recu', op: 'newer_than', amount: 7, unit: 'days' }, absent)).toBe(false);
    }
  });

  it('langue détectée : comparée sur la langue principale, sans casse', () => {
    expect(si({ kind: 'langue_detectee', op: 'is', value: 'en' }, { langueDetectee: 'en' })).toBe(true);
    expect(si({ kind: 'langue_detectee', op: 'is', value: 'en' }, { langueDetectee: 'EN-us' })).toBe(true);
    expect(si({ kind: 'langue_detectee', op: 'is', value: 'en' }, { langueDetectee: 'es' })).toBe(false);
    expect(si({ kind: 'langue_detectee', op: 'is_not', value: 'fr' }, { langueDetectee: 'es' })).toBe(true);
    expect(si({ kind: 'langue_detectee', op: 'is_not', value: 'fr' }, { langueDetectee: 'fr_FR' })).toBe(false);
    expect(si({ kind: 'langue_detectee', op: 'not_empty' }, { langueDetectee: 'es' })).toBe(true);
    // 🔴 Une cible vide (champ effacé à l'écran) ne contraint rien, dans les deux sens : elle ne retient pas d'office
    // tous les contacts sans langue apprise.
    expect(si({ kind: 'langue_detectee', op: 'is', value: '' }, { langueDetectee: null })).toBe(true);
    expect(si({ kind: 'langue_detectee', op: 'is', value: '  ' }, { langueDetectee: 'en' })).toBe(true);
    expect(si({ kind: 'langue_detectee', op: 'is_not', value: '' }, { langueDetectee: null })).toBe(true);
  });

  it('🔴 langue JAMAIS apprise : vide, jamais « français » par défaut', () => {
    for (const absent of [{}, { langueDetectee: null }, { langueDetectee: '  ' }]) {
      expect(si({ kind: 'langue_detectee', op: 'empty' }, absent)).toBe(true);
      expect(si({ kind: 'langue_detectee', op: 'is', value: 'fr' }, absent)).toBe(false);
      // Ce qu'on ne sait pas n'est pas l'anglais : « n'est pas l'anglais » est vrai.
      expect(si({ kind: 'langue_detectee', op: 'is_not', value: 'en' }, absent)).toBe(true);
    }
  });

  it('pays de l’indicatif : déduit du numéro de la fiche, comparé à une liste', () => {
    expect(si({ kind: 'pays', op: 'is_one_of', values: ['FR'] }, { phone: '+33612345678' })).toBe(true);
    expect(si({ kind: 'pays', op: 'is_one_of', values: ['BE', 'ch'] }, { phone: '+41791234567' })).toBe(true);
    expect(si({ kind: 'pays', op: 'is_one_of', values: ['FR'] }, { phone: '+32470123456' })).toBe(false);
    // Un indicatif partagé se départage par les chiffres suivants : +1 613 est le Canada, pas les États-Unis.
    expect(si({ kind: 'pays', op: 'is_one_of', values: ['US'] }, { phone: '+16135550123' })).toBe(false);
    expect(si({ kind: 'pays', op: 'is_one_of', values: ['CA'] }, { phone: '+16135550123' })).toBe(true);
  });

  it('🔴 pays ABSENT (aucun numéro, contact BSUID seul, plage inconnue) : aucun pays, la clause ne retient pas', () => {
    for (const phone of [null, '', '+1', '+999123']) {
      expect(si({ kind: 'pays', op: 'is_one_of', values: ['FR', 'US'] }, { phone, bsuid: 'B1' })).toBe(false);
    }
    // Une liste vide ne retient personne, comme « est un de ces jours » sans jour coché.
    expect(si({ kind: 'pays', op: 'is_one_of', values: [] }, { phone: '+33612345678' })).toBe(false);
  });
});
