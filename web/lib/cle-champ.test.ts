import { describe, expect, it } from 'vitest';
import { cleChampCsv, slugify } from './partage/cle-champ';

describe('clé de champ CSV partagée', () => {
  it('donne la même clé pour le libellé affiché et l’en-tête importé', () => {
    expect(slugify('Ville de résidence')).toBe('ville_de_residence');
    expect(cleChampCsv('Ville de résidence')).toBe('ville_de_residence');
    expect(cleChampCsv('Ville de résidence', '')).toBe('ville_de_residence');
    expect(cleChampCsv('???')).toBe('field');
  });

  it('ne transforme pas une clé explicite visant un champ existant', () => {
    expect(cleChampCsv('Code client', 'crmClient')).toBe('crmClient');
  });
});
