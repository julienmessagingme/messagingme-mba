/**
 * Seed d'un tenant de démo : tenant + WABA + numéro + compte admin (mot de passe hashé).
 * Idempotent. Usage : SEED_EMAIL=... SEED_PASSWORD=... SEED_PHONE_NUMBER_ID=... npx tsx db/seed.ts
 */
import '../src/charger-env';
import { Client } from 'pg';
import { pgSsl } from '../src/db/ssl';
import { hashPasswordSync } from '../src/auth/password';

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
    // 🔴 LE MOT DE PASSE VIT SUR L’IDENTITÉ, PAS SUR LE COMPTE, depuis 0072 (« une adresse = plusieurs
    // espaces ») : `findIdentity` joint `users.identity_id` à `identities.id` et lit `identities.password_hash`.
    // Un compte SEUL, même avec son propre `password_hash`, NE PEUT PAS SE CONNECTER, et rien dans le schéma
    // ne l’interdit (`users.identity_id` est NULLABLE). Le semis créait exactement cet état, mesuré sur une
    // base jetable le 2026-10-02 : 1 compte, 0 identité, et un 401 « identifiants invalides » à la première
    // connexion. On suit donc le vrai chemin d’inscription (`PgUserStore`), qui écrit l’identité puis le compte.
    const identityId = (await client.query<{ id: string }>(
      `insert into identities (email, password_hash) values ($1, $2)
       on conflict (lower(email)) do update set password_hash = excluded.password_hash
       returning id`,
      [EMAIL, hashPasswordSync(PASSWORD)],
    )).rows[0]!.id;
    // Conflit sur l’unicité PAR ESPACE (`users_tenant_email_unique`, sur `(tenant_id, lower(email))`).
    // ⚠️ `password_hash` n’est PAS écrit ici : le login ne le lit pas, et une seconde copie du secret serait
    // une seconde vérité qui divergerait au premier changement de mot de passe.
    await client.query(
      `insert into users (tenant_id, email, role, identity_id) values ($1, $2, 'admin', $3)
       on conflict (tenant_id, lower(email)) do update set identity_id = excluded.identity_id`,
      [tenantId, EMAIL, identityId],
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
