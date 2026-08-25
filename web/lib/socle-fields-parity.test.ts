import { describe, it, expect } from 'vitest';
import { SOCLE_CLES } from './fields';
import { SOCLE_FIELDS } from '../../src/crm/fields';

/**
 * Les champs SOCLE sont ceux que le serveur matérialise à la première écriture. Le front en a besoin pour
 * leur donner une ligne DÉDIÉE sur la fiche contact (toujours visible, même vide) et pour ne pas les
 * re-proposer à l'ajout.
 *
 * La liste est recopiée plutôt qu'importée, pour ne pas tirer du code serveur dans le bundle client. Ce test
 * casse dès qu'elles divergent : un champ socle ajouté côté serveur et oublié ici resterait invisible sur une
 * fiche vierge, exactement le défaut que ce lot répare pour `email`.
 *
 * ⚠️ Il vit dans `web/` et non dans `tests/` : la suite racine n'a pas la lib DOM, et importer `web/lib/fields`
 * depuis là tire `web/lib/api` puis `http.ts`, qui référence `window`.
 */
describe('parité des champs socle front / back', () => {
  it('les deux listes portent exactement les mêmes clés', () => {
    expect([...SOCLE_CLES].sort()).toEqual(SOCLE_FIELDS.map((f) => f.key).sort());
  });
});
