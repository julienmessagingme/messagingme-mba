import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { PgRcsMessageStore } from '../../src/rcs/message-store.pg';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import { formaterSuiviEnvoi } from '../../src/api/suivi-envoi';
import { PREFIXE_ENVOI_API } from '../../src/api/cible-rcs';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE CONSENTEMENT D'UN RCS LIBRE ENVOYÉ PAR UNE MACHINE (spec 2026-09-24, § 4) : « opted_in OU nous a déjà
 * écrit ». En intégration parce que « a écrit » est une requête sur les messages entrants du fil. Jamais en local.
 */
describe.skipIf(!url)('RCS libre : lectures de fiche (Postgres)', () => {
  let pool: Pool;
  let store: PgContactStore;
  let tenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    store = new PgContactStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-rcs-libre') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  const fiche = async (phone: string, optIn: 'opted_in' | 'unknown'): Promise<string> =>
    (await pool.query<{ id: string }>(`insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, $3) returning id`, [tenantId, phone, optIn])).rows[0]!.id;
  const fil = async (waId: string, direction: 'in' | 'out'): Promise<void> => {
    const conv = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) on conflict (tenant_id, wa_id) do update set wa_id = excluded.wa_id returning id`,
      [tenantId, waId],
    );
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1, $2, 'text', 'x')`, [conv.rows[0]!.id, direction]);
  };

  it('🔴 les quatre cas du consentement d’une machine', async () => {
    await fiche('+33600000701', 'opted_in');
    await fiche('+33600000702', 'unknown');
    await fil('33600000702', 'in');
    await fiche('+33600000703', 'unknown');
    await fiche('+33600000704', 'unknown');
    await fil('33600000704', 'out');
    expect(await store.aConsentiOuEcritParWaId(tenantId, '33600000701')).toBe(true);   // consenti, jamais écrit
    expect(await store.aConsentiOuEcritParWaId(tenantId, '33600000702')).toBe(true);   // a écrit, sans consentement
    expect(await store.aConsentiOuEcritParWaId(tenantId, '33600000703')).toBe(false);  // ni l'un ni l'autre
    expect(await store.aConsentiOuEcritParWaId(tenantId, '33600000704')).toBe(false);  // on lui a écrit, lui non
    expect(await store.aConsentiOuEcritParWaId(tenantId, '33600000799')).toBe(false);  // aucune fiche
  });

  it('etatPourEnvoi : le numéro et le blocage, rien pour une fiche supprimée ou d’un autre espace', async () => {
    const id = await fiche('+33600000705', 'unknown');
    expect(await store.etatPourEnvoi(tenantId, id)).toEqual({ phoneE164: '+33600000705', bloque: false });
    await pool.query('update contacts set blocked_at = now() where id = $1', [id]);
    expect(await store.etatPourEnvoi(tenantId, id)).toEqual({ phoneE164: '+33600000705', bloque: true });
    await pool.query('update contacts set deleted_at = now() where id = $1', [id]);
    expect(await store.etatPourEnvoi(tenantId, id)).toBeNull();
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-rcs-libre-2') returning id`)).rows[0]!.id;
    try {
      expect(await store.etatPourEnvoi(autre, await fiche('+33600000706', 'unknown'))).toBeNull();
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });

  it('getByName : le message par son nom exact, jamais un message supprimé ni celui d’un autre espace', async () => {
    const messages = new PgRcsMessageStore(pool);
    const cree = await messages.create(tenantId, 'relance-panier', { kind: 'text', text: 'Bonjour' });
    expect((await messages.getByName(tenantId, 'relance-panier'))?.id).toBe(cree.id);
    expect(await messages.getByName(tenantId, 'Relance-panier')).toBeNull();
    expect(await messages.getByName('00000000-0000-0000-0000-000000000000', 'relance-panier')).toBeNull();
    await messages.remove(tenantId, cree.id);
    expect(await messages.getByName(tenantId, 'relance-panier')).toBeNull();
  });

  it('🔴 lireEnvoiApi rend le NOM entier et le CANAL d’un envoi RCS, et le suivi en fait une cible rcsMessage', async () => {
    const repo = new PgCampaignRepo(pool);
    const nom = 'x'.repeat(120);
    const { campaignId } = await repo.createWithRecipients(
      {
        tenantId, phoneNumberId: '', name: `${PREFIXE_ENVOI_API}${nom}`, category: 'utility',
        templateName: '', templateLanguage: '', paramMapping: [],
        channel: 'rcs', rcsAgentId: 'itest-agent', rcsMessage: { kind: 'text', text: 'Bonjour' },
      },
      [],
    );
    const lu = await repo.lireEnvoiApi(campaignId, tenantId);
    // `templateName` vaut '' et non null : c'est ce qui rend l'ordre de `cibleDe` obligatoire.
    expect(lu).toMatchObject({ name: `${PREFIXE_ENVOI_API}${nom}`, channel: 'rcs', templateName: '', workflowCode: null });
    expect(formaterSuiviEnvoi(lu!)).toMatchObject({ target: { rcsMessage: nom }, opening: 'rcs' });
  });
});
