import { describe, it, expect } from 'vitest';
import { normalizePhone } from '../src/crm/phone';

describe('normalizePhone (FR par défaut)', () => {
  it('06 national -> E.164', () => {
    expect(normalizePhone('0612345678').e164).toBe('+33612345678');
  });
  it('07 national -> E.164', () => {
    expect(normalizePhone('0712345678').e164).toBe('+33712345678');
  });
  it('espaces et points tolérés', () => {
    expect(normalizePhone('06 12 34 56 78').e164).toBe('+33612345678');
    expect(normalizePhone('06.12.34.56.78').e164).toBe('+33612345678');
  });
  it('format international +33', () => {
    expect(normalizePhone('+33 6 12 34 56 78').e164).toBe('+33612345678');
  });
  it('numéro invalide -> erreur', () => {
    expect(normalizePhone('123').e164).toBeUndefined();
    expect(normalizePhone('123').error).toBeTruthy();
    expect(normalizePhone('pas un numero').error).toBeTruthy();
  });
  it('vide -> erreur', () => {
    expect(normalizePhone('   ').error).toBeTruthy();
  });
});
