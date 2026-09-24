import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgConversationStatsStore } from '../../src/stats/conversation-stats.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * « RÉPONDU PAR » : UN MESSAGE DE L'API NE RÉPOND QUE S'IL SUIT UN ENTRANT DU FIL (décision de Julien du
 * 2026-09-24, lot 3 de l'API publique). La décision est testée en unitaire (`originesQuiRepondent`,
 * `tests/web-qui-a-repondu-parite.test.ts`) ; ici, que la LECTURE lui donne les bons instants, sur une vraie
 * base. Jamais joué en local.
 */
describe.skipIf(!url)('listAnalyzed : les origines qui répondent (Postgres)', () => {
  let pool: Pool;
  let tenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-repondu-par') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  /** Un fil, ses messages dans l'ordre donné (une minute d'écart), et une analyse. Rend l'id du fil. */
  async function fil(waId: string, messages: Array<{ direction: 'in' | 'out'; origine?: string }>): Promise<string> {
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, $2, now()) returning id`,
      [tenantId, waId],
    )).rows[0]!.id;
    for (const [i, m] of messages.entries()) {
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, type, body, origin, created_at)
         values ($1, $2, 'text', 'x', $3, now() - interval '1 hour' + ($4 * interval '1 minute'))`,
        [conv, m.direction, m.direction === 'out' ? m.origine ?? null : null, i],
      );
    }
    await pool.query(
      `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
         exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model)
       values ($1, $2, 'neutre', 'autre', 'sujet', false, 'humain', 2, 'aucune', 0.8, 'test', 'anthropic', 'm')`,
      [conv, tenantId],
    );
    return conv;
  }

  it('🔴 l’API seule, ou avant le client : aucune origine `api` ; après un entrant : `api`', async () => {
    const seule = await fil('33690000701', [{ direction: 'out', origine: 'api' }]);
    const avant = await fil('33690000702', [{ direction: 'out', origine: 'api' }, { direction: 'in' }]);
    const apres = await fil('33690000703', [{ direction: 'in' }, { direction: 'out', origine: 'api' }]);
    const humain = await fil('33690000704', [{ direction: 'out', origine: 'humain' }]);
    const store = new PgConversationStatsStore(pool, true, 365);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const range = { from: iso(new Date(Date.now() - 86_400_000)), to: iso(new Date(Date.now() + 86_400_000)) };
    const lignes = await store.listAnalyzed(tenantId, range, {});
    const origines = (id: string) => lignes.find((l) => l.conversationId === id)?.origines;
    expect(origines(seule)).toEqual([]);
    expect(origines(avant)).toEqual([]);
    expect(origines(apres)).toEqual(['api']);
    // Ancre : une autre origine passe sans entrant.
    expect(origines(humain)).toEqual(['humain']);
  });
});
