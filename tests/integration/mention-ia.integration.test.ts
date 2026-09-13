import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgTenantSettingsStore } from '../../src/settings/store.pg';
import { PgAgentStore } from '../../src/agent/agent-store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * « L'IA SE DÉCLARE COMME TELLE », AU NIVEAU DE L'ESPACE (migration 0140), contre un VRAI Postgres.
 *
 * 🔴 CE QUI NE SE PROUVE QU'ICI : que le RUNTIME lit vraiment la politique de l'espace. Un test unitaire
 * monte un faux dépôt, et le faux bouge avec le code ; c'est exactement le mode de panne d'un déménagement
 * de réglage, où l'écran promet un comportement que la requête ne produit pas. La jointure de
 * `PgAgentStore.byId` est donc exécutée par le VRAI code, sur de vraies lignes.
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('politique d’annonce d’IA (Postgres)', () => {
  let pool: Pool;
  let settings: PgTenantSettingsStore;
  let agents: PgAgentStore;
  let tenantId: string;
  let autreTenantId: string;
  let agentId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    settings = new PgTenantSettingsStore(pool);
    agents = new PgAgentStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mention-ia') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mention-ia-autre') returning id`)).rows[0]!.id;
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-mention', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('🔴 le tour d’un agent lit la politique de SON espace, par le vrai code', async () => {
    await settings.setMentionIaFrequence(tenantId, 'chaque_message');
    expect((await agents.byId(tenantId, agentId))?.mentionIaFrequence).toBe('chaque_message');

    await settings.setMentionIaFrequence(tenantId, 'jamais');
    // ⚠️ `jamais` est le cas qu'un repli mal écrit requalifierait : il est le choix explicite du client.
    expect((await agents.byId(tenantId, agentId))?.mentionIaFrequence).toBe('jamais');
  });

  /**
   * 🔴 LE TÉMOIN DANS L'AUTRE SENS. Sans lui, une jointure qui ne filtrerait pas sur le tenant passerait le
   * cas précédent tout en lisant la politique d'un AUTRE client. Le pooler est superuser, la RLS est
   * contournée, et le filtrage en code est le seul contrôle.
   */
  it('🔴 la politique d’un AUTRE espace ne déborde pas sur celui-ci', async () => {
    await settings.setMentionIaFrequence(tenantId, 'session');
    await settings.setMentionIaFrequence(autreTenantId, 'chaque_message');
    expect((await agents.byId(tenantId, agentId))?.mentionIaFrequence).toBe('session');
  });

  /**
   * ⚠️ UN ESPACE QUI N'A JAMAIS RIEN RÉGLÉ retombe sur `session`, le défaut de 0126, donc le comportement
   * d'avant. La jointure est un LEFT JOIN : sans ligne de réglages, l'agent doit rester lisible.
   */
  it('⚠️ sans aucune ligne de réglages, l’agent reste lisible et retombe sur `session`', async () => {
    const neuf = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mention-ia-vierge') returning id`)).rows[0]!.id;
    try {
      const a = (await pool.query<{ id: string }>(
        `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-vierge', 'Je suis une IA.', 'm') returning id`,
        [neuf],
      )).rows[0]!.id;
      expect((await settings.get(neuf)).mentionIaFrequence, 'rien n’a été réglé').toBeNull();
      expect((await agents.byId(neuf, a))?.mentionIaFrequence).toBe('session');
    } finally {
      await pool.query('delete from tenants where id = $1', [neuf]);
    }
  });

  it('l’upsert est CIBLÉ : régler la politique n’écrase aucun autre réglage', async () => {
    await settings.setMbaEnabled(tenantId, true);
    await settings.setMentionIaFrequence(tenantId, 'chaque_message');
    const lu = await settings.get(tenantId);
    expect(lu.mentionIaFrequence).toBe('chaque_message');
    expect(lu.mbaEnabled, 'un upsert non ciblé aurait rendu mbaEnabled à false').toBe(true);
  });

  /**
   * 🔴 LA BASE REFUSE UNE VALEUR INCONNUE, pas seulement la route. C'est ce qui garantit qu'aucun AUTRE
   * chemin d'écriture (un script, une console SQL, un futur import) ne pourra poser un régime que le
   * runtime ne sait pas interpréter.
   */
  it('🔴 le CHECK refuse un régime inconnu', async () => {
    await expect(
      pool.query(`update tenant_settings set mention_ia_frequence = 'parfois' where tenant_id = $1`, [tenantId]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
