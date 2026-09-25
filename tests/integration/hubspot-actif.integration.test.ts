import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgTenantSettingsStore } from '../../src/settings/store.pg';

/**
 * L'INTERRUPTEUR HUBSPOT DE L'ESPACE (migration 0179), contre une VRAIE base.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : que la REPRISE allume exactement les espaces reliés à un portail,
 * qu'elle tolère un lien du connecteur qui n'est pas un uuid (la colonne est `text` dans `mmhs`), et que
 * l'écriture de l'interrupteur n'écrase aucun autre réglage.
 *
 * ⚠️ LA REPRISE TOURNE DANS UNE TRANSACTION ANNULÉE : elle crée le schéma `mmhs` le temps du test. La base de
 * la CI ne le porte pas, et le laisser derrière changerait ce que voient les autres fichiers (le masquage du
 * lot 9 retombe sur « pas de portail » précisément parce que ce schéma n'existe pas). Le cas « base sans
 * `mmhs` » est, lui, prouvé par le `migrate` de la CI elle-même : une référence non gardée l'aurait fait échouer.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI
 * monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const MIGRATION = readFileSync(resolve(__dirname, '..', '..', 'db', 'migrations', '0179_hubspot_actif.sql'), 'utf8');

describe.skipIf(!url)('l’interrupteur HubSpot en base', () => {
  let pool: Pool;
  let store: PgTenantSettingsStore;
  let tenantId = '';
  let autreTenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgTenantSettingsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-hubspot-actif') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-hubspot-actif-autre') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('🔴 faux tant que personne n’y a touché, fait l’aller-retour, et n’écrase aucun autre réglage', async () => {
    expect((await store.get(tenantId)).hubspotActif).toBe(false);
    await store.setMbaEnabled(tenantId, true);
    await store.setHubspotActif(tenantId, true);
    const apres = await store.get(tenantId);
    expect(apres.hubspotActif).toBe(true);
    expect(apres.mbaEnabled, 'upsert ciblé : le réglage voisin n’a pas bougé').toBe(true);
    await store.setHubspotActif(tenantId, false);
    expect((await store.get(tenantId)).hubspotActif).toBe(false);
  });

  it('🔴 isolation : allumer un espace ne touche pas l’autre', async () => {
    await store.setHubspotActif(tenantId, true);
    expect((await store.get(autreTenantId)).hubspotActif).toBe(false);
    await store.setHubspotActif(tenantId, false);
  });

  it('🔴 la reprise allume les espaces reliés à un portail, et eux seuls', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Trois espaces : relié (lien ET portail), lien sans portail, sans lien. Plus un lien du connecteur qui
      // n'est pas un uuid : comparé en texte, il ne rejoint aucun espace et ne fait pas échouer la migration.
      const nouveau = async (nom: string) => (await client.query<{ id: string }>('insert into tenants (name) values ($1) returning id', [nom])).rows[0]!.id;
      const relie = await nouveau('itest-hs-relie');
      const lienSeul = await nouveau('itest-hs-lien-seul');
      const sansLien = await nouveau('itest-hs-sans-lien');
      await client.query('create schema if not exists mmhs');
      await client.query('create table if not exists mmhs.portals (hub_id text primary key, hub_domain text, granted_scopes text[])');
      await client.query('create table if not exists mmhs.tenant_portals (tenant_id text primary key, hub_id text not null)');
      await client.query(`insert into mmhs.portals (hub_id, hub_domain) values ('itest-hub-1', 'acme.hubspot.com')`);
      await client.query(
        `insert into mmhs.tenant_portals (tenant_id, hub_id) values ($1, 'itest-hub-1'), ($2, 'itest-hub-absent'), ('pas-un-uuid', 'itest-hub-1')`,
        [relie, lienSeul],
      );
      // L'espace relié a DÉJÀ une ligne de réglages : la reprise ne doit bouger que la colonne.
      await client.query('insert into tenant_settings (tenant_id, mba_enabled) values ($1, true)', [relie]);

      await client.query(MIGRATION);

      const lire = async (t: string) => (await client.query<{ hubspot_actif: boolean; mba_enabled: boolean }>(
        'select hubspot_actif, mba_enabled from tenant_settings where tenant_id = $1', [t],
      )).rows[0];
      expect(await lire(relie)).toEqual({ hubspot_actif: true, mba_enabled: true });
      expect(await lire(lienSeul), 'un lien sans portail n’est pas un portail relié').toBeUndefined();
      expect(await lire(sansLien)).toBeUndefined();
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
