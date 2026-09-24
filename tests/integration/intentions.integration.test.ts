import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgConversationAnalysisStore } from '../../src/analysis/store.pg';
import { PgConversationStatsStore } from '../../src/stats/conversation-stats.pg';
import type { ConversationAnalysis } from '../../src/analysis/schema';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES INTENTIONS DE COMMERCE EN LIGNE, CONTRE UN VRAI POSTGRES (lot 5 de l'API publique).
 *
 * 🔴 POURQUOI EN INTÉGRATION : `tests/intentions-parite.test.ts` relit le TEXTE des migrations, il ne peut
 * pas dire que la base, une fois tout appliqué, accepte vraiment `achat`. Ici l'écriture passe par le VRAI
 * chemin (`PgConversationAnalysisStore.save`), celui du job d'analyse.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('les intentions de commerce en ligne, en base', () => {
  let pool: Pool;
  let tenantId: string;
  let numero = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-intentions-commerce') returning id`)).rows[0]!.id;
  });
  afterAll(async () => {
    // Les conversations et leurs analyses partent en cascade avec l'espace.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const conversation = async (): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, analysis_status) values ($1, $2, now(), 'queued') returning id`,
      [tenantId, `3361700${String(++numero).padStart(4, '0')}`],
    )).rows[0]!.id;

  const base: ConversationAnalysis = {
    sentiment: 'neutre', intent: 'achat', topic: 'commande pack pro', resolved: false, entities: {},
    action_suggestion: 'rappeler', confidence: 0.8, justification: 'veut commander', handled_by: 'humain',
    exchanges_count: 2, abusive: false,
  };

  it('🔴 le CHECK accepte les trois intentions neuves, par le VRAI chemin d’écriture', async () => {
    const store = new PgConversationAnalysisStore(pool);
    for (const intent of ['achat', 'suivi_commande', 'retour'] as const) {
      const c = await conversation();
      await store.save(c, tenantId, { ...base, intent }, { provider: 'itest', model: 'itest' }, new Date().toISOString());
      const lu = await pool.query<{ intent: string }>('select intent from conversation_analysis where conversation_id = $1', [c]);
      expect(lu.rows[0]?.intent, intent).toBe(intent);
    }
  });

  it('⚠️ le CHECK reste un CHECK : une valeur hors liste est toujours refusée', async () => {
    // Élargir ne doit pas vouloir dire retirer : sans contrainte, une sortie de modèle mal validée
    // écrirait n'importe quoi, et les compteurs par intention cesseraient de retomber sur le total.
    const c = await conversation();
    await expect(pool.query(
      `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
         exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model)
       values ($1, $2, 'neutre', 'nawak', 's', true, 'humain', 1, 'aucune', 0.5, 'j', 'itest', 'itest')`,
      [c, tenantId],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('🔴 la synthèse, la liste filtrée et l’agrégat du jour comptent les intentions neuves', async () => {
    // Dépend du premier cas, qui a écrit une analyse de chaque intention neuve (les cas d'un fichier
    // s'exécutent dans l'ordre). Plage hier..demain : les analyses datent de `now()`, aucun bord de fuseau.
    const stats = new PgConversationStatsStore(pool, true, 90);
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    const plage = { from: iso(new Date(Date.now() - 86_400_000)), to: iso(new Date(Date.now() + 86_400_000)) };

    const s = await stats.getSummary(tenantId, plage);
    expect(s.intent).toMatchObject({ achat: 1, suivi_commande: 1, retour: 1 });

    const liste = await stats.listAnalyzed(tenantId, plage, { intent: 'suivi_commande' });
    expect(liste.map((l) => l.intent)).toEqual(['suivi_commande']);

    await stats.ecrireAgregats(plage, tenantId);
    const jours = await pool.query<{ conversations: number; intentions: Record<string, number> }>(
      'select conversations, intentions from analyse_jour where tenant_id = $1', [tenantId],
    );
    const total = jours.rows.reduce((t, r) => t + r.conversations, 0);
    const reparties = jours.rows.reduce((t, r) => t + Object.values(r.intentions).reduce((a, b) => a + b, 0), 0);
    // L'invariant que l'agrégat promet : sa répartition par intention retombe EXACTEMENT sur son total.
    expect(reparties, 'la répartition par intention ne retombe pas sur le total du jour').toBe(total);
    expect(jours.rows.reduce((t, r) => t + (r.intentions['achat'] ?? 0), 0)).toBe(1);
  });
});
