import { describe, it, expect } from 'vitest';
import { explainMetaError, metaCodeLabel } from './meta-errors';

describe('explainMetaError (famille variables de template F5/F7)', () => {
  it('traduit 131009 / 132012 / 132000 (les 3 codes de variables qui arrivent réellement)', () => {
    for (const code of ['131009', '132012', '132000']) {
      const out = explainMetaError(`${code} something`);
      expect(out).not.toBeNull();
      expect(out).toContain(`code ${code}`);
      expect(out).not.toBe(`${code} something`); // bien traduit, pas le texte brut
    }
  });

  it('code inconnu -> texte brut inchangé ; null -> null', () => {
    expect(explainMetaError('999999 mystère')).toBe('999999 mystère');
    expect(explainMetaError(null)).toBeNull();
    expect(explainMetaError('')).toBeNull();
  });

  it('metaCodeLabel : 131009 répertorié ; code inconnu -> libellé générique', () => {
    expect(metaCodeLabel(131009)).not.toBe('Erreur Meta (code non répertorié)');
    expect(metaCodeLabel(999999)).toBe('Erreur Meta (code non répertorié)');
  });
});

describe('honnêteté des libellés : ne pas affirmer une cause plus étroite que Meta', () => {
  it('132012 ne désigne plus LA variable comme cause (le template qui a déclenché ce bug n en a aucune)', () => {
    const out = explainMetaError('132012 Parameter format does not match format in the created template')!;
    expect(out).not.toMatch(/format d'une variable/);
    expect(out).toMatch(/carousel/i); // les autres causes réelles sont nommées
    expect(out).toContain('code 132012');
  });

  it('131009 couvre tout paramètre refusé, pas seulement une variable de corps', () => {
    const out = explainMetaError('131009 Parameter value is not valid')!;
    expect(out).toMatch(/image|jeton|paramètre/i);
  });
});
