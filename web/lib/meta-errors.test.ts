import { describe, it, expect } from 'vitest';
import { explainMetaError, metaCodeLabel, CODES_CONNUS } from './meta-errors';

describe('explainMetaError (famille variables de template F5/F7)', () => {
  it('traduit 131009 / 132012 / 132000 (les 3 codes de variables qui arrivent réellement)', () => {
    for (const code of ['131009', '132012', '132000']) {
      const out = explainMetaError(`${code} something`, 'fr');
      expect(out).not.toBeNull();
      expect(out).toContain(`code ${code}`);
      expect(out).not.toBe(`${code} something`); // bien traduit, pas le texte brut
    }
  });

  it('code inconnu -> texte brut inchangé ; null -> null', () => {
    expect(explainMetaError('999999 mystère', 'fr')).toBe('999999 mystère');
    expect(explainMetaError(null, 'fr')).toBeNull();
    expect(explainMetaError('', 'fr')).toBeNull();
  });

  it('metaCodeLabel : 131009 répertorié ; code inconnu -> libellé générique', () => {
    expect(metaCodeLabel(131009, 'fr')).not.toBe('Erreur Meta (code non répertorié)');
    expect(metaCodeLabel(999999, 'fr')).toBe('Erreur Meta (code non répertorié)');
  });
});

describe('honnêteté des libellés : ne pas affirmer une cause plus étroite que Meta', () => {
  it('132012 ne désigne plus LA variable comme cause (le template qui a déclenché ce bug n en a aucune)', () => {
    const out = explainMetaError('132012 Parameter format does not match format in the created template', 'fr')!;
    expect(out).not.toMatch(/format d'une variable/);
    expect(out).toMatch(/carousel/i); // les autres causes réelles sont nommées
    expect(out).toContain('code 132012');
  });

  it('131009 couvre tout paramètre refusé, pas seulement une variable de corps', () => {
    const out = explainMetaError('131009 Parameter value is not valid', 'fr')!;
    expect(out).toMatch(/image|jeton|paramètre/i);
  });
});

/**
 * Ces messages sortaient en français sur une console en anglais : la table était mono-langue et les deux
 * fonctions n'avaient aucun moyen de savoir dans quelle langue on lisait l'écran.
 */
describe('la langue de la console est respectée', () => {
  it('🔴 un code répertorié s’explique en anglais', () => {
    const out = explainMetaError('131047 re-engagement message', 'en')!;
    expect(out).toContain('24-hour service window');
    expect(out).toContain('code 131047');
    expect(out).not.toMatch(/Fenêtre|template \(pas un/);
  });

  it('🔴 le libellé de repli suit la langue lui aussi', () => {
    expect(metaCodeLabel(999999, 'en')).toBe('Meta error (code not listed)');
    expect(metaCodeLabel(999999, 'fr')).toBe('Erreur Meta (code non répertorié)');
  });

  it('🔴 AUCUN code ne reste sans traduction anglaise', () => {
    // Le filet : le jour où on ajoute un code, ce test tombe si on n'écrit que le français.
    //
    // Il itère la VRAIE table (`CODES_CONNUS`), pas une liste recopiée ici : une copie ne serait pas un
    // filet, elle vieillirait en silence et le code neuf, jamais listé, ne serait jamais vérifié.
    expect(CODES_CONNUS.length).toBeGreaterThan(0);
    for (const code of CODES_CONNUS) {
      const n = Number(code);
      const fr = metaCodeLabel(n, 'fr');
      const en = metaCodeLabel(n, 'en');
      expect(fr, code).not.toBe('Erreur Meta (code non répertorié)');
      expect(en, code).not.toBe('Meta error (code not listed)');
      expect(en, code).not.toBe(fr); // pas un copier-coller du français
    }
  });
});
