import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCleGatewayStore } from '../../src/agent/cles-gateway.pg';
import { PgCreditStore } from '../../src/agent/credits.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE PLAFOND DE LA CLÉ DE MODÈLE D'UN ESPACE, recalculé et sérialisé en base (relecture du 2026-09-29).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QU'AUCUN DOUBLE NE VOIT. La cible est un calcul SQL (le solde, plus tout ce qui
 * en a été débité depuis l'ouverture de la clé), et la sérialisation est un verrou de ligne tenu pendant l'appel à
 * Vercel. L'ancienne remontée ajoutait le montant de l'achat au plafond lu : deux remontées simultanées lisaient le
 * même plafond, et l'une des deux se perdait. Ici, la seconde attend la première, puis voit ce qu'elle a noté.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
describe.skipIf(!url)('le plafond de la clé de modèle (Postgres)', () => {
  let pool: Pool;
  let cles: PgCleGatewayStore;
  let credits: PgCreditStore;
  let t = '';
  const MICRO = 1_000_000;
  const cibleVue = async (): Promise<number> => {
    let vue = -1;
    await cles.ajusterPlafond(t, async (_cle, cible) => { vue = cible; return null; });
    return vue;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 8 });
    // Chiffrement identité : ce fichier ne teste pas le chiffrement, il teste le plafond.
    cles = new PgCleGatewayStore(pool, (s) => s, (s) => s);
    credits = new PgCreditStore(pool);
  });
  afterAll(async () => { if (t) await pool.query('delete from tenants where id = $1', [t]); await pool.end(); });
  beforeEach(async () => {
    if (t) await pool.query('delete from tenants where id = $1', [t]);
    t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-cle-plafond') returning id`)).rows[0]!.id;
  });

  it('un espace sans clé : rien à ajuster, et `poser` n’est jamais appelé', async () => {
    let appele = false;
    expect(await cles.ajusterPlafond(t, async () => { appele = true; return 1; })).toBe(false);
    expect(appele).toBe(false);
  });

  it('🔴 la cible est le cumul CRÉDITÉ depuis l’ouverture de la clé : les tours la laissent, un achat la monte', async () => {
    await credits.crediter(t, 10 * MICRO, 'itest');
    await cles.enregistrer(t, { cleId: 'key_itest', cle: 'vck_itest', plafondMicroEur: 10 * MICRO });
    await credits.debiter(t, 3 * MICRO);
    expect(await cibleVue()).toBe(10 * MICRO);
    await credits.debiterTraduction(t, 1 * MICRO);
    expect(await cibleVue()).toBe(10 * MICRO);
    await credits.crediter(t, 50 * MICRO, 'itest achat');
    expect(await cibleVue()).toBe(60 * MICRO);
  });

  it('🔴 un débit ANTÉRIEUR à l’ouverture de la clé ne gonfle pas la cible (il n’a pas été payé sur elle)', async () => {
    await credits.crediter(t, 10 * MICRO, 'itest');
    await pool.query(
      `insert into agent_credit_mouvements (tenant_id, delta_micro_eur, raison, at) values ($1, $2, 'conso', now() - interval '1 day')`,
      [t, -2 * MICRO],
    );
    await pool.query('update agent_credits set solde_micro_eur = solde_micro_eur - $2 where tenant_id = $1', [t, 2 * MICRO]);
    await cles.enregistrer(t, { cleId: 'key_itest', cle: 'vck_itest', plafondMicroEur: 8 * MICRO });
    expect(await cibleVue()).toBe(8 * MICRO);
  });

  it('ce que `poser` rend est noté ; `null` ne note rien ; une exception annule tout', async () => {
    await credits.crediter(t, 10 * MICRO, 'itest');
    await cles.enregistrer(t, { cleId: 'key_itest', cle: 'vck_itest', plafondMicroEur: 5 * MICRO });
    expect(await cles.ajusterPlafond(t, async () => null)).toBe(false);
    expect((await cles.lire(t))!.plafondMicroEur).toBe(5 * MICRO);
    await expect(cles.ajusterPlafond(t, async () => { throw new Error('vercel'); })).rejects.toThrow('vercel');
    expect((await cles.lire(t))!.plafondMicroEur).toBe(5 * MICRO);
    expect(await cles.ajusterPlafond(t, async (_c, cible) => cible)).toBe(true);
    expect((await cles.lire(t))!.plafondMicroEur).toBe(10 * MICRO);
  });

  it('🔴 deux ajustements SIMULTANÉS se sérialisent : le second attend, puis voit le plafond noté par le premier', async () => {
    await credits.crediter(t, 10 * MICRO, 'itest');
    await cles.enregistrer(t, { cleId: 'key_itest', cle: 'vck_itest', plafondMicroEur: 10 * MICRO });
    await credits.crediter(t, 50 * MICRO, 'itest achat 1');
    let liberer: () => void = () => {};
    const porte = new Promise<void>((r) => { liberer = r; });
    const ordre: string[] = [];
    const premier = cles.ajusterPlafond(t, async (_c, cible) => {
      ordre.push('premier:debut');
      await porte; // Vercel met du temps : le verrou est tenu pendant ce temps
      ordre.push('premier:fin');
      return cible;
    });
    // Laisser le premier prendre le verrou avant de lancer le second.
    await new Promise((r) => { setTimeout(r, 200); });
    await credits.crediter(t, 100 * MICRO, 'itest achat 2');
    let vuParLeSecond: { plafond: number; cible: number } | null = null;
    const second = cles.ajusterPlafond(t, async (c, cible) => {
      ordre.push('second');
      vuParLeSecond = { plafond: c.plafondMicroEur, cible };
      return cible;
    });
    await new Promise((r) => { setTimeout(r, 200); });
    expect(ordre).toEqual(['premier:debut']); // le second attend le verrou
    liberer();
    await Promise.all([premier, second]);
    expect(ordre).toEqual(['premier:debut', 'premier:fin', 'second']);
    // Le second a lu le plafond que le premier venait de noter, et une cible qui compte les deux achats.
    expect(vuParLeSecond).toEqual({ plafond: 60 * MICRO, cible: 160 * MICRO });
    expect((await cles.lire(t))!.plafondMicroEur).toBe(160 * MICRO);
  });
});
