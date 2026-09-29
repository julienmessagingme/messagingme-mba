import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgStripeStore, type PaiementStripe } from '../src/stripe/store.pg';

/**
 * LE CRÉDIT D'UN PAIEMENT STRIPE, UNE FOIS : l'ordre des écritures dans la transaction du webhook.
 *
 * 🔴 La ligne de paiement D'ABORD (sa clé primaire sur la session est l'idempotence), le crédit ENSUITE, et seulement
 * si la ligne a pris. Ici la base est simulée et dit ce que la contrainte aurait dit ; la vérité en base (deux
 * livraisons, dix livraisons simultanées) est tenue par `tests/integration/stripe.integration.test.ts`, joué en CI.
 */
function fausseBase(o: { dejaCredite?: boolean; erreur?: { code: string } } = {}) {
  const surLaConnexion: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        surLaConnexion.push({ sql, params: params ?? [] });
        if (/insert into stripe_paiements/i.test(sql)) {
          if (o.erreur) throw Object.assign(new Error('violation'), o.erreur);
          return { rows: [], rowCount: o.dejaCredite ? 0 : 1 };
        }
        if (/returning/i.test(sql)) return { rows: [{ solde_micro_eur: '50000000' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  return { pool, surLaConnexion };
}

const P: PaiementStripe = {
  sessionId: 'cs_1', tenantId: '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01', offre: 'refill_50', creditMicroEur: 50_000_000,
  htCentimes: 5_000, ttcCentimes: 6_000, factureId: 'in_1', livemode: true,
};
const premiers = (b: ReturnType<typeof fausseBase>) => b.surLaConnexion.map((q) => q.sql.trim().split(/\s+/)[0]!.toLowerCase());

describe('PgStripeStore.crediterPaiement', () => {
  it('🔴 la ligne de paiement, PUIS le crédit et son mouvement `achat`, dans une transaction', async () => {
    const b = fausseBase();
    expect(await new PgStripeStore(b.pool).crediterPaiement(P)).toBe('credite');
    const paiement = b.surLaConnexion.findIndex((q) => /insert into stripe_paiements/i.test(q.sql));
    const credit = b.surLaConnexion.findIndex((q) => /insert into agent_credit_mouvements/i.test(q.sql));
    expect(paiement).toBeGreaterThan(-1);
    expect(credit).toBeGreaterThan(paiement);
    expect(premiers(b).indexOf('begin')).toBeLessThan(paiement);
    expect(premiers(b).indexOf('commit')).toBeGreaterThan(credit);
    expect(b.surLaConnexion[credit]!.params.slice(0, 3)).toEqual([P.tenantId, 50_000_000, 'achat']);
    // 🔴 Le mouvement porte SA session Stripe (migration 0193) : c'est le lien que suit le lien « Facture ».
    expect(b.surLaConnexion[credit]!.sql).toContain('stripe_session_id');
    expect(b.surLaConnexion[credit]!.params[5]).toBe('cs_1');
  });

  it('🔴 une session DÉJÀ créditée n’écrit aucun crédit', async () => {
    const b = fausseBase({ dejaCredite: true });
    expect(await new PgStripeStore(b.pool).crediterPaiement(P)).toBe('deja');
    expect(b.surLaConnexion.filter((q) => /agent_credit/i.test(q.sql))).toEqual([]);
  });

  it('un espace qui n’existe pas (23503) rend `espace_inconnu`, pas une panne', async () => {
    const b = fausseBase({ erreur: { code: '23503' } });
    expect(await new PgStripeStore(b.pool).crediterPaiement(P)).toBe('espace_inconnu');
    expect(premiers(b)).toContain('rollback');
  });

  it('🔴 la facture d’un paiement se lit DANS L’ESPACE : `tenant_id = $1`', async () => {
    const vues: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        vues.push({ sql, params });
        return params[0] === P.tenantId && params[1] === 'cs_1' ? { rows: [{ facture_id: 'in_1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const s = new PgStripeStore(pool);
    expect(await s.factureDe(P.tenantId, 'cs_1')).toEqual({ factureId: 'in_1' });
    expect(await s.factureDe('11111111-1111-4111-8111-111111111111', 'cs_1')).toBeNull();
    expect(vues[0]!.sql).toMatch(/where tenant_id = \$1 and session_id = \$2/);
  });

  it('toute autre erreur REMONTE : le webhook rendra 5xx et Stripe rejouera', async () => {
    const b = fausseBase({ erreur: { code: '57P01' } });
    await expect(new PgStripeStore(b.pool).crediterPaiement(P)).rejects.toThrow('violation');
  });
});
