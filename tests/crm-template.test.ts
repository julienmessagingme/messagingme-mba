import { describe, it, expect } from 'vitest';
import { resolveTemplateParams, countTemplateVariables } from '../src/crm/template';
import type { TemplateParam } from '../src/crm/template';

const contact = {
  phone_e164: '+33612345678',
  profile_name: 'Julie',
  fields: { ville: 'Lyon' },
};

describe('resolveTemplateParams', () => {
  it('résout field / attribute / literal, dans l ordre des positions', () => {
    const params: TemplateParam[] = [
      { position: 2, source: { type: 'field', key: 'ville' } },
      { position: 1, source: { type: 'attribute', key: 'name' } },
      { position: 3, source: { type: 'literal', value: 'PROMO10' } },
    ];
    expect(resolveTemplateParams(params, contact)).toEqual({ values: ['Julie', 'Lyon', 'PROMO10'], missing: [] });
  });

  it('valeur manquante -> fallback (défaut design explicite = rempli, pas manquant)', () => {
    const params: TemplateParam[] = [
      { position: 1, source: { type: 'field', key: 'inexistant' }, fallback: 'cher client' },
    ];
    expect(resolveTemplateParams(params, contact)).toEqual({ values: ['cher client'], missing: [] });
  });

  it('valeur manquante sans fallback -> position MANQUANTE (jamais un envoi vide)', () => {
    const params: TemplateParam[] = [{ position: 1, source: { type: 'field', key: 'inexistant' } }];
    expect(resolveTemplateParams(params, contact)).toEqual({ values: [''], missing: [1] });
  });

  it('attribute phone', () => {
    const params: TemplateParam[] = [{ position: 1, source: { type: 'attribute', key: 'phone' } }];
    expect(resolveTemplateParams(params, contact)).toEqual({ values: ['+33612345678'], missing: [] });
  });

  it('attribute wa_id (chiffres du numéro sans « + ») et bsuid', () => {
    // wa_id depuis un numéro = chiffres nus.
    expect(resolveTemplateParams([{ position: 1, source: { type: 'attribute', key: 'wa_id' } }], contact))
      .toEqual({ values: ['33612345678'], missing: [] });
    // Contact SANS numéro (BSUID seul) : bsuid résolu, et wa_id retombe sur le bsuid.
    const bsuidOnly = { phone_e164: null, bsuid: 'BSU_ab12', profile_name: 'X', fields: {} };
    expect(resolveTemplateParams(
      [
        { position: 1, source: { type: 'attribute', key: 'bsuid' } },
        { position: 2, source: { type: 'attribute', key: 'wa_id' } },
      ],
      bsuidOnly,
    )).toEqual({ values: ['BSU_ab12', 'BSU_ab12'], missing: [] });
  });

  it('0 et false ne sont pas écrasés en chaîne vide', () => {
    const c = { fields: { n: 0, b: false } };
    const params: TemplateParam[] = [
      { position: 1, source: { type: 'field', key: 'n' } },
      { position: 2, source: { type: 'field', key: 'b' } },
    ];
    expect(resolveTemplateParams(params, c)).toEqual({ values: ['0', 'false'], missing: [] });
  });

  it('positions non contiguës ou dupliquées -> throw (désalignement évité)', () => {
    expect(() =>
      resolveTemplateParams(
        [
          { position: 1, source: { type: 'literal', value: 'A' } },
          { position: 3, source: { type: 'literal', value: 'C' } },
        ],
        contact,
      ),
    ).toThrow(/positions de template invalides/);
    expect(() =>
      resolveTemplateParams(
        [
          { position: 1, source: { type: 'literal', value: 'A' } },
          { position: 1, source: { type: 'literal', value: 'B' } },
        ],
        contact,
      ),
    ).toThrow(/positions de template invalides/);
  });
});

describe('countTemplateVariables', () => {
  it('MAX des positions (corps non contigu compté correctement -> évite 132000)', () => {
    expect(countTemplateVariables('Bonjour {{1}}, code {{3}}')).toBe(3); // pas 2 (nb de {{n}} distincts)
    expect(countTemplateVariables('{{1}} {{2}} {{3}}')).toBe(3);
    expect(countTemplateVariables('Aucune variable ici')).toBe(0);
    expect(countTemplateVariables('{{ 2 }} avec espaces')).toBe(2);
  });
});
