import { describe, it, expect } from 'vitest';
import { classifyWaId, contactIdentity } from '../src/crm/identity';

describe('classifyWaId', () => {
  it('un wa_id de 7 à 15 chiffres = numéro E.164 (+ préfixé)', () => {
    expect(classifyWaId('33612345678')).toEqual({ phoneE164: '+33612345678' });
    expect(classifyWaId('12025550123')).toEqual({ phoneE164: '+12025550123' });
    expect(classifyWaId('  33612345678 ')).toEqual({ phoneE164: '+33612345678' }); // trim
  });

  it('plus de 15 chiffres OU non numérique = BSUID opaque', () => {
    expect(classifyWaId('1234567890123456')).toEqual({ bsuid: '1234567890123456' }); // 16 chiffres
    expect(classifyWaId('bsuid_ABC123')).toEqual({ bsuid: 'bsuid_ABC123' });
  });
});

describe('contactIdentity', () => {
  it('numéro prioritaire, sinon BSUID, sinon null', () => {
    expect(contactIdentity('+33611', 'BS1')).toBe('+33611');
    expect(contactIdentity(null, 'BS1')).toBe('BS1');
    expect(contactIdentity(null, null)).toBeNull();
    expect(contactIdentity(undefined, undefined)).toBeNull();
  });
});
