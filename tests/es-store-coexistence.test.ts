import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgEmbeddedSignupStore } from '../src/account/es-store.pg';

/**
 * LE RATTACHEMENT ÉCRIT LA COEXISTENCE (plan `docs/superpowers/plans/2026-10-24-coexistence.md`, tâche 2, migration 0253) :
 * à l'insertion du numéro ET quand il existe déjà (un espace relié par QR code passe en coexistence sur le même numéro,
 * un numéro rattaché de nouveau par la fenêtre ordinaire en sort). La base est simulée : l'écriture réelle est celle de
 * `tests/integration`, jouée en CI.
 */
function fausseBase() {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  const repondre = (sql: string) => {
    if (/select id from phone_numbers/i.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  };
  const pool = {
    query: async (sql: string, params?: unknown[]) => { requetes.push({ sql, params: params ?? [] }); return repondre(sql); },
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => { requetes.push({ sql, params: params ?? [] }); return repondre(sql); },
      release: () => {},
    }),
  } as unknown as Pool;
  return { pool, requetes };
}

const LIAISON = { tenantId: 't1', wabaId: 'waba-1', phoneNumberId: 'pn-1', displayPhoneNumber: '+441555479304', verifiedName: 'Maison' };

describe('linkTenant et la coexistence', () => {
  it('🔴 la colonne est écrite à l’insertion et remplacée sur un numéro déjà là, avec la valeur reçue', async () => {
    for (const coexistence of [true, false]) {
      const b = fausseBase();
      await new PgEmbeddedSignupStore(b.pool, { creditOffertMicroEur: 0, creditOffertBusinessMicroEur: 0 }).linkTenant({ ...LIAISON, coexistence });
      const numero = b.requetes.find((q) => /insert into phone_numbers/i.test(q.sql))!;
      const sql = numero.sql.replace(/\s+/g, ' ');
      expect(sql).toContain('insert into phone_numbers (id, waba_id, tenant_id, display_phone_number, verified_name, coexistence)');
      expect(sql).toContain('values ($1, $2, $3, $4, $5, $6)');
      expect(sql).toContain('coexistence = excluded.coexistence');
      // La garde entre espaces ne bouge pas : un numéro d'un autre espace ne se réécrit pas, coexistence comprise.
      expect(sql).toMatch(/where phone_numbers\.tenant_id = excluded\.tenant_id$/);
      expect(numero.params).toEqual(['pn-1', 'waba-1', 't1', '+441555479304', 'Maison', coexistence]);
    }
  });
});
