import { describe, it, expect } from 'vitest';
import { filtersToQuery, type ContactFilters } from '../web/lib/contact-filters';
import { parseFilters } from '../src/http/import';

// Anti-drift : la sérialisation côté web (`filtersToQuery`) et le parse côté serveur (`parseFilters`) doivent
// s'accorder sur le format fil. On sérialise puis on re-parse : le résultat doit être IDENTIQUE à l'entrée.
// Si un opérateur / critère est ajouté d'un seul côté, ce test casse (le filtre serait silencieusement no-op).

function roundTrip(f: ContactFilters): ContactFilters {
  const qs = filtersToQuery(f);
  return parseFilters(Object.fromEntries(qs.entries()));
}

describe('filtersToQuery (web) <-> parseFilters (serveur) — round-trip', () => {
  it('jeu complet (tags, tagsExclude, optIn, phone, name, 3 ops de champ dont empty) survit intact', () => {
    const f: ContactFilters = {
      tags: ['vip'],
      tagMode: 'or',
      tagsExclude: ['spam'],
      optIn: 'opted_in',
      phonePrefix: '+336',
      phoneContains: '4242',
      nameSearch: 'marc',
      joignabiliteWhatsApp: 'connu_injoignable',
      fieldFilters: [
        { key: 'email', op: 'not_empty', value: '' },
        { key: 'ville', op: 'not_contains', value: 'paris' },
        { key: 'segment', op: 'eq', value: 'vip' },
      ],
    };
    expect(roundTrip(f)).toEqual(f);
  });

  it('tagsExclude seul est préservé (pas absorbé par tags)', () => {
    expect(roundTrip({ tagsExclude: ['a', 'b'] })).toEqual({ tagsExclude: ['a', 'b'] });
  });

  it('un filtre empty (sans valeur) survit avec value: ""', () => {
    const f: ContactFilters = { fieldFilters: [{ key: 'email', op: 'empty', value: '' }] };
    expect(roundTrip(f)).toEqual(f);
  });

  it('filtres vides -> objet vide des deux côtés', () => {
    expect(roundTrip({})).toEqual({});
  });

  // 🔴 SEUL, il doit survivre. Un critère ajouté d'un seul côté de la chaîne ne casse RIEN de visible : il
  // est simplement perdu en route, et l'écran affiche un filtre coché qui ne filtre pas.
  it('la joignabilité seule survit au round-trip', () => {
    expect(roundTrip({ joignabiliteWhatsApp: 'connu_injoignable' })).toEqual({ joignabiliteWhatsApp: 'connu_injoignable' });
  });
});
