import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES PERSONNES ENGAGÉES PAR UNE CAMPAGNE : celles qui ont cliqué, et celles qui ont RÉPONDU.
 *
 * 🔴 POURQUOI EN INTÉGRATION, ET PAS AVEC UN DOUBLE. Tout ce qui décide ici est du SQL, et rien de ce
 * qui compte ne se vérifie autrement : le DÉDOUBLONNAGE (quelqu'un qui clique PUIS répond ne compte
 * qu'une fois, c'est une `union` de deux populations), la FENÊTRE de sept jours calculée par
 * destinataire, et l'isolation entre espaces. Un faux store dirait oui à tout.
 *
 * Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('les personnes engagées par une campagne (Postgres)', () => {
  let pool: Pool;
  let stats: PgStatsStore;
  let tenantId: string;
  let autreTenantId: string;
  let campagneId: string;

  /** Un contact, un destinataire envoyé à `sentAt`. Rend l'identifiant du contact. */
  async function destinataire(sentAt: string, suffixe: string): Promise<string> {
    const c = await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`,
      [tenantId, `+3360000${suffixe}`],
    );
    const contactId = c.rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, status, sent_at)
       values ($1, $2, $3, 'sent', $4)`,
      [campagneId, contactId, `+3360000${suffixe}`, sentAt],
    );
    return contactId;
  }

  /** Une réponse de ce contact, à l'instant donné. */
  async function repond(contactId: string, at: string): Promise<void> {
    const cv = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, contact_id, wa_id) values ($1, $2, $3)
       on conflict do nothing returning id`,
      [tenantId, contactId, `wa-${contactId}`],
    );
    const convId = cv.rows[0]?.id
      ?? (await pool.query<{ id: string }>('select id from conversations where tenant_id = $1 and contact_id = $2', [tenantId, contactId])).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at)
       values ($1, 'in', 'text', 'une reponse', $2)`,
      [convId, at],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 8 });
    stats = new PgStatsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-engagements') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-engagements-autre') returning id`)).rows[0]!.id;
    campagneId = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, template_name, template_language, category, status)
       values ($1, 'itest', 'promo', 'fr', 'marketing', 'completed') returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [[tenantId, autreTenantId]]);
    await pool.end();
  });

  it('🔴 quelqu un qui a REPONDU sans cliquer est compté : c est le cas qui a fait naître cette mesure', async () => {
    const c = await destinataire('2026-09-01T10:00:00Z', '01');
    await repond(c, '2026-09-01T11:00:00Z');
    const m = await stats.engagementsParCampagne(tenantId, [campagneId]);
    expect(m.get(campagneId)).toBe(1);
  });

  it('🔴 et il ne compte QU UNE FOIS, même s il répond trois fois', async () => {
    // On compte des PERSONNES, pas des gestes : trois messages du même contact restent un engagé.
    const c = await destinataire('2026-09-02T10:00:00Z', '02');
    await repond(c, '2026-09-02T11:00:00Z');
    await repond(c, '2026-09-02T12:00:00Z');
    await repond(c, '2026-09-02T13:00:00Z');
    const m = await stats.engagementsParCampagne(tenantId, [campagneId]);
    // Le contact du cas précédent est toujours là : deux personnes engagées en tout.
    expect(m.get(campagneId)).toBe(2);
  });

  /**
   * 🔴 LA BORNE DE SEPT JOURS, ET ELLE SE COMPTE DEPUIS SON PROPRE ENVOI. Sans borne haute, toute
   * réponse ultérieure gonflerait le score d'une vieille campagne à chaque message reçu.
   */
  it('une réponse arrivée APRÈS sept jours ne compte pas', async () => {
    const avant = (await stats.engagementsParCampagne(tenantId, [campagneId])).get(campagneId) ?? 0;
    const c = await destinataire('2026-09-03T10:00:00Z', '03');
    await repond(c, '2026-09-11T10:00:00Z'); // huit jours plus tard
    const m = await stats.engagementsParCampagne(tenantId, [campagneId]);
    expect(m.get(campagneId)).toBe(avant);
  });

  it('mais une réponse au SIXIÈME jour compte encore', async () => {
    const avant = (await stats.engagementsParCampagne(tenantId, [campagneId])).get(campagneId) ?? 0;
    const c = await destinataire('2026-09-04T10:00:00Z', '04');
    await repond(c, '2026-09-10T09:00:00Z'); // six jours et 23 heures
    const m = await stats.engagementsParCampagne(tenantId, [campagneId]);
    expect(m.get(campagneId)).toBe(avant + 1);
  });

  /**
   * ⚠️ LA FENÊTRE SE COMPTE PAR DESTINATAIRE, PAS DEPUIS LE PREMIER ENVOI DE LA CAMPAGNE. Une campagne
   * étalée sur plusieurs jours perdrait sinon les réactions de ses derniers destinataires.
   */
  it('🔴 un destinataire envoyé TARD garde ses sept jours à lui', async () => {
    const avant = (await stats.engagementsParCampagne(tenantId, [campagneId])).get(campagneId) ?? 0;
    // Envoyé bien après les autres, il répond le lendemain de SON envoi.
    const c = await destinataire('2026-09-20T10:00:00Z', '05');
    await repond(c, '2026-09-21T10:00:00Z');
    const m = await stats.engagementsParCampagne(tenantId, [campagneId]);
    expect(m.get(campagneId)).toBe(avant + 1);
  });

  it('une réponse ARRIVÉE AVANT l envoi ne compte pas : elle n en découle pas', async () => {
    const avant = (await stats.engagementsParCampagne(tenantId, [campagneId])).get(campagneId) ?? 0;
    const c = await destinataire('2026-09-06T10:00:00Z', '06');
    await repond(c, '2026-09-06T09:00:00Z');
    const m = await stats.engagementsParCampagne(tenantId, [campagneId]);
    expect(m.get(campagneId)).toBe(avant);
  });

  it('une campagne sans aucun engagement est ABSENTE de la map, ce qui n est pas zéro', async () => {
    const vide = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, template_name, template_language, category, status)
       values ($1, 'itest-vide', 'promo', 'fr', 'marketing', 'completed') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const m = await stats.engagementsParCampagne(tenantId, [vide]);
    expect(m.has(vide)).toBe(false);
  });

  it('🔴 un AUTRE espace ne voit rien : tenant_id = $1 est le seul contrôle', async () => {
    const m = await stats.engagementsParCampagne(autreTenantId, [campagneId]);
    expect(m.size).toBe(0);
  });
});
