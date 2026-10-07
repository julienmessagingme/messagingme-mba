import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgUserStore } from '../../src/user/store.pg';
import { LimiteOffreError } from '../../src/offres/refus';

/**
 * LA LIMITE DE MEMBRES DE L'OFFRE (lot 6, tâche 5), sur une vraie base : les comptes actifs, invitations en attente
 * comprises, et les administrateurs à part (Pro : 3 dont 2 admins au plus).
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('la limite de membres de l’offre', () => {
  let pool: Pool;
  let users: PgUserStore;
  let t = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    users = new PgUserStore(pool, async () => ({ utilisateurs: 3, admins: 2 }));
    t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-limite-membres') returning id`)).rows[0]!.id;
  });
  beforeEach(async () => { await pool.query('delete from users where tenant_id = $1', [t]); });
  afterAll(async () => {
    await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  const mail = (n: number) => `itest-limite-${n}@exemple.invalid`;

  it('🔴 le 4e membre est refusé, invitations en attente comprises ; un compte révoqué libère sa place', async () => {
    await users.createPending(t, mail(1), 'admin');
    const b = await users.createPending(t, mail(2), 'agent');
    await users.createPending(t, mail(3), 'agent');
    await expect(users.createPending(t, mail(4), 'agent')).rejects.toBeInstanceOf(LimiteOffreError);
    // Un agent révoqué (le dernier admin, lui, ne peut pas l'être).
    expect(await users.setDisabled(t, b.id, true)).toBe('ok');
    await expect(users.createPending(t, mail(5), 'agent')).resolves.toMatchObject({ email: mail(5) });
  });

  it('🔴 le 3e administrateur est refusé, à l’invitation comme au changement de rôle', async () => {
    await users.createPending(t, mail(1), 'admin');
    await users.createPending(t, mail(2), 'admin');
    await expect(users.createPending(t, mail(3), 'admin')).rejects.toMatchObject({ limite: 'admins' });
    const agent = await users.createPending(t, mail(4), 'agent');
    await expect(users.setRole(t, agent.id, 'admin')).rejects.toBeInstanceOf(LimiteOffreError);
  });

  it('🔴 le rang d’un membre (le gel, lot 6, B2a) : administrateurs et autres comptés à part, par date de création, comptes révoqués exclus', async () => {
    // Sans limite : quatre membres dépassent le Pro du magasin de ce fichier, et c'est l'espace revenu en Base qu'on décrit.
    const users = new PgUserStore(pool);
    const a1 = await users.createPending(t, mail(1), 'admin');
    const g1 = await users.createPending(t, mail(2), 'agent');
    const a2 = await users.createPending(t, mail(3), 'admin');
    const g2 = await users.createPending(t, mail(4), 'agent');
    // Des dates distinctes et connues : l'ordre ne dépend pas de la vitesse des insertions.
    for (const [id, j] of [[a1.id, 4], [g1.id, 3], [a2.id, 2], [g2.id, 1]] as const) {
      await pool.query(`update users set created_at = now() - make_interval(days => $2) where id = $1`, [id, j]);
    }
    expect(await users.rangMembre(t, a1.id)).toEqual({ estAdmin: true, adminsAvant: 0, autresAvant: 0, admins: 2 });
    expect(await users.rangMembre(t, a2.id)).toEqual({ estAdmin: true, adminsAvant: 1, autresAvant: 1, admins: 2 });
    expect(await users.rangMembre(t, g2.id)).toEqual({ estAdmin: false, adminsAvant: 2, autresAvant: 1, admins: 2 });
    expect(await users.setDisabled(t, g1.id, true)).toBe('ok');
    expect(await users.rangMembre(t, g2.id)).toMatchObject({ autresAvant: 0 });
    // Un compte révoqué, ou d'un autre espace : inconnu ici.
    expect(await users.rangMembre(t, g1.id)).toBeNull();
    expect(await users.rangMembre('00000000-0000-4000-8000-000000000000', a1.id)).toBeNull();
  });

  it('réactiver un compte quand la place est prise est refusé', async () => {
    await users.createPending(t, mail(1), 'admin');
    const b = await users.createPending(t, mail(2), 'agent');
    expect(await users.setDisabled(t, b.id, true)).toBe('ok');
    await users.createPending(t, mail(3), 'agent');
    await users.createPending(t, mail(4), 'agent');
    await expect(users.setDisabled(t, b.id, false)).rejects.toBeInstanceOf(LimiteOffreError);
  });
});
