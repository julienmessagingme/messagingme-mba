import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgUserStore } from '../src/user/store.pg';
import { NOTE_CREDIT_OFFERT } from '../src/agent/credits.pg';
import { SANS_CREDIT_OFFERT } from './credit-offert';

/**
 * LES 5 € OFFERTS À L'OUVERTURE (2026-09-28, décision de Julien).
 *
 * 🔴 Ce qui compte ici est l'ENDROIT de l'écriture : dans la transaction qui crée l'espace, sur sa connexion. Écrit
 * par le pool à côté, le crédit survivrait à une création annulée (de l'argent offert à un espace qui n'existe pas)
 * ou manquerait à un espace créé. La vérité en base (solde, ligne `offert`) est tenue par le test d'intégration
 * `tests/integration/agent-credits.integration.test.ts`, joué en CI.
 */
function fausseBase(o: { echecSur?: RegExp } = {}) {
  const surLePool: string[] = [];
  const surLaConnexion: Array<{ sql: string; params: unknown[] }> = [];
  const repondre = (sql: string) => {
    if (/select public_code/i.test(sql)) return { rows: [{ public_code: 'k7m2p3' }], rowCount: 1 };
    if (/from identities/i.test(sql)) return { rows: [{ id: 'ident-1' }], rowCount: 1 };
    if (/insert into tenants/i.test(sql)) return { rows: [{ id: 'tenant-neuf' }], rowCount: 1 };
    if (/returning/i.test(sql)) return { rows: [{ id: 'u1', solde_micro_eur: '5000000' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const pool = {
    query: async (sql: string) => { surLePool.push(sql); return repondre(sql); },
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        surLaConnexion.push({ sql, params: params ?? [] });
        if (o.echecSur?.test(sql)) throw new Error('base indisponible');
        return repondre(sql);
      },
      release: () => {},
    }),
  } as unknown as Pool;
  return { pool, surLePool, surLaConnexion };
}

const ADMIN = { email: 'a@b.fr', name: null, passwordHash: 'scrypt$x$y' };

describe('le crédit offert à la création d’un espace', () => {
  it('🔴 il s’écrit DANS la transaction de création, avec sa ligne `offert` et sa note', async () => {
    const b = fausseBase();
    await new PgUserStore(b.pool, { creditOffertMicroEur: 5_000_000 }).createTenantWithAdmin('Espace', ADMIN);

    const sqls = b.surLaConnexion.map((q) => q.sql.trim().split(/\s+/).slice(0, 3).join(' ').toLowerCase());
    const credit = b.surLaConnexion.findIndex((q) => /insert into agent_credit_mouvements/i.test(q.sql));
    expect(credit).toBeGreaterThan(-1);
    // Entre le `begin` et le `commit`, sur la MÊME connexion, et rien sur le pool à côté.
    expect(sqls.indexOf('begin')).toBeLessThan(credit);
    expect(sqls.indexOf('commit')).toBeGreaterThan(credit);
    expect(b.surLePool.filter((s) => /agent_credit/i.test(s))).toEqual([]);
    // (tenant, montant, raison, session, note) : positif, `offert`, sans session, avec sa phrase.
    expect(b.surLaConnexion[credit]!.params).toEqual(['tenant-neuf', 5_000_000, 'offert', null, NOTE_CREDIT_OFFERT]);
  });

  it('à 0, rien n’est écrit : ni solde, ni mouvement', async () => {
    const b = fausseBase();
    await new PgUserStore(b.pool, SANS_CREDIT_OFFERT).createTenantWithAdmin('Espace', ADMIN);
    expect(b.surLaConnexion.filter((q) => /agent_credit/i.test(q.sql))).toEqual([]);
  });

  it('🔴 un crédit qui ne s’écrit pas ANNULE la création : pas d’espace né sans son crédit', async () => {
    const b = fausseBase({ echecSur: /agent_credit/i });
    await expect(new PgUserStore(b.pool, { creditOffertMicroEur: 5_000_000 }).createTenantWithAdmin('Espace', ADMIN))
      .rejects.toThrow('base indisponible');
    const sqls = b.surLaConnexion.map((q) => q.sql.trim().toLowerCase());
    expect(sqls).toContain('rollback');
    expect(sqls).not.toContain('commit');
  });
});
