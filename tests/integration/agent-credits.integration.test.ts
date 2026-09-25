import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCreditStore } from '../../src/agent/credits.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * Le solde prépayé d'un workspace (migration 0087).
 *
 * 🔴 POURQUOI EN INTÉGRATION, ET PAS AVEC UN DOUBLE. Tout ce qui compte ici est du SQL. L'atomicité du
 * mouvement (le worker joue plusieurs tours en parallèle, y compris pour le même workspace : un
 * « lire puis écrire » perdrait une consommation sur deux au premier croisement, et le client paierait moins
 * que ce qu'il a consommé), l'`insert ... on conflict` qui crée la ligne au premier mouvement, le fait que
 * le solde et son journal soient écrits dans la MÊME instruction, et l'isolation entre clients. Un faux
 * store dirait oui à tout.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('solde prépayé d un workspace (Postgres)', () => {
  let pool: Pool;
  let credits: PgCreditStore;
  let tenantId: string;
  let autreTenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 8 });
    credits = new PgCreditStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credits') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credits-autre') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 un workspace sans ligne a un solde de ZÉRO, donc ses agents ne démarrent pas', async () => {
    // Le bon défaut : un crédit implicite ferait payer une consommation que personne n'a autorisée.
    expect(await credits.solde(tenantId)).toBe(0);
  });

  it('la recharge crée la ligne au premier mouvement, et la consommation la descend', async () => {
    expect(await credits.crediter(tenantId, 10_000_000, 'mise en service')).toBe(10_000_000);
    expect(await credits.debiter(tenantId, 4_200)).toBe(9_995_800);
    expect(await credits.solde(tenantId)).toBe(9_995_800);
  });

  it('🔴 le solde et son JOURNAL sont écrits ensemble', async () => {
    // Un solde sans journal est inexplicable la première fois qu'il baisse : c'est ce qui permet de répondre
    // à un client qui demande où est passé son argent.
    const m = await credits.mouvements(tenantId, 10);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ deltaMicroEur: -4_200, raison: 'conso' });
    expect(m[1]).toMatchObject({ deltaMicroEur: 10_000_000, raison: 'recharge', note: 'mise en service' });
  });

  it('une consommation SANS session porte une note, sinon elle serait inexplicable', async () => {
    // Le cas de l'essai depuis la console : il consomme pour de vrai (le fournisseur facture), mais n'ouvre
    // aucune session. Sans la note, le journal montrerait une baisse que rien ne rattache à quoi que ce soit.
    await credits.debiter(tenantId, 300, { note: 'essai depuis la console' });
    expect((await credits.mouvements(tenantId, 1))[0]).toMatchObject({
      deltaMicroEur: -300, raison: 'conso', note: 'essai depuis la console',
    });
    expect((await credits.mouvements(tenantId, 1))[0]!.sessionId).toBeUndefined();
  });

  it('🔴 DIX consommations SIMULTANÉES sont toutes comptées', async () => {
    // LE test de ce module. Le worker joue plusieurs tours en parallèle pour le même workspace : un
    // « lire puis écrire » en perdrait, et le client paierait moins que ce qu'il a consommé.
    const avant = await credits.solde(tenantId);
    await Promise.all(Array.from({ length: 10 }, () => credits.debiter(tenantId, 1_000)));
    expect(await credits.solde(tenantId)).toBe(avant - 10_000);
    expect(await credits.mouvements(tenantId, 50)).toHaveLength(13);
  });

  it('🔴 le solde peut devenir NÉGATIF, et c est voulu', async () => {
    // Un tour déjà joué a déjà coûté chez le fournisseur. Refuser de l'enregistrer pour garder un zéro
    // propre reviendrait à offrir la dernière conversation. La garde est à l'ENTRÉE du tour.
    const neuf = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credits-neg') returning id`)).rows[0]!.id;
    try {
      await credits.crediter(neuf, 1_000, 'mise en service');
      expect(await credits.debiter(neuf, 5_000)).toBe(-4_000);
    } finally {
      await pool.query('delete from tenants where id = $1', [neuf]);
    }
  });

  it('un montant nul ou négatif n écrit RIEN, et surtout ne devient pas un rechargement déguisé', async () => {
    const avant = await credits.solde(tenantId);
    const lignes = (await credits.mouvements(tenantId, 100)).length;
    expect(await credits.debiter(tenantId, 0)).toBe(avant);
    expect(await credits.debiter(tenantId, -5_000)).toBe(avant);
    expect(await credits.crediter(tenantId, 0, 'rien du tout')).toBe(avant);
    expect(await credits.mouvements(tenantId, 100)).toHaveLength(lignes);
  });

  it('🔴 les soldes de deux clients sont ÉTANCHES', async () => {
    const mien = await credits.solde(tenantId);
    await credits.crediter(autreTenantId, 7_000_000, 'mise en service');
    expect(await credits.solde(tenantId)).toBe(mien);
    expect(await credits.solde(autreTenantId)).toBe(7_000_000);
    // Et le journal aussi : le mouvement de l'un n'apparaît pas chez l'autre.
    expect(await credits.mouvements(autreTenantId, 10)).toHaveLength(1);
  });

  it('la suppression d un workspace emporte son solde et son journal', async () => {
    // `on delete cascade` : un solde orphelin serait de l'argent qui appartient à personne.
    const jetable = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credits-jetable') returning id`)).rows[0]!.id;
    await credits.crediter(jetable, 1_000, 'mise en service');
    await pool.query('delete from tenants where id = $1', [jetable]);
    const reste = await pool.query('select 1 from agent_credits where tenant_id = $1', [jetable]);
    expect(reste.rowCount).toBe(0);
  });
});
