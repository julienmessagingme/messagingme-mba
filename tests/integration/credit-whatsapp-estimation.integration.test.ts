import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo } from '../../src/campaign/store.pg';

/**
 * LES DESTINATAIRES À CHIFFRER, GROUPÉS EN BASE (plan du Crédit WhatsApp, tâche 6), sur une vraie base.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : que seuls les destinataires EN ATTENTE d'un étage WhatsApp comptent (un envoyé,
 * un étage e-mail ne coûtent rien au crédit), que la campagne d'un autre espace ne se lit pas, et que les numéros se
 * groupent par leurs onze premiers caractères sans perdre un destinataire.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur une base de production. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('les destinataires à chiffrer (tâche 6)', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  const espaces: string[] = [];

  async function espace(): Promise<string> {
    const id = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-estimation-wa') returning id`)).rows[0]!.id;
    espaces.push(id);
    return id;
  }

  /** Une campagne et ses étages écrits en SQL, puis ses destinataires (statut, étage courant). */
  async function campagne(
    tenantId: string,
    etages: Array<{ rang: number; canal: 'whatsapp' | 'email'; modele: string | null }>,
    destinataires: Array<{ numero: string; statut: 'pending' | 'sent'; etage?: number }>,
  ): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, channel)
       values ($1, 'pn-estimation', 'estimation', 'marketing', 'promo', 'fr', 'whatsapp') returning id`,
      [tenantId],
    )).rows[0]!.id;
    for (const e of etages) {
      await pool.query(
        `insert into campaign_etages (campaign_id, rang, canal, template_name, template_language) values ($1, $2, $3, $4, case when $4::text is null then null else 'fr' end)`,
        [id, e.rang, e.canal, e.modele],
      );
    }
    for (const d of destinataires) {
      const contact = (await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`,
        [tenantId, d.numero],
      )).rows[0]!.id;
      await pool.query(
        `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, etage_courant)
         values ($1, $2, $3, '[]'::jsonb, $4, $5)`,
        [id, contact, d.numero, d.statut, d.etage ?? 1],
      );
    }
    return id;
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(url) });
    repo = new PgCampaignRepo(pool);
  });

  afterAll(async () => {
    if (espaces.length > 0) {
      await pool.query('delete from campaigns where tenant_id = any($1::uuid[])', [espaces]);
      await pool.query('delete from contacts where tenant_id = any($1::uuid[])', [espaces]);
      await pool.query('delete from tenants where id = any($1::uuid[])', [espaces]);
    }
    await pool.end();
  });

  it('🔴 seuls les destinataires en attente d’un étage WhatsApp, groupés par préfixe, sans en perdre un', async () => {
    const t = await espace();
    const c = await campagne(t, [{ rang: 1, canal: 'whatsapp', modele: 'promo' }, { rang: 2, canal: 'email', modele: null }], [
      { numero: '+33612345601', statut: 'pending' },
      { numero: '+33612345602', statut: 'pending' },
      { numero: '+4915123456789', statut: 'pending' },
      { numero: '+33612345603', statut: 'sent' },
      { numero: '+33612345604', statut: 'pending', etage: 2 },
    ]);
    const groupes = await repo.groupesACreditWhatsapp(c, t);
    expect(groupes.reduce((n, g) => n + g.n, 0)).toBe(3);
    expect(groupes.find((g) => g.exemple.startsWith('+3361234560'))).toMatchObject({ n: 2, modele: { name: 'promo', language: 'fr' }, workflowId: null });
    expect(groupes.find((g) => g.exemple === '+4915123456789')).toMatchObject({ n: 1 });
  });

  it('🔴 la campagne d’un autre espace ne se lit pas', async () => {
    const t = await espace();
    const autre = await espace();
    const c = await campagne(t, [{ rang: 1, canal: 'whatsapp', modele: 'promo' }], [{ numero: '+33612345611', statut: 'pending' }]);
    expect(await repo.groupesACreditWhatsapp(c, autre)).toEqual([]);
  });
});
