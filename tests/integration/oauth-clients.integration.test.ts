import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgOauthStore } from '../../src/oauth/store.pg';
import { PgOauthClientsStore } from '../../src/oauth/clients.pg';
import { nouveauJeton, PREFIXE_ACCES, PREFIXE_CODE, PREFIXE_RENOUVELLEMENT } from '../../src/oauth/jetons';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION.
const url = process.env.DATABASE_URL ?? '';

/**
 * LOT 15 : LES AUTRES CLIENTS MCP CONTRE UN VRAI POSTGRES (migration 0227). Les CHECK de forme et de marque, le store
 * des clients enregistrés, ce que l'autorisation garde du client affiché, la purge qui épargne un client utilisé, et
 * l'origine `client_mcp`.
 */
describe.skipIf(!url)('les clients OAuth ouverts (Postgres réel)', () => {
  let pool: Pool;
  let store: PgOauthStore;
  let clients: PgOauthClientsStore;
  let tenantId: string;
  let adminId: string;
  const RESSOURCE = 'https://api.exemple.test/mcp';
  const DEFI = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgOauthStore(pool);
    clients = new PgOauthClientsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-oauth-clients') returning id`)).rows[0]!.id;
    adminId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role) values ($1, $2, 'admin') returning id`, [tenantId, `itest-oauth-cl-${randomUUID()}@exemple.test`],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.query(`delete from oauth_clients where nom like 'itest-%'`);
    await pool.end();
  });

  const autoriser = async (clientId: string, client?: { nom: string; marque: 'domaine' | 'declaree'; hote: string }) => {
    const code = nouveauJeton(PREFIXE_CODE);
    return store.creerAutorisation({
      tenantId, userId: adminId, clientId, scopes: ['mcp:read'], resource: RESSOURCE,
      code: { empreinte: code.empreinte, challenge: DEFI, redirectUri: 'https://app.exemple.fr/cb' },
      ...(client ? { client } : {}),
    });
  };

  it('🔴 les CHECK de 0227 : une adresse https ou mcl_ ; une marque connue ; refusés sous leur nom sinon', async () => {
    const tenter = (client: string, marque: string | null = null) => pool.query(
      `insert into oauth_autorisations (tenant_id, user_id, client_id, scopes, resource, client_marque) values ($1, $2, $3, $4, $5, $6)`,
      [tenantId, adminId, client, ['mcp:read'], RESSOURCE, marque],
    );
    for (const faux of ['http://evil.test/fiche', 'pas-un-client', 'mcl_court', 'https://a b']) {
      await expect(tenter(faux), faux).rejects.toMatchObject({ constraint: 'oauth_autorisations_client_chk' });
    }
    await expect(tenter('https://chatgpt.com/oauth/x.json', 'verifiee')).rejects.toMatchObject({ constraint: 'oauth_autorisations_marque_chk' });
    await expect(pool.query(`insert into oauth_clients (client_id, adresses_de_retour) values ('mcl_x', '{https://a.fr}')`))
      .rejects.toMatchObject({ constraint: 'oauth_clients_id_chk' });
    await expect(pool.query(`insert into oauth_clients (client_id, adresses_de_retour) values ($1, '{}')`, [`mcl_${'B'.repeat(32)}`]))
      .rejects.toMatchObject({ constraint: 'oauth_clients_adresses_chk' });
    await expect(pool.query(`update tenants set origine = 'autre' where id = $1`, [tenantId])).rejects.toMatchObject({ constraint: 'tenants_origine_chk' });
    await pool.query(`update tenants set origine = 'client_mcp' where id = $1`, [tenantId]);
  });

  it('un client enregistré se relit ; l’autorisation garde son nom, sa marque et son hôte, que la liste rend', async () => {
    const { clientId } = await clients.enregistrer({ nom: 'itest-Cursor', adressesDeRetour: ['http://127.0.0.1:8787/callback'], typeApplication: 'native' });
    expect(clientId).toMatch(/^mcl_[A-Za-z0-9]{32}$/);
    expect(await clients.lire(clientId)).toEqual({
      id: clientId, nom: 'itest-Cursor', adressesDeRetour: ['http://127.0.0.1:8787/callback'], marque: 'declaree',
    });
    expect(await clients.lire(`mcl_${'C'.repeat(32)}`)).toBeNull();

    const { autorisationId } = await autoriser(clientId, { nom: 'itest-Cursor', marque: 'declaree', hote: '127.0.0.1' });
    // La liste ne montre que les autorisations dont le code a été échangé.
    const acces = nouveauJeton(PREFIXE_ACCES);
    const refresh = nouveauJeton(PREFIXE_RENOUVELLEMENT);
    await store.poserJetons(autorisationId, {
      acces: acces.empreinte, refresh: refresh.empreinte, accesExpireLe: new Date(Date.now() + 3600_000),
      refreshExpireLe: new Date(Date.now() + 86_400_000), refreshMaxLe: new Date(Date.now() + 86_400_000),
    });
    const ligne = (await store.lister(tenantId)).find((a) => a.id === autorisationId);
    expect(ligne).toMatchObject({ clientId, clientNom: 'itest-Cursor', clientMarque: 'declaree', clientHote: '127.0.0.1' });
  });

  it('🔴 la purge : un client de plus de 30 jours sans autorisation vivante part ; utilisé ou récent, il reste', async () => {
    const vieux = (await clients.enregistrer({ nom: 'itest-vieux', adressesDeRetour: ['https://a.exemple.fr/cb'], typeApplication: null })).clientId;
    const utilise = (await clients.enregistrer({ nom: 'itest-utilise', adressesDeRetour: ['https://b.exemple.fr/cb'], typeApplication: null })).clientId;
    const recent = (await clients.enregistrer({ nom: 'itest-recent', adressesDeRetour: ['https://c.exemple.fr/cb'], typeApplication: null })).clientId;
    await pool.query(`update oauth_clients set cree_le = now() - interval '31 days' where client_id = any($1::text[])`, [[vieux, utilise]]);
    // Une autorisation dont le code n'est pas encore échangé est vivante : elle garde son client.
    await autoriser(utilise);
    await clients.purger();
    expect(await clients.lire(vieux)).toBeNull();
    expect(await clients.lire(utilise)).not.toBeNull();
    expect(await clients.lire(recent)).not.toBeNull();
  });
});
