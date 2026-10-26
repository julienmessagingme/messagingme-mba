import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgPassagesHubspot, occasionRelance } from '../../src/analysis/passages-hubspot';

const url = process.env.DATABASE_URL ?? '';

// Lot 2b de la reprise humaine (migration 0254) : quand un passage poussé à HubSpot est clos, et quand une relance est due.
describe.skipIf(!url)('PgPassagesHubspot (passages_hubspot)', () => {
  let pool: Pool;
  let store: PgPassagesHubspot;
  let tenantId: string;
  let sansHubspot: string;
  const conv = async (tenant: string, waId: string, over: { owner?: string; escaladee?: string | null; dernier?: 'in' | 'out'; il?: string } = {}) =>
    (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, control_owner, escaladee_le, last_direction, last_message_at)
       values ($1, $2, $3, $4::timestamptz, $5, now() - $6::interval) returning id`,
      [tenant, waId, over.owner ?? 'app_human', over.escaladee ?? null, over.dernier ?? 'in', over.il ?? '20 minutes'],
    )).rows[0]!.id;
  const message = (convId: string, direction: 'in' | 'out', origin: string | null, il: string) => pool.query(
    `insert into conversation_messages (conversation_id, direction, type, body, origin, created_at) values ($1, $2, 'text', 'x', $3, now() - $4::interval)`,
    [convId, direction, origin, il],
  );

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgPassagesHubspot(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-passages') returning id`)).rows[0]!.id;
    sansHubspot = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-passages-sans') returning id`)).rows[0]!.id;
    await pool.query(
      `insert into tenant_settings (tenant_id, hubspot_choix_valide_le) values ($1, now())
       on conflict (tenant_id) do update set hubspot_choix_valide_le = now()`,
      [tenantId],
    );
  });
  afterAll(async () => {
    for (const t of [tenantId, sansHubspot]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('inscrire est idempotent ; clore pose clos_le une fois', async () => {
    const c = await conv(tenantId, '33600000101', { escaladee: '2026-10-26T12:00:00Z' });
    const p = { occasion: `${c}:a`, tenantId, conversationId: c, nature: 'escalade' as const, depuis: new Date('2026-10-26T12:00:00Z') };
    expect(await store.inscrire(p)).toBe(true);
    expect(await store.inscrire(p)).toBe(false);
    await store.clore(p.occasion);
    await store.clore(p.occasion);
    const r = await pool.query(`select clos_le from passages_hubspot where occasion = $1`, [p.occasion]);
    expect(r.rows[0]!.clos_le).not.toBeNull();
  });

  it('🔴 décision A : une escalade est close quand escaladee_le est vidée ou remplacée par une plus récente, pas avant', async () => {
    const ouverte = await conv(tenantId, '33600000102', { escaladee: '2026-10-26T12:00:00Z' });
    const videe = await conv(tenantId, '33600000103', { escaladee: null });
    const remplacee = await conv(tenantId, '33600000104', { escaladee: '2026-10-26T13:00:00Z' });
    for (const [c, s] of [[ouverte, 'o'], [videe, 'v'], [remplacee, 'r']] as const) {
      await store.inscrire({ occasion: `${c}:${s}`, tenantId, conversationId: c, nature: 'escalade', depuis: new Date('2026-10-26T12:00:00Z') });
    }
    const aClore = (await store.aClore(500)).map((p) => p.occasion);
    expect(aClore).toContain(`${videe}:v`);
    expect(aClore).toContain(`${remplacee}:r`);
    expect(aClore).not.toContain(`${ouverte}:o`);
  });

  it('🔴 une escalade posée par now() (à la microseconde), relue en Date (à la milliseconde) : son passage reste OUVERT', async () => {
    const c = await conv(tenantId, '33600000115');
    await pool.query('update conversations set escaladee_le = now() where id = $1', [c]);
    // Ce que fait push-handoff : relire l escalade (getEtatPassage, une Date JS) et l inscrire comme depuis.
    const lue = (await pool.query<{ e: Date }>('select escaladee_le as e from conversations where id = $1', [c])).rows[0]!.e;
    await store.inscrire({ occasion: `${c}:${lue.toISOString()}`, tenantId, conversationId: c, nature: 'escalade', depuis: lue });
    expect((await store.aClore(500)).map((p) => p.conversationId)).not.toContain(c);
  });

  it('un refus reporte le passage d une heure : il sort de la tête de file', async () => {
    const c = await conv(tenantId, '33600000116', { escaladee: null });
    await store.inscrire({ occasion: `${c}:r`, tenantId, conversationId: c, nature: 'escalade', depuis: new Date('2026-10-26T12:00:00Z') });
    expect((await store.aClore(500)).map((p) => p.occasion)).toContain(`${c}:r`);
    await store.reporter(`${c}:r`);
    expect((await store.aClore(500)).map((p) => p.occasion)).not.toContain(`${c}:r`);
  });

  it('🔴 décision C : une relance est close par une réponse d’une personne, pas par un robot ni une campagne', async () => {
    const depuis = new Date(Date.now() - 20 * 60_000);
    const humain = await conv(tenantId, '33600000105');
    const campagne = await conv(tenantId, '33600000106');
    const reprise = await conv(tenantId, '33600000107', { owner: 'mba' });
    await message(humain, 'out', 'humain', '5 minutes');
    await message(campagne, 'out', 'campagne', '5 minutes');
    for (const c of [humain, campagne, reprise]) {
      await store.inscrire({ occasion: occasionRelance(c, depuis), tenantId, conversationId: c, nature: 'relance', depuis });
    }
    const aClore = (await store.aClore(500)).map((p) => p.conversationId);
    expect(aClore).toContain(humain);
    expect(aClore).toContain(reprise);
    expect(aClore).not.toContain(campagne);
  });

  it('🔴 décision C : une relance est due après N minutes, sur un espace HubSpot, une fois par message, jamais sous escalade', async () => {
    const due = await conv(tenantId, '33600000108', { il: '15 minutes' });
    const tropTot = await conv(tenantId, '33600000109', { il: '2 minutes' });
    const escaladee = await conv(tenantId, '33600000110', { escaladee: '2026-10-26T12:00:00Z', il: '15 minutes' });
    const repondue = await conv(tenantId, '33600000111', { dernier: 'out', il: '15 minutes' });
    const robot = await conv(tenantId, '33600000112', { owner: 'mba', il: '15 minutes' });
    const horsHubspot = await conv(sansHubspot, '33600000113', { il: '15 minutes' });
    const vieille = await conv(tenantId, '33600000114', { il: '30 hours' });
    const ids = (await store.relancesDues(10, 500)).map((r) => r.conversationId);
    expect(ids).toContain(due);
    for (const c of [tropTot, escaladee, repondue, robot, horsHubspot, vieille]) expect(ids).not.toContain(c);
    // Inscrite pour ce message : plus due, jusqu'au prochain message du client.
    const r = (await store.relancesDues(10, 500)).find((x) => x.conversationId === due)!;
    await store.inscrire({ occasion: occasionRelance(due, r.depuis), tenantId, conversationId: due, nature: 'relance', depuis: r.depuis });
    expect((await store.relancesDues(10, 500)).map((x) => x.conversationId)).not.toContain(due);
  });
});
