import { describe, expect, it, vi } from 'vitest';

/**
 * Les TROIS encodages base32 de `src/ids/code.ts` (l'aléa d'un ULID, les codes tirés au sort, la racine d'un
 * espace) passent par une seule fonction depuis l'audit ponytail du 2026-09-25. Ces valeurs connues ont été
 * CALCULÉES PAR L'ANCIEN CODE (trois boucles recopiées) sur les mêmes octets : un encodage qui changerait
 * d'un bit changerait les identifiants publics de tous les espaces à venir.
 */
const OCTETS = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256));
vi.mock('node:crypto', async (original) => {
  const vrai = await original<typeof import('node:crypto')>();
  return { ...vrai, randomBytes: (n: number) => Buffer.from(OCTETS.subarray(0, n)) };
});

describe('base32 des identifiants : valeurs connues', async () => {
  const { newUlid, newTrackingCode, newWebhookCode, newMediaCode, deriveTenantCode } = await import('../src/ids/code');

  it('l’aléa d’un ULID (16 caractères, majuscules) après ses 10 caractères de temps', () => {
    expect(newUlid(1_760_000_000_000)).toBe('01K742SG001CR5AYMZRKMGWCTR');
  });

  it('les codes tirés au sort : lien tracé (12), webhook entrant et visuel RCS (26), en minuscules', () => {
    expect(newTrackingCode()).toBe('1cr5aymzrkmg');
    expect(newWebhookCode()).toBe('1cr5aymzrkmgwctrfphcfv0h6s');
    expect(newMediaCode()).toBe('1cr5aymzrkmgwctrfphcfv0h6s');
  });

  it('la racine d’un espace, dérivée de son uuid', () => {
    expect(deriveTenantCode('00000000-0000-0000-0000-000000000001')).toBe('fb0vhn');
    expect(deriveTenantCode('seed')).toBe('36s5gn');
  });
});
