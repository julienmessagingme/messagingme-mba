import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { creerEcritParNosMachines } from '../../src/agent/nos-machines.pg';

/**
 * 🔴 DEUX AGENTS DE MESSAGING ME QUI SE RÉPONDENT (2026-10-30), sur une vraie base : la lecture qui reconnaît un message
 * écrit par la machine d'un autre espace. La démo a un numéro de l'API de Meta, newCompany un compte de l'application
 * relié par QR code, comme le soir du 30.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur l'ANCIENNE base de production. La CI monte
 * un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

const DEMO = '33100000247';
const NEWCO = '449990000304';

describe.skipIf(!url)('un message écrit par une machine d’un autre espace', () => {
  let pool: Pool;
  let inbox: PgInboxStore;
  let demo = '';
  let newco = '';
  let autre = '';

  // Un suffixe par exécution : un crash avant `afterAll` ne bloque pas la suivante sur les clés primaires.
  const sfx = Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    inbox = new PgInboxStore(pool);
    const espace = async (nom: string) => (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
    demo = await espace('itest-nos-machines-demo');
    newco = await espace('itest-nos-machines-newco');
    autre = await espace('itest-nos-machines-autre');
    await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'itest')`, [`itest-nos-machines-waba-${sfx}`, demo]);
    await pool.query(
      `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status) values ($1, $2, $3, '+33 1 00 00 02 47', 'CONNECTED')`,
      [`itest-nos-machines-pn-${sfx}`, demo, `itest-nos-machines-waba-${sfx}`],
    );
    // Un ancien titulaire du numéro de newCompany, retiré : il ne parle plus pour personne.
    await pool.query(`insert into comptes_application (tenant_id, numero, statut) values ($1, $2, 'retire')`, [autre, NEWCO]);
    await pool.query(`insert into comptes_application (tenant_id, numero, statut) values ($1, $2, 'relie')`, [newco, NEWCO]);
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [[demo, newco, autre]]);
    await pool.end();
  });

  it('🔴 la démo répond au message tapé à la main ; newCompany se tait devant la réponse de l’agent de la démo', async () => {
    const ecrit = creerEcritParNosMachines(pool);
    // Julien tape sur le téléphone de newCompany : l'écho l'enregistre `humain` dans newCompany.
    await inbox.recordOutboundByWaId(newco, DEMO, { body: 'Bonjour', messageId: null, type: 'text', origine: 'humain' });
    expect(await ecrit(demo, NEWCO)).toBe(false);
    // L'agent de la démo répond.
    await inbox.recordOutboundByWaId(demo, NEWCO, { body: 'Ha ha', messageId: null, type: 'text', origine: 'ia' });
    expect(await ecrit(newco, DEMO)).toBe(true);
    // Le dernier sortant de newCompany vers la démo reste celui tapé à la main.
    expect(await ecrit(demo, NEWCO)).toBe(false);
    // Un espace qui n'est pas la cible de ces messages n'en tire rien.
    expect(await ecrit(autre, DEMO)).toBe(false);
    expect(await ecrit(autre, NEWCO)).toBe(false);
  });

  it('un compte retiré ne fait pas de son ancien titulaire une machine qui écrit', async () => {
    const ecrit = creerEcritParNosMachines(pool);
    await inbox.recordOutboundByWaId(autre, DEMO, { body: 'Promo', messageId: null, type: 'text', origine: 'campagne' });
    // Le dernier sortant de newCompany vers la démo reste `humain` : la campagne de l'espace retiré ne compte pas.
    expect(await ecrit(demo, NEWCO)).toBe(false);
  });

  it('une réponse d’agent plus vieille que la fenêtre ne fait plus taire', async () => {
    const ecrit = creerEcritParNosMachines(pool);
    await pool.query(
      `update conversation_messages m set created_at = now() - interval '3 minutes'
         from conversations c where c.id = m.conversation_id and c.tenant_id = $1 and c.wa_id = $2`,
      [demo, NEWCO],
    );
    expect(await ecrit(newco, DEMO)).toBe(false);
  });

  it('un identifiant masqué n’est le numéro de personne', async () => {
    expect(await creerEcritParNosMachines(pool)(newco, '123456789@lid')).toBe(false);
  });
});
