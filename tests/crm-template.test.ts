import { describe, it, expect } from 'vitest';
import { resolveTemplateParams, countTemplateVariables, formatNow, validateParamMapping, refreshNowParams } from '../src/crm/template';
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

describe('source NOW (date du jour)', () => {
  it('formatNow -> JJ/MM/AAAA dans le fuseau (bascule de jour respectée)', () => {
    expect(formatNow(new Date('2026-08-02T12:00:00Z'), 'Europe/Paris')).toBe('02/08/2026');
    // 23:30 UTC le 2 août = déjà le 3 août à Paris (été UTC+2), mais encore le 2 à New York (UTC-4)
    expect(formatNow(new Date('2026-08-02T23:30:00Z'), 'Europe/Paris')).toBe('03/08/2026');
    expect(formatNow(new Date('2026-08-02T23:30:00Z'), 'America/New_York')).toBe('02/08/2026');
  });
  it('resolveTemplateParams résout NOW avec opts.now (fuseau tenant)', () => {
    const params: TemplateParam[] = [{ position: 1, source: { type: 'now' } }];
    expect(resolveTemplateParams(params, contact, { now: new Date('2026-08-02T12:00:00Z'), tz: 'Europe/Paris' })).toEqual({ values: ['02/08/2026'], missing: [] });
  });
  it('NOW SANS opts.now (chemin qui ne fournit pas now) -> position manquante, jamais un envoi faux', () => {
    const params: TemplateParam[] = [{ position: 1, source: { type: 'now' } }];
    expect(resolveTemplateParams(params, contact)).toEqual({ values: [''], missing: [1] });
  });
  it('validateParamMapping accepte une source now (corps HTTP)', () => {
    expect(validateParamMapping([{ position: 1, source: { type: 'now' } }])).toEqual([{ position: 1, source: { type: 'now' } }]);
  });
  it('refreshNowParams : rafraîchit les positions NOW à l’envoi, laisse les autres inchangées', () => {
    const mapping: TemplateParam[] = [
      { position: 1, source: { type: 'field', key: 'ville' } },
      { position: 2, source: { type: 'now' } },
    ];
    const resolved = ['Lyon', '02/08/2026']; // NOW figé au 2 août à la CRÉATION
    expect(refreshNowParams(resolved, mapping, { now: new Date('2026-08-05T12:00:00Z'), tz: 'Europe/Paris' })).toEqual(['Lyon', '05/08/2026']);
  });
  it('refreshNowParams : no-op sans source NOW, ou sans opts.now', () => {
    const noNow: TemplateParam[] = [{ position: 1, source: { type: 'field', key: 'ville' } }];
    expect(refreshNowParams(['Lyon'], noNow, { now: new Date('2026-08-05T12:00:00Z') })).toEqual(['Lyon']);
    const withNow: TemplateParam[] = [{ position: 1, source: { type: 'now' } }];
    expect(refreshNowParams(['02/08/2026'], withNow, {})).toEqual(['02/08/2026']); // pas de now fourni -> inchangé
  });
});
