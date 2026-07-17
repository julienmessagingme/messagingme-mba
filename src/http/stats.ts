import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { DashboardStats, TemplateBreakdownRow, CampaignFunnel, ErrorBreakdownRow, CostFilter } from '../stats/store.pg';
import type { CostSeries } from '../stats/cost';
import type { PricingSummary } from '../meta/pricing';
import { parseRange } from '../stats/range';
import type { DateRange } from '../stats/range';
import type { ConversationAnalysisSummary, AnalyzedConversationRow, AnalyzedConversationsFilter } from '../stats/conversation-stats.pg';

// Valeurs d'enum admises pour les filtres de la liste quali (miroir de src/analysis/schema.ts). On ne passe au
// store QUE des valeurs valides -> pas d'injection de filtre arbitraire, et le NULL = « pas de filtre ».
const SENTIMENTS = new Set(['positif', 'neutre', 'negatif']);
const INTENTS = new Set(['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre']);
const ACTIONS = new Set(['creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune']);
const inSet = (s: Set<string>, v: unknown): string | undefined => (typeof v === 'string' && s.has(v) ? v : undefined);

export interface StatsRouteDeps {
  getDashboard(tenantId: string, range: DateRange): Promise<DashboardStats>;
  /** Volume par template envoyé (dropdown dashboard). */
  getTemplateBreakdown(tenantId: string, range: DateRange): Promise<TemplateBreakdownRow[]>;
  /** Prix Meta (pricing_analytics) par catégorie ; null si indisponible (le front affiche le volume seul). */
  getPricing(tenantId: string, range: DateRange): Promise<PricingSummary | null>;
  /** Funnel d'UNE campagne : envoyés -> délivrés -> lus -> répondus + échecs. */
  getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel>;
  /** Breakdown des codes d'erreur Meta sur la plage (campagnes du tenant), filtrable par template. */
  getErrorBreakdown(tenantId: string, range: DateRange, templateName?: string): Promise<ErrorBreakdownRow[]>;
  /** Série de coût estimé/jour, filtrable par campagne ou template. */
  getCostSeries(tenantId: string, range: DateRange, filter: CostFilter): Promise<CostSeries>;
  /** Agrégats d'analyse de conversation (Pièce 1) sur la plage. */
  getConversationSummary(tenantId: string, range: DateRange): Promise<ConversationAnalysisSummary>;
  /** Liste des dernières conversations analysées (quali), filtrable. */
  listAnalyzedConversations(tenantId: string, range: DateRange, filters: AnalyzedConversationsFilter): Promise<AnalyzedConversationRow[]>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/** Stats du dashboard (séries 1 pt/jour). Groupe admin-only (guard passé par server.ts). Plage de dates
 *  via ?from&?to (YYYY-MM-DD, Europe/Paris) ou repli ?days= ; invalide/futur/span>366 -> 400. */
export function registerStats(app: FastifyInstance, deps: StatsRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/stats', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getDashboard(tenant, r.range));
  });

  // Breakdown par template + prix Meta (pricing_analytics). Séparé de /stats : peut appeler Meta
  // (plus lent) et n'est chargé que par la section « Templates envoyés » du dashboard.
  app.get('/tenants/:tenantId/stats/templates', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const [breakdown, pricing] = await Promise.all([deps.getTemplateBreakdown(tenant, r.range), deps.getPricing(tenant, r.range)]);
    return reply.code(200).send({ breakdown, pricing });
  });

  // Funnel d'UNE campagne (envoyés/délivrés/lus/répondus). ?campaignId=... requis. Pas de plage
  // (le funnel porte sur toute la campagne). Le scope tenant est aussi appliqué en SQL (pas de fuite).
  app.get('/tenants/:tenantId/stats/campaign-funnel', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const campaignId = (req.query as Record<string, unknown>).campaignId;
    if (typeof campaignId !== 'string' || campaignId === '') return reply.code(400).send({ error: 'campaignId requis' });
    return reply.code(200).send(await deps.getCampaignFunnel(tenant, campaignId));
  });

  // Breakdown des codes d'erreur Meta sur la plage, filtrable ?templateName=.
  app.get('/tenants/:tenantId/stats/errors', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const templateName = typeof q.templateName === 'string' && q.templateName !== '' ? q.templateName : undefined;
    return reply.code(200).send({ errors: await deps.getErrorBreakdown(tenant, r.range, templateName) });
  });

  // Graphe de coût estimé/jour, filtrable ?campaignId= / ?templateName= (peut appeler Meta pour le tarif).
  app.get('/tenants/:tenantId/stats/cost', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const filter: CostFilter = {
      ...(typeof q.campaignId === 'string' && q.campaignId !== '' ? { campaignId: q.campaignId } : {}),
      ...(typeof q.templateName === 'string' && q.templateName !== '' ? { templateName: q.templateName } : {}),
    };
    return reply.code(200).send(await deps.getCostSeries(tenant, r.range, filter));
  });

  // Analyse de conversation (Pièce 1) : agrégats quanti sur la plage. Scope tenant AUSSI en SQL (pas de fuite).
  app.get('/tenants/:tenantId/stats/conversations', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getConversationSummary(tenant, r.range));
  });

  // Liste quali des conversations analysées, filtrable ?sentiment=&intent=&action=&limit= (enums valides seulement).
  app.get('/tenants/:tenantId/stats/conversations/list', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const limit = typeof q.limit === 'string' && /^\d+$/.test(q.limit) ? Number(q.limit) : undefined;
    const filters: AnalyzedConversationsFilter = {
      ...(inSet(SENTIMENTS, q.sentiment) ? { sentiment: inSet(SENTIMENTS, q.sentiment) } : {}),
      ...(inSet(INTENTS, q.intent) ? { intent: inSet(INTENTS, q.intent) } : {}),
      ...(inSet(ACTIONS, q.action) ? { action: inSet(ACTIONS, q.action) } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    return reply.code(200).send({ conversations: await deps.listAnalyzedConversations(tenant, r.range, filters) });
  });
}
