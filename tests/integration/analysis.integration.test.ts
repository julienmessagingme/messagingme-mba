import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgConversationAnalysisStore } from '../../src/analysis/store.pg';
import { PgInboxStore } from '../../src/inbox/store.pg';
import type { ConversationAnalysis } from '../../src/analysis/schema';

const url = process.env.DATABASE_URL ?? '';

// Pièce 1 : réclamation atomique + fenêtre d'analyse + réouverture. Nécessite la migration 0027.
describe.skipIf(!url)('PgConversationAnalysisStore (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-analysis') returning id`)).rows[0]!.id;
    userId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'agent-itest-analysis@x.fr', 'agent', 'x') returning id`, [tenantId])).rows[0]!.id;
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const insertConv = async (waId: string, o: { ageMin?: number; status?: string; queuedAgeMin?: number } = {}): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, last_preview, analysis_status, analysis_queued_at)
       values ($1, $2, now() - make_interval(mins => $3), 'x', $4, case when $5::int is null then null else now() - make_interval(mins => $5) end)
       returning id`,
      [tenantId, waId, o.ageMin ?? 0, o.status ?? 'pending', o.queuedAgeMin ?? null],
    )).rows[0]!.id;

  it('claimForAnalysis : réclame le pending inactif, PAS le frais ni le done ; passe en queued', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const oldPending = await insertConv('33600100001', { ageMin: 60, status: 'pending' });
    const fresh = await insertConv('33600100002', { ageMin: 0, status: 'pending' });
    const done = await insertConv('33600100003', { ageMin: 60, status: 'done' });

    const claimed = await store.claimForAnalysis(25 * 60 * 1000, 100);
    const ids = claimed.map((c) => c.conversationId);
    expect(ids).toContain(oldPending);
    expect(ids).not.toContain(fresh);
    expect(ids).not.toContain(done);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [oldPending])).rows[0]!.analysis_status;
    expect(status).toBe('queued');
  });

  it('reclaimStaleQueued : ramène un queued bloqué en pending', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const stuck = await insertConv('33600100010', { status: 'queued', queuedAgeMin: 60 });
    const n = await store.reclaimStaleQueued(15 * 60 * 1000);
    expect(n).toBeGreaterThanOrEqual(1);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [stuck])).rows[0]!.analysis_status;
    expect(status).toBe('pending');
  });

  it('reclaimQueued : relâche UNE conversation queued en pending', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const stuck = await insertConv('33600100012', { status: 'queued', queuedAgeMin: 0 }); // fraîche : reclaimStaleQueued NE la prendrait pas
    await store.reclaimQueued(stuck);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [stuck])).rows[0]!.analysis_status;
    expect(status).toBe('pending');
  });

  it('reclaimQueued : ne piétine pas une conversation qui n\'est plus queued (garde)', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const done = await insertConv('33600100013', { status: 'done' });
    await store.reclaimQueued(done);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [done])).rows[0]!.analysis_status;
    expect(status).toBe('done'); // garde sur analysis_status='queued' -> le done reste done
  });

  it('getContext : messages + signaux (humain = sortant avec sender ; automatisé = sortant sans)', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100020');
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1,'in','text','Bonjour')`, [conv]);
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, sender_user_id) values ($1,'out','template','Promo', null)`, [conv]); // automatisé
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, sender_user_id) values ($1,'out','text','Réponse', $2)`, [conv, userId]); // humain
    const ctx = await store.getContext(conv);
    expect(ctx).not.toBeNull();
    expect(ctx!.messages).toHaveLength(3);
    expect(ctx!.signals).toEqual({ hasHumanOutbound: true, hasAutomated: true });
  });

  it('getContext : conversation inexistante -> null', async () => {
    const store = new PgConversationAnalysisStore(pool);
    expect(await store.getContext('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('save : upsert conversation_analysis + conversation done/analyzed_at', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100030', { status: 'queued' });
    const a: ConversationAnalysis = {
      sentiment: 'positif', intent: 'demande_devis', topic: 'devis', resolved: false, entities: { quantite: 50 },
      action_suggestion: 'creer_devis', confidence: 0.9, justification: 'veut un devis', handled_by: 'humain', exchanges_count: 3,
    };
    await store.save(conv, tenantId, a, { provider: 'anthropic', model: 'claude-haiku-4-5' }, new Date().toISOString());
    const row = (await pool.query<{ intent: string; handled_by: string; llm_model: string }>(`select intent, handled_by, llm_model from conversation_analysis where conversation_id = $1`, [conv])).rows[0]!;
    expect(row).toMatchObject({ intent: 'demande_devis', handled_by: 'humain', llm_model: 'claude-haiku-4-5' });
    const convRow = (await pool.query<{ analysis_status: string; analyzed_at: Date | null }>(`select analysis_status, analyzed_at from conversations where id = $1`, [conv])).rows[0]!;
    expect(convRow.analysis_status).toBe('done'); // aucun message plus récent -> done
    expect(convRow.analyzed_at).not.toBeNull();
    // Upsert : une 2e sauvegarde remplace, pas de doublon.
    await store.save(conv, tenantId, { ...a, intent: 'sav' }, { provider: 'anthropic', model: 'm2' }, new Date().toISOString());
    const cnt = (await pool.query<{ n: string }>(`select count(*)::int as n from conversation_analysis where conversation_id = $1`, [conv])).rows[0]!.n;
    expect(Number(cnt)).toBe(1);
  });

  it('save : un message postérieur à la borne repasse la conversation en pending (course d\'analyse)', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100035', { status: 'queued' });
    // message arrivé PENDANT l'analyse (created_at = maintenant), donc postérieur à la borne passée à save
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1,'in','text','arrivé pendant analyse')`, [conv]);
    const windowEnd = new Date(Date.now() - 60_000).toISOString(); // borne = il y a 1 min (avant l'insertion du message)
    const a: ConversationAnalysis = {
      sentiment: 'neutre', intent: 'information', topic: 'x', resolved: true, entities: {},
      action_suggestion: 'aucune', confidence: 0.5, justification: 'x', handled_by: 'automatise', exchanges_count: 0,
    };
    await store.save(conv, tenantId, a, { provider: 'anthropic', model: 'm' }, windowEnd);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [conv])).rows[0]!.analysis_status;
    expect(status).toBe('pending'); // repris au prochain sweep au lieu d'être enterré sous une borne now()
  });

  it('save : borne = created_at MICROSECONDE exact du dernier message -> done, PAS de boucle de réanalyse', async () => {
    // Régression : un round-trip created_at via Date JS tronque aux ms -> la borne retombe sous le dernier message
    // (µs non nuls) qui repasse `> borne` -> réanalyse en boucle. windowEnd doit être la chaîne texte exacte.
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100037', { status: 'queued' });
    // created_at avec des microsecondes NON nulles (le cas qui piégeait la version Date)
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1,'in','text','micros', '2026-07-12 14:04:28.611789+00')`, [conv]);
    const ctx = await store.getContext(conv);
    expect(ctx!.windowEnd).not.toBeNull();
    const a: ConversationAnalysis = {
      sentiment: 'neutre', intent: 'information', topic: 'x', resolved: true, entities: {},
      action_suggestion: 'aucune', confidence: 0.5, justification: 'x', handled_by: 'automatise', exchanges_count: 1,
    };
    await store.save(conv, tenantId, a, { provider: 'anthropic', model: 'm' }, ctx!.windowEnd ?? null);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [conv])).rows[0]!.analysis_status;
    expect(status).toBe('done'); // borne µs-exacte : le dernier message n'est PAS > borne
  });

  it('réouverture : un nouvel inbound sur une conversation done repasse en pending', async () => {
    const inbox = new PgInboxStore(pool);
    const waId = '33600100040';
    await insertConv(waId, { status: 'done' });
    await inbox.recordInbound(tenantId, { waId, phoneNumberId: 'pn', body: 'Encore une question', type: 'text', buttonPayload: null, messageId: 'wamid-REOPEN', profileName: null });
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where tenant_id = $1 and wa_id = $2`, [tenantId, waId])).rows[0]!.analysis_status;
    expect(status).toBe('pending');
  });
});
