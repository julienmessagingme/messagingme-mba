import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { PgInboxStore } from '../../src/inbox/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES DEUX LECTURES DES CHAMPS SYSTÈME DU BLOC CONDITION (RC5), contre un VRAI Postgres.
 *
 * Ce qu'un faux magasin ne peut pas dire : que « le dernier message reçu » est bien le dernier ENTRANT (un envoi plus
 * récent de notre part ne compte pas, une réaction non plus), que la langue est lue sur la MÊME fiche que celle du
 * bloc Condition (`MATCH_BY_WAID_SQL`), et que ni l'une ni l'autre ne franchit la frontière d'un espace.
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION) : joué par le job `integration`.
 */
describe.skipIf(!url)('champs système du bloc Condition (Postgres)', () => {
  let pool: Pool;
  let contacts: PgContactStore;
  let inbox: PgInboxStore;
  let tenantId: string;
  let autreTenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    contacts = new PgContactStore(pool);
    inbox = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-condition-systeme') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-condition-systeme-autre') returning id`)).rows[0]!.id;
  });
  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('🔴 la date du dernier message REÇU : le dernier entrant, ni un envoi plus récent, ni une réaction', async () => {
    const waId = '33600300001';
    expect(await inbox.dateDernierMessageRecu(tenantId, waId)).toBeNull(); // jamais écrit : aucune date inventée
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) returning id`, [tenantId, waId],
    )).rows[0]!.id;
    const ecrire = async (direction: string, type: string, il_y_a_heures: number) => pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at)
       values ($1, $2, $3, 'x', now() - ($4 || ' hours')::interval)`,
      [conv, direction, type, String(il_y_a_heures)],
    );
    await ecrire('in', 'text', 72); // le plus ancien
    await ecrire('in', 'text', 48); // LE dernier message reçu
    await ecrire('in', 'reaction', 24); // un pouce levé n'est pas un retour du contact
    await ecrire('out', 'text', 1); // notre envoi, plus récent, ne compte pas
    const recu = await inbox.dateDernierMessageRecu(tenantId, waId);
    expect(recu).toBeInstanceOf(Date);
    const heures = (Date.now() - recu!.getTime()) / 3_600_000;
    expect(heures).toBeGreaterThan(47);
    expect(heures).toBeLessThan(49);
    // Le même numéro dans un autre espace ne voit rien.
    expect(await inbox.dateDernierMessageRecu(autreTenantId, waId)).toBeNull();
  });

  it('la langue détectée de la fiche, `null` tant qu’elle n’est pas apprise, jamais celle d’un autre espace', async () => {
    await pool.query(`insert into contacts (tenant_id, phone_e164, langue_detectee) values ($1, '+33600300002', 'es')`, [tenantId]);
    await pool.query(`insert into contacts (tenant_id, phone_e164) values ($1, '+33600300003')`, [tenantId]);
    await pool.query(`insert into contacts (tenant_id, phone_e164, langue_detectee) values ($1, '+33600300003', 'de')`, [autreTenantId]);
    expect(await contacts.langueDetecteeParWaId(tenantId, '33600300002')).toBe('es');
    expect(await contacts.langueDetecteeParWaId(tenantId, '33600300003')).toBeNull();
    expect(await contacts.langueDetecteeParWaId(tenantId, '33600399999')).toBeNull(); // contact inconnu
    expect(await contacts.langueDetecteeParWaId(autreTenantId, '33600300003')).toBe('de');
  });
});
