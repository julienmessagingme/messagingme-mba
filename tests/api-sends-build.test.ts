import { describe, it, expect } from 'vitest';
import { buildApiRecipients } from '../src/api/sends-build';
import type { BuildContact } from '../src/campaign/build';

const c = (over: Partial<BuildContact> & Pick<BuildContact, 'id'>): BuildContact => ({
  phone_e164: '+33611', bsuid: null, profile_name: null, fields: {}, optInStatus: 'opted_in', ...over,
});

describe('buildApiRecipients', () => {
  it('marketing : garde les opted_in, écarte les autres en not_opted_in', () => {
    const { eligible, skipped } = buildApiRecipients('marketing', [
      c({ id: 'a', phone_e164: '+33611', optInStatus: 'opted_in' }),
      c({ id: 'b', phone_e164: '+33622', optInStatus: 'unknown' }),
      c({ id: 'd', phone_e164: '+33633', optInStatus: 'opted_out' }),
    ]);
    expect(eligible.map((x) => x.id)).toEqual(['a']);
    expect(skipped).toEqual([
      { phone: '+33622', reason: 'not_opted_in' },
      { phone: '+33633', reason: 'not_opted_in' },
    ]);
  });

  it('utility : l’opt-in ne bloque pas (utility passe même en unknown)', () => {
    const { eligible, skipped } = buildApiRecipients('utility', [c({ id: 'a', optInStatus: 'unknown' })]);
    expect(eligible.map((x) => x.id)).toEqual(['a']);
    expect(skipped).toEqual([]);
  });

  it('dédup par identité (même numéro -> une fois, silencieux)', () => {
    const { eligible, skipped } = buildApiRecipients('utility', [
      c({ id: 'a', phone_e164: '+33611' }),
      c({ id: 'b', phone_e164: '+33611' }),
    ]);
    expect(eligible).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it('cible node : hors fenêtre 24h -> out_of_window', () => {
    const windowOpenById = new Map([['a', true], ['b', false]]);
    const { eligible, skipped } = buildApiRecipients('utility', [
      c({ id: 'a', phone_e164: '+33611' }),
      c({ id: 'b', phone_e164: '+33622' }),
    ], { windowOpenById });
    expect(eligible.map((x) => x.id)).toEqual(['a']);
    expect(skipped).toEqual([{ phone: '+33622', reason: 'out_of_window' }]);
  });
});
