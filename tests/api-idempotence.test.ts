import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { cleIdempotence, empreinteCorps, CLE_IDEMPOTENCE_MAX, DUREE_CLE_IDEMPOTENCE_MS } from '../src/api/idempotence';
import { PgApiIdempotencyStore, verdictLigne } from '../src/api/idempotency-store.pg';

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

describe('la durée de vie d’une clé : UNE constante, et la purge ne descend jamais dessous', () => {
  /** Un faux pool qui note les paramètres de chaque requête : c'est la durée qui part en base qu'on juge. */
  function poolEspion() {
    const appels: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => { appels.push({ sql, params }); return { rows: [], rowCount: 1 }; },
    } as unknown as Pool;
    return { pool, appels };
  }

  it('24 h, écrites une seule fois', () => {
    expect(DUREE_CLE_IDEMPOTENCE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('🔴 le claim libère une clé expirée à CETTE durée, pas à un littéral recopié', async () => {
    const { pool, appels } = poolEspion();
    await new PgApiIdempotencyStore(pool).claim('t1', 'k1', 'h1');
    expect(appels[0]!.sql).toMatch(/delete from api_idempotency/);
    expect(appels[0]!.params).toContain(DUREE_CLE_IDEMPOTENCE_MS);
  });

  it('🔴 la purge ne descend JAMAIS sous la durée du claim, quelle que soit la fenêtre demandée', async () => {
    // Une purge plus courte que la vie d'une clé la rendrait libre trop tôt : un rejeu légitime recréerait
    // l'envoi, donc enverrait deux fois.
    for (const demande of [0, 60_000, DUREE_CLE_IDEMPOTENCE_MS - 1]) {
      const { pool, appels } = poolEspion();
      await new PgApiIdempotencyStore(pool).sweepOlderThan(demande);
      expect(appels[0]!.params, `fenêtre demandée ${demande}`).toEqual([DUREE_CLE_IDEMPOTENCE_MS]);
    }
    // Plus longue, elle reste la sienne : garder une clé plus longtemps ne fait jamais envoyer deux fois.
    const { pool, appels } = poolEspion();
    await new PgApiIdempotencyStore(pool).sweepOlderThan(DUREE_CLE_IDEMPOTENCE_MS * 2);
    expect(appels[0]!.params).toEqual([DUREE_CLE_IDEMPOTENCE_MS * 2]);
  });

  it('le worker purge avec la constante, et la route l’annonce en heures', () => {
    const sansCommentaires = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(sansCommentaires('../src/worker.ts')).toMatch(/idempotencyStore\.sweepOlderThan\(DUREE_CLE_IDEMPOTENCE_MS\)/);
    expect(sansCommentaires('../src/http/v1-sends.ts')).toMatch(/DUREE_CLE_IDEMPOTENCE_MS \/ 3_600_000/);
  });
});
