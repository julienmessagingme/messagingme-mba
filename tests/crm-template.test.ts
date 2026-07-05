import { describe, it, expect } from 'vitest';
import { resolveTemplateParams } from '../src/crm/template';
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
    expect(resolveTemplateParams(params, contact)).toEqual(['Julie', 'Lyon', 'PROMO10']);
  });

  it('valeur manquante -> fallback', () => {
    const params: TemplateParam[] = [
      { position: 1, source: { type: 'field', key: 'inexistant' }, fallback: 'cher client' },
    ];
    expect(resolveTemplateParams(params, contact)).toEqual(['cher client']);
  });

  it('valeur manquante sans fallback -> chaîne vide', () => {
    const params: TemplateParam[] = [{ position: 1, source: { type: 'field', key: 'inexistant' } }];
    expect(resolveTemplateParams(params, contact)).toEqual(['']);
  });

  it('attribute phone', () => {
    const params: TemplateParam[] = [{ position: 1, source: { type: 'attribute', key: 'phone' } }];
    expect(resolveTemplateParams(params, contact)).toEqual(['+33612345678']);
  });

  it('0 et false ne sont pas écrasés en chaîne vide', () => {
    const c = { fields: { n: 0, b: false } };
    const params: TemplateParam[] = [
      { position: 1, source: { type: 'field', key: 'n' } },
      { position: 2, source: { type: 'field', key: 'b' } },
    ];
    expect(resolveTemplateParams(params, c)).toEqual(['0', 'false']);
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
