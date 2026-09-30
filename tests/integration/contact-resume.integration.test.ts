import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgConversationAnalysisStore } from '../../src/analysis/store.pg';
import { PgContactHistoryStore } from '../../src/crm/contact-history.pg';
import type { ConversationAnalysis } from '../../src/analysis/schema';

const url = process.env.DATABASE_URL ?? '';

/**
 * LA FICHE D'UN CONTACT : SA DERNIÈRE ANALYSE ET SON RÉSUMÉ, contre un VRAI Postgres (Tout sur la fiche, lot 1).
 *
 * Ce qu'un double ne peut pas dire : que la copie écrite par `save` revient bien par la route de la fiche, que le
 * résumé vient de la MÊME analyse que les codes, que la mention « périmée » compare des messages et non
 * `last_message_at`, qu'une fiche analysée avant 0196 garde son résumé, et que la copie survit à la conversation.
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION) : joué par le job `integration`.
 */
describe.skipIf(!url)('résumé et dernière analyse de la fiche (Postgres)', () => {
  let pool: Pool;
  let analyses: PgConversationAnalysisStore;
  let fiches: PgContactHistoryStore;
  let tenantId: string;
  let autreTenantId: string;

  const base: ConversationAnalysis = {
    sentiment: 'negatif', intent: 'reclamation', topic: 'colis abîmé', resolved: false, entities: {},
    action_suggestion: 'rappeler', confidence: 0.8, justification: 'j', handled_by: 'humain', exchanges_count: 2,
    abusive: false, satisfaction: 0, urgence: 9, summary: 'Le colis est arrivé abîmé, le client veut un échange.',
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    analyses = new PgConversationAnalysisStore(pool);
    fiches = new PgContactHistoryStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-resume-fiche') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-resume-fiche-autre') returning id`)).rows[0]!.id;
  });
  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  const contact = async (phone: string): Promise<string> =>
    (await pool.query<{ id: string }>(`insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`, [tenantId, phone])).rows[0]!.id;
  const fil = async (waId: string, contactId: string): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, analysis_status) values ($1, $2, $3, 'queued') returning id`,
      [tenantId, waId, contactId],
    )).rows[0]!.id;
  const message = async (conv: string, body: string): Promise<void> => {
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', $2)`, [conv, body]);
  };
  /** Analyse le fil comme le job : la borne est le created_at EXACT du dernier message (texte, µs). */
  const analyser = async (conv: string, a: ConversationAnalysis = base): Promise<void> => {
    const ctx = await analyses.getContext(conv);
    await analyses.save(conv, tenantId, a, { provider: 'anthropic', model: 'm' }, ctx!.windowEnd ?? null);
  };

  it('🔴 la dernière analyse revient par la fiche, une note à 0 comprise, avec le résumé de la MÊME analyse', async () => {
    const c = await contact('+33600100301');
    const conv = await fil('33600100301', c);
    await message(conv, 'mon colis est abîmé');
    await analyser(conv);
    const r = await fiches.resumeContact(tenantId, c);
    expect(r?.derniereAnalyse).toMatchObject({
      intention: 'reclamation', sentiment: 'negatif', satisfaction: 0, urgence: 9, resolue: false, sujet: 'colis abîmé',
      traiteePar: 'humain', action: 'rappeler', perimee: false,
    });
    expect(r).toMatchObject({ texte: base.summary, conversationId: conv, analysee: true });
  });

  it('🔴 un message plus récent que la borne rend la copie « périmée », jamais avant', async () => {
    const c = await contact('+33600100302');
    const conv = await fil('33600100302', c);
    await message(conv, 'premier');
    await analyser(conv);
    expect((await fiches.resumeContact(tenantId, c))?.derniereAnalyse?.perimee).toBe(false);
    await message(conv, 'et encore une chose');
    expect((await fiches.resumeContact(tenantId, c))?.derniereAnalyse?.perimee).toBe(true);
  });

  it('🔴 une fiche analysée AVANT 0196 (sans copie) garde son résumé, sans dernière analyse', async () => {
    const c = await contact('+33600100303');
    const conv = await fil('33600100303', c);
    await pool.query(
      `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
         exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model, summary)
       values ($1, $2, 'neutre', 'information', 'horaires', true, 'automatise', 1, 'aucune', 0.9, 'j', 'test', 'test', 'Il demandait les horaires.')`,
      [conv, tenantId],
    );
    const r = await fiches.resumeContact(tenantId, c);
    expect(r).toMatchObject({ texte: 'Il demandait les horaires.', conversationId: conv, derniereAnalyse: null });
  });

  it('🔴 la conversation effacée : la dernière analyse RESTE, le résumé part avec elle', async () => {
    const c = await contact('+33600100304');
    const conv = await fil('33600100304', c);
    await message(conv, 'bonjour');
    await analyser(conv);
    await pool.query(`delete from conversations where id = $1`, [conv]);
    const r = await fiches.resumeContact(tenantId, c);
    expect(r).toMatchObject({ texte: null, conversations: 0 });
    expect(r?.derniereAnalyse).toMatchObject({ intention: 'reclamation', sentiment: 'negatif', perimee: false });
  });

  it('🔴 deux fils : le résumé vient du fil que la COPIE désigne, pas du plus récent par last_message_at', async () => {
    // Le fil A porte la copie (son analyse couvre les messages les plus récents du contact). Le fil B a un
    // last_message_at plus récent et une analyse posée à la main (plus ancienne en messages) : la règle d'avant la
    // copie prendrait B. Sans la clause « id = analyse_conversation_id », ce test tombe.
    const c = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, bsuid) values ($1, '+33600100306', 'itest-bsuid-306') returning id`, [tenantId],
    )).rows[0]!.id;
    const a = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, analysis_status, last_message_at)
       values ($1, '33600100306', $2, 'queued', now() - interval '2 hours') returning id`, [tenantId, c],
    )).rows[0]!.id;
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1, 'in', 'text', 'a', now() - interval '2 hours')`, [a]);
    await analyser(a, { ...base, summary: 'Résumé du fil A.' });
    const b = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, analysis_status, last_message_at)
       values ($1, 'itest-bsuid-306', $2, 'done', now()) returning id`, [tenantId, c],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
         exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model, summary)
       values ($1, $2, 'positif', 'achat', 'b', true, 'automatise', 1, 'aucune', 0.9, 'j', 'test', 'test', 'Résumé du fil B.')`,
      [b, tenantId],
    );
    const r = await fiches.resumeContact(tenantId, c);
    expect(r).toMatchObject({ texte: 'Résumé du fil A.', conversationId: a, conversations: 2 });
    expect(r?.derniereAnalyse).toMatchObject({ intention: 'reclamation' });
  });

  it('🔴 la fiche d’un autre espace n’est jamais rendue', async () => {
    const c = await contact('+33600100305');
    expect(await fiches.resumeContact(autreTenantId, c)).toBeNull();
  });
});
