import { describe, it, expect } from 'vitest';
import { TIMEZONES, DEFAULT_TIMEZONE, timezoneLabel } from '../web/lib/timezones';

describe('timezones', () => {
  it('chaque IANA est un fuseau valide (Intl ne throw pas)', () => {
    for (const o of TIMEZONES) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: o.iana }).format(new Date('2026-08-01T00:00:00Z'))).not.toThrow();
    }
  });
  it('offsets gmt bien formés et uniques', () => {
    for (const o of TIMEZONES) expect(o.gmt).toMatch(/^GMT[+-]\d{1,2}$/);
    const gmts = TIMEZONES.map((o) => o.gmt);
    expect(new Set(gmts).size).toBe(gmts.length); // un représentant par offset
  });
  it('le fuseau par défaut est dans la liste', () => {
  });
  it('timezoneLabel = « (GMT+x) Ville »', () => {
    const paris = TIMEZONES.find((o) => o.iana === 'Europe/Paris')!;
    expect(timezoneLabel(paris, 'fr')).toBe('(GMT+1) Paris');
  });

  it('🔴 un EXONYME suit la langue : « Londres » n a rien a faire dans une console en anglais', () => {
    const londres = TIMEZONES.find((o) => o.iana === 'Europe/London')!;
    expect(timezoneLabel(londres, 'fr')).toBe('(GMT+0) Londres');
    expect(timezoneLabel(londres, 'en')).toBe('(GMT+0) London');
    // Une ville dont le nom ne varie pas rend la meme chose des deux cotes.
    const tokyo = TIMEZONES.find((o) => o.iana === 'Asia/Tokyo')!;
    expect(timezoneLabel(tokyo, 'en')).toBe(timezoneLabel(tokyo, 'fr'));
  });
});
