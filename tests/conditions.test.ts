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
    fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null,
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
  it('empty / not_empty', () => {
    expect(matchStringOp(null, 'empty', '')).toBe(true);
    expect(matchStringOp('  ', 'empty', '')).toBe(true);
    expect(matchStringOp('x', 'empty', '')).toBe(false);
    expect(matchStringOp('x', 'not_empty', '')).toBe(true);
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
