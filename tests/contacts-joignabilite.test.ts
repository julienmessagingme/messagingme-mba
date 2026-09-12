import { describe, expect, it } from 'vitest';
import { PEREMPTION_WHATSAPP_MS, verdictWhatsApp } from '../src/contacts/joignabilite';

const MAINTENANT = new Date('2026-09-12T10:00:00Z');
const ilYA = (jours: number) => new Date(MAINTENANT.getTime() - jours * 86_400_000);

describe('verdictWhatsApp', () => {
  // 🔴 LE CAS QUI COMPTE : un contact jamais sollicité n'est PAS injoignable.
  it('sans mesure, le verdict est inconnu et non non', () => {
    expect(verdictWhatsApp(null, null, MAINTENANT)).toBe('inconnu');
  });

  it('une mesure recente est lue', () => {
    expect(verdictWhatsApp(false, ilYA(89), MAINTENANT)).toBe('non');
    expect(verdictWhatsApp(true, ilYA(89), MAINTENANT)).toBe('oui');
  });

  // 🔴 SANS PÉREMPTION, on exclut quelqu'un pour toujours sur un constat vieux de deux ans.
  it('une mesure perimee redevient inconnue', () => {
    expect(verdictWhatsApp(false, ilYA(91), MAINTENANT)).toBe('inconnu');
    expect(verdictWhatsApp(true, ilYA(91), MAINTENANT)).toBe('inconnu');
  });

  it('une valeur sans date est inconnue : une mesure sans instant n est pas une mesure', () => {
    expect(verdictWhatsApp(false, null, MAINTENANT)).toBe('inconnu');
  });

  it('la peremption vaut 90 jours', () => {
    expect(PEREMPTION_WHATSAPP_MS).toBe(90 * 86_400_000);
  });
});
