import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgEmbeddedSignupStore, TenantConflictError, SecondNumeroRefuseError } from '../src/account/es-store.pg';
import { PgUserStore } from '../src/user/store.pg';
import { NOTE_CREDIT_OFFERT } from '../src/agent/credits.pg';
import { SANS_CREDIT_OFFERT } from './credit-offert';

/**
 * LES 5 € OFFERTS À LA CONNEXION DU PREMIER NUMÉRO WHATSAPP (décision de Julien du 2026-09-29).
 *
 * 🔴 CE QUI COMPTE ICI EST L'ENDROIT ET L'ORDRE DES ÉCRITURES. L'offre s'insère DANS la transaction qui relie le
 * numéro, APRÈS les deux gardes de la liaison, et le crédit ne s'écrit que si l'insertion de l'offre a pris. Les
 * bornes elles-mêmes (une offre par espace, jamais deux pour un numéro) sont des contraintes de la migration 0191 :
 * leur vérité en base est tenue par `tests/integration/agent-credits.integration.test.ts`, joué en CI. Ici, la base
 * est simulée et dit ce que la contrainte aurait dit (`offrePrend`).
 */
function fausseBase(o: { offrePrend?: boolean; numeroDejaAilleurs?: boolean; secondNumero?: boolean } = {}) {
  const surLePool: string[] = [];
  const surLaConnexion: Array<{ sql: string; params: unknown[] }> = [];
  const repondre = (sql: string) => {
    if (/insert into waba/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/select id from phone_numbers/i.test(sql)) return { rows: o.secondNumero ? [{ id: 'pn-deja' }] : [], rowCount: o.secondNumero ? 1 : 0 };
    // L'upsert gardé du numéro : 0 ligne quand il appartient à un autre espace.
    if (/insert into phone_numbers/i.test(sql)) return { rows: [], rowCount: o.numeroDejaAilleurs ? 0 : 1 };
    // La contrainte de `credits_offerts` : l'insertion prend, ou le conflit l'annule en silence.
    if (/insert into credits_offerts/i.test(sql)) return { rows: [], rowCount: o.offrePrend === false ? 0 : 1 };
    if (/returning/i.test(sql)) return { rows: [{ id: 'x', solde_micro_eur: '5000000' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const pool = {
    query: async (sql: string) => { surLePool.push(sql); return repondre(sql); },
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => { surLaConnexion.push({ sql, params: params ?? [] }); return repondre(sql); },
      release: () => {},
    }),
  } as unknown as Pool;
  return { pool, surLePool, surLaConnexion };
}

const LIAISON = { tenantId: 't1', wabaId: 'waba-1', phoneNumberId: 'pn-1', displayPhoneNumber: '+33600000000', verifiedName: 'Démo' };
const CINQ_EUROS = { creditOffertMicroEur: 5_000_000 };
const indexDe = (b: ReturnType<typeof fausseBase>, re: RegExp) => b.surLaConnexion.findIndex((q) => re.test(q.sql));
const premiersMots = (b: ReturnType<typeof fausseBase>) => b.surLaConnexion.map((q) => q.sql.trim().split(/\s+/)[0]!.toLowerCase());

describe('le crédit offert à la connexion du premier numéro', () => {
  it('🔴 premier numéro : l’offre, PUIS le crédit et sa ligne `offert`, dans la transaction de la liaison', async () => {
    const b = fausseBase();
    const r = await new PgEmbeddedSignupStore(b.pool, CINQ_EUROS).linkTenant(LIAISON);
    expect(r).toEqual({ creditOffertMicroEur: 5_000_000 });

    const numero = indexDe(b, /insert into phone_numbers/i);
    const offre = indexDe(b, /insert into credits_offerts/i);
    const credit = indexDe(b, /insert into agent_credit_mouvements/i);
    // Après les gardes de la liaison, l'offre avant le crédit, et tout entre `begin` et `commit`.
    expect(numero).toBeGreaterThan(-1);
    expect(offre).toBeGreaterThan(numero);
    expect(credit).toBeGreaterThan(offre);
    expect(premiersMots(b).indexOf('begin')).toBeLessThan(numero);
    expect(premiersMots(b).indexOf('commit')).toBeGreaterThan(credit);
    // Rien sur le pool à côté : une écriture hors de la transaction survivrait à une liaison annulée.
    expect(b.surLePool).toEqual([]);
    // L'offre nomme l'espace ET le numéro, ce sont ses deux bornes.
    expect(b.surLaConnexion[offre]!.params).toEqual(['t1', 'pn-1', 5_000_000]);
    // (espace, montant, raison, session, note) : positif, `offert`, sans session.
    expect(b.surLaConnexion[credit]!.params).toEqual(['t1', 5_000_000, 'offert', null, NOTE_CREDIT_OFFERT]);
  });

  it('🔴 second numéro du même espace, ou même numéro sur un autre espace : l’offre ne prend pas, RIEN n’est crédité', async () => {
    // Les deux cas sont le même geste pour le code : la contrainte (clé primaire ou unique) annule l'insertion.
    const b = fausseBase({ offrePrend: false });
    const r = await new PgEmbeddedSignupStore(b.pool, CINQ_EUROS).linkTenant(LIAISON);
    expect(r).toEqual({ creditOffertMicroEur: 0 });
    expect(indexDe(b, /insert into credits_offerts/i)).toBeGreaterThan(-1);
    expect(b.surLaConnexion.filter((q) => /agent_credit/i.test(q.sql))).toEqual([]);
    // La liaison, elle, est faite.
    expect(premiersMots(b)).toContain('commit');
  });

  it('🔴 échec de la liaison (numéro d’un autre espace) : ni offre ni crédit, et tout est annulé', async () => {
    const b = fausseBase({ numeroDejaAilleurs: true });
    await expect(new PgEmbeddedSignupStore(b.pool, CINQ_EUROS).linkTenant(LIAISON)).rejects.toBeInstanceOf(TenantConflictError);
    expect(b.surLaConnexion.filter((q) => /credits_offerts|agent_credit/i.test(q.sql))).toEqual([]);
    expect(premiersMots(b)).toContain('rollback');
    expect(premiersMots(b)).not.toContain('commit');
  });

  it('échec de la liaison (second numéro refusé) : ni offre ni crédit', async () => {
    const b = fausseBase({ secondNumero: true });
    await expect(new PgEmbeddedSignupStore(b.pool, CINQ_EUROS).linkTenant(LIAISON)).rejects.toBeInstanceOf(SecondNumeroRefuseError);
    expect(b.surLaConnexion.filter((q) => /credits_offerts|agent_credit/i.test(q.sql))).toEqual([]);
  });

  it('à 0, rien n’est marqué ni crédité : l’offre reste due le jour où on la rallume', async () => {
    const b = fausseBase();
    const r = await new PgEmbeddedSignupStore(b.pool, SANS_CREDIT_OFFERT).linkTenant(LIAISON);
    expect(r).toEqual({ creditOffertMicroEur: 0 });
    expect(b.surLaConnexion.filter((q) => /credits_offerts|agent_credit/i.test(q.sql))).toEqual([]);
  });

  it('🔴 la création d’un espace n’offre PLUS rien : l’offre y était récoltable par script', async () => {
    // Le sens inverse du premier cas : si l'ancienne écriture revenait dans `createTenantWithAdmin`, chaque
    // inscription redonnerait 5 € sans preuve, et ce test tomberait.
    const b = fausseBase();
    const pool = {
      ...b.pool,
      query: async (sql: string) => {
        b.surLePool.push(sql);
        if (/select public_code/i.test(sql)) return { rows: [{ public_code: 'k7m2p3' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          b.surLaConnexion.push({ sql, params: params ?? [] });
          if (/from identities/i.test(sql)) return { rows: [{ id: 'ident-1' }], rowCount: 1 };
          if (/insert into tenants/i.test(sql)) return { rows: [{ id: 'tenant-neuf' }], rowCount: 1 };
          if (/returning/i.test(sql)) return { rows: [{ id: 'u1' }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
        release: () => {},
      }),
    } as unknown as Pool;
    await new PgUserStore(pool).createTenantWithAdmin('Espace', { email: 'a@b.fr', name: null, passwordHash: null });
    expect(b.surLaConnexion.some((q) => /insert into tenants/i.test(q.sql))).toBe(true);
    expect([...b.surLePool, ...b.surLaConnexion.map((q) => q.sql)].filter((s) => /agent_credit|credits_offerts/i.test(s))).toEqual([]);
  });
});
