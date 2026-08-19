import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgEmailAccountStore } from '../../src/email/account-store.pg';
import type { EmailAccountInput } from '../../src/email/types';

// ⚠️ Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier crée/supprime des tenants. La CI monte un Postgres jetable pour ça
// (job `integration`) : c'est là qu'il doit tourner. `describe.skipIf(!url)` le rend inerte si DATABASE_URL
// n'est pas défini, mais ne protège pas contre un DATABASE_URL défini qui pointerait sur la prod.
const url = process.env.DATABASE_URL ?? '';

function baseInput(label: string, username: string): EmailAccountInput {
  return {
    label,
    host: 'ssl0.ovh.net',
    port: 465,
    secure: true,
    username,
    password: 's3cr3t-itest',
    fromAddress: username,
  };
}

describe.skipIf(!url)('PgEmailAccountStore (Postgres réel, Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    const res = await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-email-accounts') returning id`,
    );
    tenantId = res.rows[0]!.id;
    const other = await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-email-accounts-other') returning id`,
    );
    otherTenantId = other.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (otherTenantId) await pool.query('delete from tenants where id = $1', [otherTenantId]);
    await pool.end();
  });

  it('create() + getDecrypted() : round-trip réel, password_enc en base n’est jamais le clair', async () => {
    const store = new PgEmailAccountStore(pool);
    const acc = await store.create(tenantId, baseInput('support', 'support@exemple.fr'));
    expect(acc.id).toBeTruthy();
    expect((acc as unknown as Record<string, unknown>).password).toBeUndefined();

    const raw = (await pool.query<{ password_enc: string }>(
      `select password_enc from email_accounts where id = $1`, [acc.id],
    )).rows[0]!;
    expect(raw.password_enc).not.toContain('s3cr3t-itest');
    expect(raw.password_enc.startsWith('v1.')).toBe(true);

    const dec = await store.getDecrypted(tenantId, acc.id);
    expect(dec?.password).toBe('s3cr3t-itest');
  });

  it('isolation cross-tenant RÉELLE : getById/getDecrypted/update/softDelete/markVerified d’un autre tenant sont sans effet', async () => {
    const store = new PgEmailAccountStore(pool);
    const acc = await store.create(tenantId, baseInput('iso-itest', 'iso@exemple.fr'));

    expect(await store.getById(otherTenantId, acc.id)).toBeNull();
    expect(await store.getDecrypted(otherTenantId, acc.id)).toBeNull();
    expect(await store.update(otherTenantId, acc.id, { label: 'vole' })).toBeNull();
    expect(await store.softDelete(otherTenantId, acc.id)).toBe(false);
    await store.markVerified(otherTenantId, acc.id); // void : ne doit rien toucher, juste ne pas planter

    // Le tenant PROPRIÉTAIRE voit la boîte toujours intacte (label d'origine, jamais vérifiée) : aucune des
    // tentatives cross-tenant ci-dessus n'a laissé de trace.
    const mine = await store.getById(tenantId, acc.id);
    expect(mine?.label).toBe('iso-itest');
    expect(mine?.verifiedAt).toBeNull();
  });

  it('contrainte unique (tenant_id,label) : label dupliqué rejeté sur le MÊME tenant, libre sur un AUTRE', async () => {
    const store = new PgEmailAccountStore(pool);
    await store.create(tenantId, baseInput('unique-itest', 'a@exemple.fr'));
    await expect(store.create(tenantId, baseInput('unique-itest', 'b@exemple.fr'))).rejects.toThrow();

    // Index scopé tenant_id : le même label sur un AUTRE tenant ne rentre pas en conflit.
    const onOther = await store.create(otherTenantId, baseInput('unique-itest', 'c@exemple.fr'));
    expect(onOther.label).toBe('unique-itest');
  });

  it('softDelete() masque la boîte de getById()/list() mais la ligne reste en base, et le label redevient libre', async () => {
    const store = new PgEmailAccountStore(pool);
    const acc = await store.create(tenantId, baseInput('a-supprimer', 'del@exemple.fr'));

    expect(await store.softDelete(tenantId, acc.id)).toBe(true);
    expect(await store.getById(tenantId, acc.id)).toBeNull();
    expect((await store.list(tenantId)).some((a) => a.id === acc.id)).toBe(false);

    // Suppression DOUCE : la ligne existe toujours, deleted_at posé (jamais un vrai DELETE).
    const row = (await pool.query<{ deleted_at: Date | null }>(
      `select deleted_at from email_accounts where id = $1`, [acc.id],
    )).rows[0]!;
    expect(row.deleted_at).not.toBeNull();

    // L'index unique (tenant_id,label) est scopé `where deleted_at is null` : le label est réutilisable.
    const recreated = await store.create(tenantId, baseInput('a-supprimer', 'del2@exemple.fr'));
    expect(recreated.label).toBe('a-supprimer');
  });

  it('update() partiel + markVerified() : effets réels persistés (updated_at avance, mot de passe remplacé)', async () => {
    const store = new PgEmailAccountStore(pool);
    const acc = await store.create(tenantId, { ...baseInput('update-itest', 'upd@exemple.fr'), password: 's3cr3t-avant' });
    const before = (await pool.query<{ updated_at: Date }>(
      `select updated_at from email_accounts where id = $1`, [acc.id],
    )).rows[0]!.updated_at;

    const updated = await store.update(tenantId, acc.id, { host: 'smtp.exemple.fr', password: 's3cr3t-apres' });
    expect(updated?.host).toBe('smtp.exemple.fr');
    expect(updated?.verifiedAt).toBeNull();

    const after = (await pool.query<{ updated_at: Date }>(
      `select updated_at from email_accounts where id = $1`, [acc.id],
    )).rows[0]!.updated_at;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());

    // Le mot de passe a bien été REMPLACÉ (déchiffrement redonne la nouvelle valeur, pas l'ancienne).
    const dec = await store.getDecrypted(tenantId, acc.id);
    expect(dec?.password).toBe('s3cr3t-apres');

    await store.markVerified(tenantId, acc.id);
    const verified = await store.getById(tenantId, acc.id);
    expect(verified?.verifiedAt).not.toBeNull();
  });
});
