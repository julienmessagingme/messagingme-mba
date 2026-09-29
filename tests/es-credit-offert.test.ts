import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgEmbeddedSignupStore, TenantConflictError } from '../src/account/es-store.pg';
import { PgUserStore } from '../src/user/store.pg';
import { NOTE_CREDIT_OFFERT } from '../src/agent/credits.pg';
import { creerOffreDeBienvenue } from '../src/account/offre-bienvenue';
import { SANS_CREDIT_OFFERT } from './credit-offert';

/**
 * LES 5 € OFFERTS AU PREMIER NUMÉRO WHATSAPP VÉRIFIÉ PAR META (décision de Julien du 2026-09-29, relecture du même
 * jour).
 *
 * 🔴 CE QUI COMPTE ICI EST L'ENDROIT ET L'ORDRE DES ÉCRITURES. La liaison n'offre plus rien : elle tourne avant que la
 * route ne sache si Meta a vérifié le numéro. L'offre est un geste à part (`offrirCredit`), que la route appelle avec
 * cette preuve (`tests/embedded-signup.test.ts`, `tests/numero-activation.test.ts`). Dans sa transaction, l'offre
 * s'insère d'abord, et le crédit ne s'écrit que si elle a pris. Les bornes (une offre par espace, jamais deux pour un
 * numéro, par son identifiant ni par son numéro affiché) sont des contraintes des migrations 0191 et 0193 : leur
 * vérité en base est tenue par `tests/integration/agent-credits.integration.test.ts`, joué en CI. Ici, la base est
 * simulée et dit ce que la contrainte aurait dit (`offrePrend`).
 */
function fausseBase(o: { offrePrend?: boolean; numeroDejaAilleurs?: boolean } = {}) {
  const surLePool: string[] = [];
  const surLaConnexion: Array<{ sql: string; params: unknown[] }> = [];
  const repondre = (sql: string) => {
    if (/insert into waba/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/select id from phone_numbers/i.test(sql)) return { rows: [], rowCount: 0 };
    // L'upsert gardé du numéro : 0 ligne quand il appartient à un autre espace.
    if (/insert into phone_numbers/i.test(sql)) return { rows: [], rowCount: o.numeroDejaAilleurs ? 0 : 1 };
    // Les contraintes de `credits_offerts` : l'insertion prend, ou le conflit l'annule en silence.
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

describe('le crédit offert au premier numéro vérifié', () => {
  it('🔴 la LIAISON n’offre plus rien : ni offre ni crédit, même au premier numéro', async () => {
    // Le sens inverse de tout le lot : si l'offre revenait dans `linkTenant`, un numéro que Meta dit `NOT_VERIFIED`
    // recevrait de nouveau ses 5 €, puisque la route relie AVANT de savoir.
    const b = fausseBase();
    await new PgEmbeddedSignupStore(b.pool, CINQ_EUROS).linkTenant(LIAISON);
    expect(indexDe(b, /insert into phone_numbers/i)).toBeGreaterThan(-1);
    expect([...b.surLePool, ...b.surLaConnexion.map((q) => q.sql)].filter((s) => /credits_offerts|agent_credit/i.test(s))).toEqual([]);
  });

  it('🔴 l’offre, PUIS le crédit et sa ligne `offert`, dans une seule transaction', async () => {
    const b = fausseBase();
    expect(await new PgEmbeddedSignupStore(b.pool, CINQ_EUROS).offrirCredit('t1', 'pn-1')).toBe(5_000_000);

    const offre = indexDe(b, /insert into credits_offerts/i);
    const credit = indexDe(b, /insert into agent_credit_mouvements/i);
    expect(offre).toBeGreaterThan(-1);
    expect(credit).toBeGreaterThan(offre);
    expect(premiersMots(b).indexOf('begin')).toBeLessThan(offre);
    expect(premiersMots(b).indexOf('commit')).toBeGreaterThan(credit);
    // Rien sur le pool à côté : une écriture hors de la transaction survivrait à une offre annulée.
    expect(b.surLePool).toEqual([]);
    // L'offre nomme l'espace ET le numéro, et relit le numéro DANS cet espace, avec son numéro affiché.
    expect(b.surLaConnexion[offre]!.params).toEqual(['t1', 'pn-1', 5_000_000]);
    expect(b.surLaConnexion[offre]!.sql).toMatch(/from phone_numbers pn\s+where pn\.id = \$2 and pn\.tenant_id = \$1/);
    expect(b.surLaConnexion[offre]!.sql).toContain('numero_affiche');
    // (espace, montant, raison, session, note) : positif, `offert`, sans session.
    expect(b.surLaConnexion[credit]!.params).toEqual(['t1', 5_000_000, 'offert', null, NOTE_CREDIT_OFFERT, null]);
  });

  it('🔴 déjà servi (cet espace, ce numéro, ou ce numéro affiché ailleurs) : l’offre ne prend pas, RIEN n’est crédité', async () => {
    // Les trois cas sont le même geste pour le code : une contrainte annule l'insertion.
    const b = fausseBase({ offrePrend: false });
    expect(await new PgEmbeddedSignupStore(b.pool, CINQ_EUROS).offrirCredit('t1', 'pn-1')).toBe(0);
    expect(indexDe(b, /insert into credits_offerts/i)).toBeGreaterThan(-1);
    expect(b.surLaConnexion.filter((q) => /agent_credit/i.test(q.sql))).toEqual([]);
  });

  it('échec de la liaison (numéro d’un autre espace) : rien d’offert, et tout est annulé', async () => {
    const b = fausseBase({ numeroDejaAilleurs: true });
    await expect(new PgEmbeddedSignupStore(b.pool, CINQ_EUROS).linkTenant(LIAISON)).rejects.toBeInstanceOf(TenantConflictError);
    expect(b.surLaConnexion.filter((q) => /credits_offerts|agent_credit/i.test(q.sql))).toEqual([]);
    expect(premiersMots(b)).toContain('rollback');
  });

  it('à 0, rien n’est marqué ni crédité : l’offre reste due le jour où on la rallume', async () => {
    const b = fausseBase();
    expect(await new PgEmbeddedSignupStore(b.pool, SANS_CREDIT_OFFERT).offrirCredit('t1', 'pn-1')).toBe(0);
    expect(b.surLaConnexion.filter((q) => /credits_offerts|agent_credit/i.test(q.sql))).toEqual([]);
  });

  it('🔴 la création d’un espace n’offre PLUS rien : l’offre y était récoltable par script', async () => {
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

/**
 * LE CÂBLAGE DE L'OFFRE (`creerOffreDeBienvenue`, relecture du 2026-09-29) : la remontée du plafond de la clé de
 * modèle suit une offre qui a pris, SANS faire attendre la route d'inscription (Vercel peut prendre 30 s), et en
 * étant confiée aux travaux que l'arrêt du processus attend.
 */
describe('le crédit offert, puis le plafond de la clé', () => {
  function cablage(o: { offert: number; remonter?: ((t: string) => Promise<unknown>) | null }) {
    const suivis: Array<Promise<unknown>> = [];
    const remontes: string[] = [];
    const journal: string[] = [];
    const offrir = creerOffreDeBienvenue({
      offrir: async () => o.offert,
      remonterPlafond: o.remonter === undefined ? async (t) => { remontes.push(t); } : o.remonter,
      travaux: { suivre: <T>(p: Promise<T>): Promise<T> => { suivis.push(p); return p; } },
      journal: (msg) => { journal.push(msg); },
    });
    return { offrir, suivis, remontes, journal };
  }

  it('🔴 une offre qui a pris remonte le plafond de l’espace, confiée aux travaux de l’arrêt', async () => {
    const c = cablage({ offert: 5_000_000 });
    await c.offrir('t1', 'pn-1');
    expect(c.suivis).toHaveLength(1);
    await Promise.all(c.suivis);
    expect(c.remontes).toEqual(['t1']);
  });

  it('🔴 la route n’attend PAS la remontée : Vercel qui ne répond jamais ne retient pas l’inscription', async () => {
    const c = cablage({ offert: 5_000_000, remonter: () => new Promise(() => {}) });
    const course = await Promise.race([c.offrir('t1', 'pn-1').then(() => 'rendu'), new Promise((r) => { setTimeout(() => r('bloque'), 50); })]);
    expect(course).toBe('rendu');
    expect(c.suivis).toHaveLength(1);
  });

  it('aucune offre (déjà servie, éteinte) : rien ne part chez Vercel', async () => {
    const c = cablage({ offert: 0 });
    await c.offrir('t1', 'pn-1');
    expect(c.suivis).toEqual([]);
    expect(c.remontes).toEqual([]);
  });

  it('provisionnement éteint : l’offre s’écrit, aucun plafond à suivre', async () => {
    const c = cablage({ offert: 5_000_000, remonter: null });
    await c.offrir('t1', 'pn-1');
    expect(c.suivis).toEqual([]);
  });

  it('une remontée qui échoue se journalise, sans lever', async () => {
    const c = cablage({ offert: 5_000_000, remonter: async () => { throw new Error('vercel'); } });
    await c.offrir('t1', 'pn-1');
    await Promise.allSettled(c.suivis);
    await new Promise((r) => { setTimeout(r, 0); });
    expect(c.journal).toHaveLength(1);
  });
});
