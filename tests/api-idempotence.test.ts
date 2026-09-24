import { describe, it, expect } from 'vitest';
import { cleIdempotence, empreinteCorps, CLE_IDEMPOTENCE_MAX } from '../src/api/idempotence';
import { verdictLigne } from '../src/api/idempotency-store.pg';

/**
 * L'IDEMPOTENCE D'UN ENVOI PAR L'API (spec 2026-09-24, § 3 « Idempotence »).
 *
 * 🔴 LE CAS QUI JUSTIFIE CE FICHIER : la même clé avec un AUTRE corps rejouait en silence le rapport du
 * premier envoi. `verdictLigne` est la décision du magasin, testée ici sans base.
 */
describe('cleIdempotence', () => {
  it('en-tête seul', () => {
    expect(cleIdempotence('k1', {})).toEqual({ ok: true, cle: 'k1' });
  });

  it('corps seul : un outil qui appelle une adresse par contact remplit son corps, pas toujours ses en-têtes', () => {
    expect(cleIdempotence(undefined, { idempotencyKey: 'k2' })).toEqual({ ok: true, cle: 'k2' });
  });

  it('les deux, identiques aux espaces près : acceptée', () => {
    expect(cleIdempotence(' k3 ', { idempotencyKey: 'k3' })).toEqual({ ok: true, cle: 'k3' });
  });

  it('🔴 les deux, DIFFÉRENTES : invalid_body, jamais un choix silencieux', () => {
    expect(cleIdempotence('k4', { idempotencyKey: 'k5' })).toMatchObject({ ok: false, code: 'invalid_body' });
  });

  it('aucune, ou vide : idempotency_key_required', () => {
    expect(cleIdempotence(undefined, {})).toMatchObject({ ok: false, code: 'idempotency_key_required' });
    expect(cleIdempotence('   ', { idempotencyKey: '' })).toMatchObject({ ok: false, code: 'idempotency_key_required' });
    expect(cleIdempotence(undefined, null)).toMatchObject({ ok: false, code: 'idempotency_key_required' });
  });

  it('en-tête répété : la première valeur', () => {
    expect(cleIdempotence(['k6', 'k7'], {})).toEqual({ ok: true, cle: 'k6' });
  });

  it('une clé de corps qui n’est pas un texte, ou trop longue : invalid_body', () => {
    expect(cleIdempotence(undefined, { idempotencyKey: 42 })).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(cleIdempotence('x'.repeat(CLE_IDEMPOTENCE_MAX + 1), {})).toMatchObject({ ok: false, code: 'invalid_body' });
  });

  it('🔴 une clé de corps qui porte un caractère de contrôle : invalid_body, jamais un 500 de la base', () => {
    expect(cleIdempotence(undefined, { idempotencyKey: 'a\u0000b' })).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(cleIdempotence(undefined, { idempotencyKey: 'a\u007fb' })).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(cleIdempotence(undefined, { idempotencyKey: 'crm-7781-étape-2' })).toEqual({ ok: true, cle: 'crm-7781-étape-2' });
  });
});

describe('empreinteCorps', () => {
  it('l’ordre des clés d’objet ne compte pas', () => {
    expect(empreinteCorps({ a: 1, b: { c: 2, d: 3 } })).toBe(empreinteCorps({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('🔴 la clé d’idempotence n’entre PAS dans l’empreinte : en-tête ou corps, même demande', () => {
    expect(empreinteCorps({ a: 1, idempotencyKey: 'x' })).toBe(empreinteCorps({ a: 1 }));
  });

  it('l’ordre des destinataires COMPTE : c’est leur index que le rapport rend', () => {
    expect(empreinteCorps({ r: [1, 2] })).not.toBe(empreinteCorps({ r: [2, 1] }));
  });

  it('un autre destinataire, une autre empreinte', () => {
    expect(empreinteCorps({ r: [{ contactId: 'a' }] })).not.toBe(empreinteCorps({ r: [{ contactId: 'b' }] }));
  });

  it('un corps absent a une empreinte stable', () => {
    expect(empreinteCorps(undefined)).toBe(empreinteCorps(null));
  });
});

describe('verdictLigne : ce que vaut une clé déjà posée', () => {
  it('🔴 même clé, AUTRE empreinte : reused, que le calcul soit fini ou non', () => {
    expect(verdictLigne({ send_id: 's1', response: { a: 1 }, request_hash: 'h1' }, 'h2')).toEqual({ claimed: false, reused: true });
    expect(verdictLigne({ send_id: null, response: null, request_hash: 'h1' }, 'h2')).toEqual({ claimed: false, reused: true });
  });

  it('même empreinte : en cours pendant le calcul, rejeu du rapport après', () => {
    expect(verdictLigne({ send_id: null, response: null, request_hash: 'h1' }, 'h1')).toEqual({ claimed: false, pending: true });
    expect(verdictLigne({ send_id: 's1', response: { a: 1 }, request_hash: 'h1' }, 'h1')).toEqual({ claimed: false, sendId: 's1', response: { a: 1 } });
  });

  it('ligne d’avant la migration (empreinte nulle) : rejeu comme aujourd’hui', () => {
    expect(verdictLigne({ send_id: 's1', response: { a: 1 }, request_hash: null }, 'h9')).toEqual({ claimed: false, sendId: 's1', response: { a: 1 } });
  });

  it('ligne disparue entre l’insertion et la lecture : en cours, le client réessaie', () => {
    expect(verdictLigne(undefined, 'h1')).toEqual({ claimed: false, pending: true });
  });
});
