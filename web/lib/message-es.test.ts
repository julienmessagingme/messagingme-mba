import { describe, it, expect } from 'vitest';
import { lireMessageEs, retenirMessageEs } from './message-es';

const FB = 'https://www.facebook.com';
const msg = (event: string, data: Record<string, unknown>) => JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data });

describe('lireMessageEs : ce que la fenêtre Meta annonce', () => {
  it('fin avec numéro : le compte, le numéro et l’événement', () => {
    expect(lireMessageEs(FB, msg('FINISH', { waba_id: 'w1', phone_number_id: 'p1' }))).toEqual({ wabaId: 'w1', phoneNumberId: 'p1', evenement: 'FINISH' });
  });

  it('🔴 fin SANS numéro (lot 3b) : le compte seul est gardé, avec l’événement', () => {
    expect(lireMessageEs(FB, msg('FINISH_ONLY_WABA', { waba_id: 'w1' }))).toEqual({ wabaId: 'w1', evenement: 'FINISH_ONLY_WABA' });
  });

  it('identifiants en nombre, et message déjà objet : lus quand même (Meta n’est pas constant)', () => {
    expect(lireMessageEs('https://business.facebook.com', { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: 12, phone_number_id: 34 } }))
      .toEqual({ wabaId: '12', phoneNumberId: '34', evenement: 'FINISH' });
  });

  it('🔴 origine qui n’est pas facebook.com (même finissant par lui) : ignoré', () => {
    expect(lireMessageEs('https://evilfacebook.com', msg('FINISH', { waba_id: 'w1', phone_number_id: 'p1' }))).toBeNull();
    expect(lireMessageEs('http://www.facebook.com', msg('FINISH', { waba_id: 'w1' }))).toBeNull();
  });

  it('autre type, JSON illisible, aucun compte : ignoré', () => {
    expect(lireMessageEs(FB, JSON.stringify({ type: 'AUTRE', data: { waba_id: 'w1' } }))).toBeNull();
    expect(lireMessageEs(FB, '{pas du json')).toBeNull();
    expect(lireMessageEs(FB, msg('CANCEL', { current_step: 'PHONE_NUMBER_SETUP' }))).toBeNull();
  });

  it('un événement hors de la forme attendue n’est pas transmis', () => {
    expect(lireMessageEs(FB, msg('finish<script>', { waba_id: 'w1' }))).toEqual({ wabaId: 'w1' });
  });
});

describe('retenirMessageEs : un message tardif n’efface pas ce qui est déjà capturé', () => {
  it('🔴 un compte seul n’écrase pas le couple compte et numéro du MÊME compte (le chemin avec numéro reste exact)', () => {
    const couple = { wabaId: 'w1', phoneNumberId: 'p1', evenement: 'FINISH' };
    expect(retenirMessageEs(couple, { wabaId: 'w1', evenement: 'FINISH_ONLY_WABA' })).toBe(couple);
  });

  it('sinon le dernier message l’emporte : rien avant, un autre compte, ou un couple qui arrive', () => {
    const seul = { wabaId: 'w1', evenement: 'FINISH_ONLY_WABA' };
    expect(retenirMessageEs(undefined, seul)).toBe(seul);
    const autre = { wabaId: 'w2' };
    expect(retenirMessageEs({ wabaId: 'w1', phoneNumberId: 'p1' }, autre)).toBe(autre);
    const couple = { wabaId: 'w1', phoneNumberId: 'p1' };
    expect(retenirMessageEs(seul, couple)).toBe(couple);
  });
});
