/**
 * Seed d'un tenant de démo : tenant + WABA + numéro + compte admin (mot de passe hashé).
 * Idempotent. Usage : SEED_EMAIL=... SEED_PASSWORD=... SEED_PHONE_NUMBER_ID=... npx tsx db/seed.ts
 */
import 'dotenv/config';
import { Client } from 'pg';
import { pgSsl } from '../src/db/ssl';
import { hashPassword } from '../src/auth/password';

// Garde-fou anti footgun de prod : pas de creds démo par défaut. Il faut SOIT fournir
// SEED_PASSWORD explicitement, SOIT opter pour les défauts démo via SEED_DEMO=true.
if (!process.env.SEED_PASSWORD && process.env.SEED_DEMO !== 'true') {
  // eslint-disable-next-line no-console
  console.error('Refus : fournis SEED_PASSWORD (recommandé) ou SEED_DEMO=true pour les creds démo (admin@demo.test/demo1234).');
  process.exit(1);
}

const TENANT_NAME = process.env.SEED_TENANT_NAME ?? 'Demo';
const EMAIL = (process.env.SEED_EMAIL ?? 'admin@demo.test').trim().toLowerCase();
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo1234';
const PHONE_NUMBER_ID = process.env.SEED_PHONE_NUMBER_ID ?? 'demo-pn';
const WABA_ID = process.env.SEED_WABA_ID ?? 'demo-waba';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant (.env)');
  const client = new Client({ connectionString: url, ssl: pgSsl() });
  await client.connect();
  try {
    // Idempotent : tenants n'a pas d'unicité sur le nom -> select puis insert si absent.
    let tenantId = (
      await client.query<{ id: string }>(`select id from tenants where name = $1 order by created_at limit 1`, [TENANT_NAME])
    ).rows[0]?.id;
    if (!tenantId) {
      tenantId = (await client.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [TENANT_NAME])).rows[0]?.id;
    }
    if (!tenantId) throw new Error('impossible de créer/retrouver le tenant');

    await client.query(
      `insert into waba (id, tenant_id, name) values ($1, $2, $3)
       on conflict (id) do update set tenant_id = excluded.tenant_id`,
      [WABA_ID, tenantId, `${TENANT_NAME} WABA`],
    );
    await client.query(
      `insert into phone_numbers (id, waba_id, tenant_id, display_phone_number, verified_name)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update set tenant_id = excluded.tenant_id`,
      [PHONE_NUMBER_ID, WABA_ID, tenantId, '+33000000000', TENANT_NAME],
    );
    await client.query(
      // Conflit sur l'index email GLOBAL (migration 0010, users_email_lower_unique) : re-seed
      // idempotent même à la casse près, cohérent avec « un email = un compte ».
      `insert into users (tenant_id, email, role, password_hash) values ($1, $2, 'admin', $3)
       on conflict (lower(email)) do update set password_hash = excluded.password_hash, tenant_id = excluded.tenant_id`,
      [tenantId, EMAIL, hashPassword(PASSWORD)],
    );

    // eslint-disable-next-line no-console
    console.log(`Seed ok. tenant=${tenantId} email=${EMAIL} phone_number_id=${PHONE_NUMBER_ID}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
