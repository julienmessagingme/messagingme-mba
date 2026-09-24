import { describe, it, expect } from 'vitest';
import { validateParamMapping, parseParamHints, resolveTemplateParams } from '../src/crm/template';

/**
 * LA SOURCE « variable » (spec 2026-09-24, § 3, lot 3) : un paramètre de template lu dans les variables
 * du DESTINATAIRE d'un envoi de l'API, jamais sur sa fiche.
 */
describe('la source de paramètre « variable »', () => {
  const mapping = [{ position: 1, source: { type: 'variable', key: 'commande' } }];

  it('🔴 la console la REFUSE : une variable de destinataire n’existe que dans un envoi de l’API', () => {
    expect(validateParamMapping(mapping)).toBeNull();
  });

  it('l’API l’accepte, avec un nom de variable bien formé seulement', () => {
    expect(validateParamMapping(mapping, { accepterVariables: true })).toEqual(mapping);
    expect(validateParamMapping([{ position: 1, source: { type: 'variable', key: 'a b' } }], { accepterVariables: true })).toBeNull();
    expect(validateParamMapping([{ position: 1, source: { type: 'variable', key: '' } }], { accepterVariables: true })).toBeNull();
    expect(validateParamMapping([{ position: 1, source: { type: 'variable', key: 'x'.repeat(65) } }], { accepterVariables: true })).toBeNull();
  });

  it('🔴 un indice de template (posé dans la console) ne peut pas être une variable', () => {
    expect(parseParamHints([{ position: 1, source: { type: 'variable', key: 'commande' } }])).toBeNull();
  });

  it('résout la variable du destinataire', () => {
    const p = validateParamMapping(mapping, { accepterVariables: true })!;
    expect(resolveTemplateParams(p, {}, { variables: { commande: '8412' } })).toEqual({ values: ['8412'], missing: [] });
  });

  it('absente et sans repli : position manquante, donc destinataire écarté en amont', () => {
    const p = validateParamMapping(mapping, { accepterVariables: true })!;
    expect(resolveTemplateParams(p, {}, { variables: {} })).toEqual({ values: [''], missing: [1] });
    expect(resolveTemplateParams(p, {})).toEqual({ values: [''], missing: [1] });
  });

  it('absente AVEC repli : le repli part', () => {
    const p = validateParamMapping([{ position: 1, source: { type: 'variable', key: 'commande' }, fallback: 'votre commande' }], { accepterVariables: true })!;
    expect(resolveTemplateParams(p, {}, { variables: {} })).toEqual({ values: ['votre commande'], missing: [] });
  });

  it('🔴 un nom hérité du prototype n’est pas une variable', () => {
    const p = validateParamMapping([{ position: 1, source: { type: 'variable', key: 'constructor' } }], { accepterVariables: true })!;
    expect(resolveTemplateParams(p, {}, { variables: {} })).toEqual({ values: [''], missing: [1] });
  });

  it('ne lit JAMAIS la fiche : un champ du même nom ne remplace pas la variable absente', () => {
    const p = validateParamMapping(mapping, { accepterVariables: true })!;
    expect(resolveTemplateParams(p, { fields: { commande: 'depuis la fiche' } }, { variables: {} }).missing).toEqual([1]);
  });
});
