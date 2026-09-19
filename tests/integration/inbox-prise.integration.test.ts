import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { PgTenantSettingsStore } from '../../src/settings/store.pg';

/**
 * Un agent PREND une conversation du pot commun (migration 0160, arbitrage de Julien du 2026-09-19).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QU'AUCUN TEST UNITAIRE NE VOIT : que la prise soit CONDITIONNELLE en base.
 * Deux agents qui cliquent en même temps ne doivent pas se voler la conversation ; seul un `where
 * assigned_to is null` exécuté par Postgres le garantit. Et que le sélecteur de l'encadrement voie les
 * membres que l'affectation accepte, ni plus ni moins.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const WA_ID = '33600000162';

describe.skipIf(!url)('prendre une conversation du pot commun', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let reglages: PgTenantSettingsStore;
  let tenantId = '';
  let autreTenantId = '';
  let jean = '';
  let marie = '';
  let revoque = '';
  let etranger = '';
  let convId = '';

  const membre = async (tenant: string, email: string, nom: string) => (await pool.query<{ id: string }>(
    `insert into users (tenant_id, email, name, password_hash, role) values ($1, $2, $3, 'x', 'agent') returning id`,
    [tenant, email, nom],
  )).rows[0]!.id;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgInboxStore(pool);
    reglages = new PgTenantSettingsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-inbox-prise') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-inbox-prise-autre') returning id`)).rows[0]!.id;
    jean = await membre(tenantId, 'jean@prise.itest', 'Jean');
    marie = await membre(tenantId, 'marie@prise.itest', 'Marie');
    revoque = await membre(tenantId, 'parti@prise.itest', 'Parti');
    await pool.query('update users set disabled_at = now() where id = $1', [revoque]);
    etranger = await membre(autreTenantId, 'autre@prise.itest', 'Autre');
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await store.recordInbound(tenantId, {
      phoneNumberId: 'pn', waId: WA_ID, messageId: 'wamid.itest-prise', type: 'text', body: 'bonjour',
      buttonPayload: null, profileName: null, field: 'messages',
    });
    convId = (await pool.query<{ id: string }>('select id from conversations where tenant_id = $1', [tenantId])).rows[0]!.id;
  });

  it('🔴 le premier qui prend l’a, le second ne la lui VOLE pas', async () => {
    expect(await store.prendreSiLibre(tenantId, convId, jean)).toBe(true);
    expect(await store.prendreSiLibre(tenantId, convId, marie)).toBe(false);
    expect(await store.getAssignee(tenantId, convId)).toBe(jean);
  });

  it('🔴 deux prises SIMULTANÉES : une seule gagne', async () => {
    // Le cas que l'écriture conditionnelle existe pour tenir : deux requêtes parties en même temps.
    const [a, b] = await Promise.all([
      store.prendreSiLibre(tenantId, convId, jean),
      store.prendreSiLibre(tenantId, convId, marie),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('la prise est signée par l’agent lui-même dans le journal d’affectation', async () => {
    await store.prendreSiLibre(tenantId, convId, jean);
    const r = await pool.query<{ assigned_by: string | null }>('select assigned_by from conversations where id = $1', [convId]);
    expect(r.rows[0]!.assigned_by).toBe(jean);
  });

  it('🔴 un compte révoqué ou d’un autre espace ne prend rien', async () => {
    expect(await store.prendreSiLibre(tenantId, convId, revoque)).toBe(false);
    expect(await store.prendreSiLibre(tenantId, convId, etranger)).toBe(false);
    expect(await store.prendreSiLibre(autreTenantId, convId, etranger)).toBe(false);
    expect(await store.getAssignee(tenantId, convId)).toBeNull();
  });

  it('🔴 les membres affectables : les actifs de l’espace, ni le révoqué ni l’étranger', async () => {
    const membres = await store.membresPourAffectation(tenantId);
    expect(membres).toEqual([{ id: jean, nom: 'Jean' }, { id: marie, nom: 'Marie' }]);
  });

  it('🔴 le réglage fait l’aller-retour, et vaut FAUX tant que personne ne l’a touché', async () => {
    expect((await reglages.get(tenantId)).agentsPeuventPrendre).toBe(false);
    await reglages.setAgentsPeuventPrendre(tenantId, true);
    expect((await reglages.get(tenantId)).agentsPeuventPrendre).toBe(true);
    await reglages.setAgentsPeuventPrendre(tenantId, false);
    expect((await reglages.get(tenantId)).agentsPeuventPrendre).toBe(false);
    // Un autre espace n'a rien vu.
    expect((await reglages.get(autreTenantId)).agentsPeuventPrendre).toBe(false);
  });
});
