import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { enTransaction } from '../../src/db/transaction';
import { offrirAuCompteApplication } from '../../src/agent/credits.pg';
import { PgComptesApplication } from '../../src/application/comptes.pg';

/**
 * LE CRÉDIT OFFERT À UN COMPTE DE L'APPLICATION RELIÉ (plan 2026-10-22, tâche 6), sur une vraie base : les bornes de
 * `credits_offerts`, et le numéro affiché lu dans le `jid` que WhatsApp a donné, jamais dans le numéro déclaré.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const MONTANT = 1_000_000;

describe.skipIf(!url)('le crédit offert à un compte de l’application', () => {
  let pool: Pool;
  let comptes: PgComptesApplication;
  const espaces: string[] = [];

  const espaceRelie = async (numeroDeclare: string, jid: string | null): Promise<string> => {
    const t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credit-application') returning id`)).rows[0]!.id;
    espaces.push(t);
    const p = await comptes.preparer(t, { numero: numeroDeclare, fourniId: null });
    if (!p.ok) throw new Error(`préparation refusée : ${p.raison}`);
    await comptes.marquer(p.compte.id, 'relie', jid ? { jid } : {});
    return t;
  };
  const offrir = (t: string) => enTransaction(pool, (c) => offrirAuCompteApplication(c, t, MONTANT));
  const solde = async (t: string) => Number((await pool.query<{ s: string }>('select solde_micro_eur::text as s from agent_credits where tenant_id = $1', [t])).rows[0]?.s ?? 0);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    comptes = new PgComptesApplication(pool);
  });

  afterAll(async () => {
    await pool.query('delete from credits_offerts where tenant_id = any($1::uuid[])', [espaces]);
    await pool.query('delete from tenants where id = any($1::uuid[])', [espaces]);
    await pool.end();
  });

  it('🔴 une fois par espace : la seconde offre ne crédite rien', async () => {
    const t = await espaceRelie('449990000901', '449990000901:12@s.whatsapp.net');
    expect(await offrir(t)).toBe(MONTANT);
    expect(await offrir(t)).toBe(0);
    expect(await solde(t)).toBe(MONTANT);
  });

  it('🔴 jamais deux fois pour le même téléphone, même sous un autre numéro déclaré', async () => {
    await espaceRelie('449990000902', '449990000903:3@s.whatsapp.net').then(offrir);
    const autre = await espaceRelie('449990000904', '449990000903:7@s.whatsapp.net');
    expect(await offrir(autre)).toBe(0);
  });

  it('un compte sans identité WhatsApp connue n’offre rien, et l’offre reste due', async () => {
    const t = await espaceRelie('449990000905', null);
    expect(await offrir(t)).toBe(0);
    expect((await pool.query('select 1 from credits_offerts where tenant_id = $1', [t])).rowCount).toBe(0);
  });
});
