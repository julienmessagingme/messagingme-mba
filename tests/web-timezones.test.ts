import { describe, it, expect } from 'vitest';
import { TIMEZONES, DEFAULT_TIMEZONE, timezoneLabel, isKnownTimezone } from '../web/lib/timezones';

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
    expect(isKnownTimezone(DEFAULT_TIMEZONE)).toBe(true);
    expect(isKnownTimezone('Mars/Olympus')).toBe(false);
  });
  it('timezoneLabel = « (GMT+x) Ville »', () => {
    const paris = TIMEZONES.find((o) => o.iana === 'Europe/Paris')!;
    expect(timezoneLabel(paris)).toBe('(GMT+1) Paris');
  });
});
