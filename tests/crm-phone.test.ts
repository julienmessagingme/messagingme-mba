import { describe, it, expect } from 'vitest';
import { e164DepuisSaisie, normalizePhone } from '../src/crm/phone';

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

describe('e164DepuisSaisie : le numéro tel qu’un appelant le donne', () => {
  it('🔴 un identifiant WhatsApp (indicatif sans « + ») devient le E.164 de la fiche', () => {
    // C'est la forme que le relais de l'agent de Meta pose depuis la conversation (essai réel du 2026-10-02).
    expect(e164DepuisSaisie('33612345678')).toBe('+33612345678');
    expect(e164DepuisSaisie('447911123456')).toBe('+447911123456');
  });
  it('un E.164, un national et un national sans son 0 donnent le même numéro', () => {
    expect(e164DepuisSaisie('+33612345678')).toBe('+33612345678');
    expect(e164DepuisSaisie('06 12 34 56 78')).toBe('+33612345678');
    expect(e164DepuisSaisie('612345678')).toBe('+33612345678');
  });
  it('illisible ou vide : null, jamais une valeur inventée', () => {
    expect(e164DepuisSaisie('pas un numero')).toBeNull();
    expect(e164DepuisSaisie('   ')).toBeNull();
    expect(e164DepuisSaisie('123')).toBeNull();
  });
});
