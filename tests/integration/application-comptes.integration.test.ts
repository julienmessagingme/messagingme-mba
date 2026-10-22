import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgComptesApplication } from '../../src/application/comptes.pg';

/**
 * LES COMPTES DE LA FILIÈRE APPLICATION (migration 0247), sur une vraie base.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : un numéro tenu par UN seul espace vivant (index unique partiel), libéré par
 * un bannissement, la filière lue des deux tables, le CHECK du statut, et la session effacée à chaque préparation.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const NUMERO = '449990000071';

describe.skipIf(!url)('les comptes de la filière application (0247)', () => {
  let pool: Pool;
  let comptes: PgComptesApplication;
  let t1 = '';
  let t2 = '';
  let t3 = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    comptes = new PgComptesApplication(pool);
    const espace = async (nom: string) => (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
    t1 = await espace('itest-application-1');
    t2 = await espace('itest-application-2');
    t3 = await espace('itest-application-3');
  });

  afterAll(async () => {
    // La cascade des espaces emporte waba, phone_numbers et comptes_application.
    await pool.query('delete from tenants where id = any($1::uuid[])', [[t1, t2, t3]]);
    await pool.end();
  });

  it('🔴 un numéro relié dans un espace est refusé dans un second, et le premier garde sa connexion', async () => {
    const a = await comptes.preparer(t1, { numero: '+' + NUMERO, fourniId: null });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await comptes.marquer(a.compte.id, 'relie', { jid: `${NUMERO}:1@s.whatsapp.net` });
    expect(await comptes.preparer(t2, { numero: NUMERO, fourniId: null })).toEqual({ ok: false, raison: 'numero_pris' });
    expect((await comptes.parEspace(t1))?.statut).toBe('relie');
  });

  it('banni, le numéro se libère pour un autre espace', async () => {
    const c = await comptes.parEspace(t1);
    await comptes.marquer(c!.id, 'banni');
    const b = await comptes.preparer(t2, { numero: NUMERO, fourniId: null });
    expect(b.ok).toBe(true);
  });

  it('un espace déjà relié ne se prépare pas de nouveau', async () => {
    const c = await comptes.parEspace(t2);
    await comptes.marquer(c!.id, 'relie');
    expect(await comptes.preparer(t2, { numero: '449990000072', fourniId: null })).toEqual({ ok: false, raison: 'deja_relie' });
  });

  it('la filière : l’application si un compte non retiré existe, l’API si un numéro de Meta est relié, sinon rien', async () => {
    expect(await comptes.filiereDe(t2)).toBe('application');
    expect(await comptes.filiereDe(t3)).toBeNull();
    await pool.query(`insert into waba (id, tenant_id, name) values ('itest-app-waba-3', $1, 'itest')`, [t3]);
    await pool.query(
      `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status) values ('itest-app-pn-3', $1, 'itest-app-waba-3', '+33 1 00 00 00 00', 'CONNECTED')`,
      [t3],
    );
    expect(await comptes.filiereDe(t3)).toBe('api');
    expect(await comptes.preparer(t3, { numero: '449990000073', fourniId: null })).toEqual({ ok: false, raison: 'filiere_api' });
  });

  it('une nouvelle préparation efface la session précédente', async () => {
    const c = (await comptes.parEspace(t1))!;
    await pool.query(`insert into comptes_application_auth (compte_id, categorie, cle, valeur) values ($1, 'creds', 'main', 'x')`, [c.id]);
    const p = await comptes.preparer(t1, { numero: '449990000074', fourniId: null });
    expect(p.ok).toBe(true);
    const reste = await pool.query('select 1 from comptes_application_auth where compte_id = $1', [c.id]);
    expect(reste.rowCount).toBe(0);
  });

  it('le CHECK refuse un statut inconnu', async () => {
    const c = (await comptes.parEspace(t1))!;
    await expect(pool.query(`update comptes_application set statut = 'inconnu' where id = $1`, [c.id])).rejects.toThrow();
  });

  it('toucher n’avance jamais à reculons', async () => {
    const c = (await comptes.parEspace(t1))!;
    await comptes.toucher(c.id, new Date('2026-10-22T10:00:00Z'));
    await comptes.toucher(c.id, new Date('2026-10-20T10:00:00Z'));
    expect((await comptes.parId(c.id))?.dernierMessageLe?.toISOString()).toBe('2026-10-22T10:00:00.000Z');
  });
});
