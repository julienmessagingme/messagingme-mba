import { describe, it, expect } from 'vitest';
import { newUlid, makeCode, deriveTenantCode } from '../src/ids/code';

const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]+$/; // base32 Crockford (sans I, L, O, U)

describe('newUlid', () => {
  it('26 caractères Crockford base32', () => {
    const u = newUlid();
    expect(u).toHaveLength(26);
    expect(u).toMatch(CROCKFORD_RE);
  });

  it('triable dans le temps (préfixe temps croissant)', () => {
    const a = newUlid(1_000_000_000_000);
    const b = newUlid(1_000_000_000_001);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  it('zéro collision sur 2000 tirages', () => {
    const set = new Set<string>();
    for (let i = 0; i < 2000; i += 1) set.add(newUlid());
    expect(set.size).toBe(2000);
  });
});

describe('makeCode', () => {
  it('format <type>_<client>_<ulid> avec le bon préfixe', () => {
    const c = makeCode('scn', 'k7m2p3');
    const parts = c.split('_');
    expect(parts[0]).toBe('scn');
    expect(parts[1]).toBe('k7m2p3');
    expect(parts[2]).toHaveLength(26);
    expect(parts[2]).toMatch(CROCKFORD_RE);
  });

  it('deux codes du même type/client diffèrent (ULID)', () => {
    expect(makeCode('fld', 'abc123')).not.toBe(makeCode('fld', 'abc123'));
  });
});

describe('deriveTenantCode', () => {
  it('déterministe : même seed -> même code (immuable, réutilisable au backfill)', () => {
    const seed = '11111111-2222-3333-4444-555555555555';
    expect(deriveTenantCode(seed)).toBe(deriveTenantCode(seed));
  });

  it('6 caractères base32 minuscules', () => {
    const c = deriveTenantCode('any-seed');
    expect(c).toHaveLength(6);
    expect(c).toMatch(/^[0-9a-hjkmnp-tv-z]+$/);
  });

  it('des seeds différents donnent des codes différents (attendu)', () => {
    expect(deriveTenantCode('tenant-a')).not.toBe(deriveTenantCode('tenant-b'));
  });
});

// Le `systemFieldCode` SERVEUR testé ici n'avait aucun appelant : ce test protégeait un générateur mort
// pendant que le générateur VIVANT (celui du front) n'était couvert par rien. Les deux sont corrigés :
// la fonction serveur est supprimée, et la fonction front est testée dans `tests/web-codes.test.ts`.
