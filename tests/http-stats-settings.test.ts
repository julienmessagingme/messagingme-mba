import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { StatsRouteDeps } from '../src/http/stats';
import type { SettingsRouteDeps } from '../src/http/settings';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

function app(over: { stats?: Partial<StatsRouteDeps>; settings?: Partial<SettingsRouteDeps> } = {}) {
  const stats: StatsRouteDeps = {
    getDashboard: async () => ({
      contacts: [{ date: '2026-07-09', count: 3 }],
      templates: { utility: [{ date: '2026-07-09', count: 1 }], marketing: [{ date: '2026-07-09', count: 2 }] },
      exchanged: [{ date: '2026-07-09', count: 5 }],
    }),
    getTemplateBreakdown: async () => [{ name: 'promo', category: 'marketing', count: 4 }],
    getPricing: async () => ({ byCategory: { marketing: { category: 'marketing', cost: 0.5724, volume: 4, ratePerMessage: 0.1431 } }, totalCost: 0.5724 }),
    getCampaignFunnel: async () => ({ sent: 10, delivered: 8, read: 5, replied: 3, failed: 1 }),
    getErrorBreakdown: async () => [{ code: 131049, count: 4, templateName: 'promo' }, { code: 131047, count: 2, templateName: null }],
    getCostSeries: async () => ({ marketing: [{ date: '2026-07-09', count: 0.57 }], utility: [], total: 0.57, hasRates: true }),
    getConversationSummary: async () => ({
      enabled: true, total: 3,
      sentiment: { positif: 1, neutre: 1, negatif: 1 },
      intent: { demande_devis: 2, sav: 1, reclamation: 0, information: 0, prise_rdv: 0, autre: 0 },
      resolution: { resolved: 2, unresolved: 1, rate: 2 / 3 },
      handledBy: { humain: 1, automatise: 2, mba: 0 },
      exchanges: { avg: 3.5, median: 3 },
      actions: { creer_devis: 2, rappeler: 0, relancer: 0, escalader: 1, aucune: 0 },
      topTopics: [{ topic: 'devis', count: 2 }],
      confidence: { lt50: 0, from50to70: 1, from70to90: 1, gte90: 1 },
    }),
    listAnalyzedConversations: async (_t, _r, f) => [
      { conversationId: 'cv1', waId: '33600', profileName: 'Julie', sentiment: f.sentiment ?? 'positif', intent: 'demande_devis', topic: 'devis', resolved: true, actionSuggestion: 'creer_devis', confidence: 0.9, justification: 'demande un devis', handledBy: 'humain', exchangesCount: 3, analyzedAt: '2026-07-17T10:00:00.000Z', inboxHref: '/inbox?c=cv1' },
    ],
    ...over.stats,
  };
  const settings: SettingsRouteDeps = {
    getSettings: async () => ({ mbaEnabled: false, hubspotListsEnabled: false, controlHandbackSeconds: null }),
    setMbaEnabled: async () => {},
    setHubspotListsEnabled: async () => {},
    setControlHandbackSeconds: async () => {},
    ...over.settings,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, stats, settings });
}

describe('stats route', () => {
  it('GET /stats -> 3 séries', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ contacts: unknown[]; templates: { utility: unknown[]; marketing: unknown[] }; exchanged: unknown[] }>();
    expect(b.contacts).toHaveLength(1);
    expect(b.templates.marketing[0]).toEqual({ date: '2026-07-09', count: 2 });
    expect(b.exchanged[0]).toEqual({ date: '2026-07-09', count: 5 });
    await a.close();
  });

  it('agent -> 403 sur les stats (dashboard réservé admin, Feature 2 RBAC)', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('GET /stats/conversations -> agrégats + enabled ; agent 403 ; tenant croisé 403 ; plage invalide 400', async () => {
    const a = app();
    const ok = await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations?days=30', ...h(adminTok) });
    expect(ok.statusCode).toBe(200);
    const s = ok.json<{ enabled: boolean; total: number; sentiment: { positif: number }; resolution: { rate: number } }>();
    expect(s).toMatchObject({ enabled: true, total: 3 });
    expect(s.sentiment.positif).toBe(1);
    expect(s.resolution.rate).toBeCloseTo(2 / 3);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations', ...h(agentTok) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/tenants/AUTRE/stats/conversations', ...h(adminTok) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations?from=2026-07-10&to=2026-07-01', ...h(adminTok) })).statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats/conversations/list -> quali + filtres enum valides seulement, inboxHref', async () => {
    const captured: unknown[] = [];
    const a = app({ stats: { listAnalyzedConversations: async (_t, _r, f) => { captured.push(f); return [{ conversationId: 'cv1', waId: '33600', profileName: null, sentiment: 'negatif', intent: 'sav', topic: 't', resolved: false, actionSuggestion: 'escalader', confidence: 0.6, justification: 'j', handledBy: 'automatise', exchangesCount: 5, analyzedAt: '2026-07-17T10:00:00.000Z', inboxHref: '/inbox?c=cv1' }]; } } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations/list?days=30&sentiment=negatif&intent=sav&action=escalader&limit=25&junk=xxx', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ conversations: Array<{ inboxHref: string }> }>().conversations[0]?.inboxHref).toBe('/inbox?c=cv1');
    // Seuls les filtres d'enum VALIDES sont passés au store ; une valeur hors enum serait ignorée (pas d'injection).
    expect(captured[0]).toEqual({ sentiment: 'negatif', intent: 'sav', action: 'escalader', limit: 25 });
    const bad = await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations/list?days=30&sentiment=PIRATE&action=drop', ...h(adminTok) });
    expect(bad.statusCode).toBe(200);
    expect(captured[1]).toEqual({}); // aucune valeur d'enum valide -> aucun filtre
    await a.close();
  });

  it('tenant != token -> 403', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/AUTRE/stats', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('sans token -> 401', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats' });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it('GET /stats/templates -> breakdown + pricing', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/templates?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ breakdown: Array<{ name: string; count: number }>; pricing: { totalCost: number; byCategory: Record<string, { ratePerMessage: number }> } }>();
    expect(b.breakdown[0]).toEqual({ name: 'promo', category: 'marketing', count: 4 });
    expect(b.pricing.byCategory.marketing?.ratePerMessage).toBeCloseTo(0.1431);
    await a.close();
  });

  it('GET /stats/templates agent -> 403 (admin-only)', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/templates', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('GET /stats/templates pricing null (Meta indispo) -> 200, breakdown seul', async () => {
    const a = app({ stats: { getPricing: async () => null } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/templates', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ pricing: unknown }>().pricing).toBeNull();
    await a.close();
  });

  it('GET /stats/campaign-funnel?campaignId -> {sent,delivered,read,replied,failed}', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/campaign-funnel?campaignId=c1', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: 10, delivered: 8, read: 5, replied: 3, failed: 1 });
    await a.close();
  });

  it('GET /stats/campaign-funnel sans campaignId -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/campaign-funnel', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats/errors -> { errors: [...] } trié, avec templateName', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/errors?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ errors: Array<{ code: number; count: number; templateName: string | null }> }>().errors[0]).toEqual({ code: 131049, count: 4, templateName: 'promo' });
    await a.close();
  });

  it('GET /stats/errors?templateName -> filtre transmis au store + réponse porte templateName', async () => {
    let captured: string | undefined = 'UNSET';
    const a = app({ stats: { getErrorBreakdown: async (_t, _r, tpl) => { captured = tpl; return [{ code: 131049, count: 4, templateName: 'promo' }]; } } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/errors?days=30&templateName=promo', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(captured).toBe('promo');
    expect(res.json<{ errors: Array<{ templateName: string | null }> }>().errors[0]!.templateName).toBe('promo');
    await a.close();
  });

  it('GET /stats/cost -> série marketing/utility + total', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost?days=30&templateName=promo', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ total: number; hasRates: boolean; marketing: unknown[] }>();
    expect(b.total).toBe(0.57);
    expect(b.hasRates).toBe(true);
    await a.close();
  });

  it('GET /stats/cost agent -> 403 (admin-only)', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('GET /stats?from&to valides -> 200', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?from=2026-01-01&to=2026-01-31', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('GET /stats to dans le futur -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?from=2020-01-01&to=2999-01-01', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats from > to -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?from=2026-02-01&to=2026-01-01', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats span > 366j -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?from=2024-01-01&to=2026-01-01', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats un seul de from/to -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?from=2026-01-01', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });
});

describe('settings route', () => {
  it('GET /settings admin -> mbaEnabled', async () => {
    const a = app({ settings: { getSettings: async () => ({ mbaEnabled: true, hubspotListsEnabled: false, controlHandbackSeconds: null }) } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/settings', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ mbaEnabled: boolean }>().mbaEnabled).toBe(true);
    await a.close();
  });

  it('GET /settings agent -> 403 (admin-only, Feature 2 RBAC)', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/settings', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('PUT /settings admin -> 200 + persiste', async () => {
    let saved: [string, boolean] | null = null;
    const a = app({ settings: { setMbaEnabled: async (t, e) => { saved = [t, e]; } } });
    const res = await a.inject({ method: 'PUT', url: '/tenants/t1/settings', ...h(adminTok), payload: { mbaEnabled: true } });
    expect(res.statusCode).toBe(200);
    expect(saved).toEqual(['t1', true]);
    await a.close();
  });

  it('PUT /settings agent -> 403 (admin-only)', async () => {
    const a = app();
    const res = await a.inject({ method: 'PUT', url: '/tenants/t1/settings', ...h(agentTok), payload: { mbaEnabled: true } });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('PATCH /settings/hubspot-lists admin -> 200 + persiste ; agent -> 403 ; body invalide -> 400', async () => {
    let saved: [string, boolean] | null = null;
    const ok = app({ settings: { setHubspotListsEnabled: async (t, e) => { saved = [t, e]; } } });
    const r1 = await ok.inject({ method: 'PATCH', url: '/tenants/t1/settings/hubspot-lists', ...h(adminTok), payload: { enabled: true } });
    expect(r1.statusCode).toBe(200);
    expect(saved).toEqual(['t1', true]);
    await ok.close();
    const ag = app();
    expect((await ag.inject({ method: 'PATCH', url: '/tenants/t1/settings/hubspot-lists', ...h(agentTok), payload: { enabled: true } })).statusCode).toBe(403);
    await ag.close();
    const bad = app();
    expect((await bad.inject({ method: 'PATCH', url: '/tenants/t1/settings/hubspot-lists', ...h(adminTok), payload: { enabled: 'oui' } })).statusCode).toBe(400);
    await bad.close();
  });

  it('PUT /settings body invalide -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'PUT', url: '/tenants/t1/settings', ...h(adminTok), payload: { mbaEnabled: 'oui' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });
});

/**
 * Durée du gel après prise de main, réglable par client.
 *
 * La validation compte autant que l'écriture : ce réglage décide combien de temps un client final peut
 * rester sans réponse. Une valeur aberrante acceptée en silence casserait la promesse « le client finit
 * toujours par avoir une réponse », et rien à l'écran ne le signalerait.
 */
describe('PATCH /settings/control-handback', () => {
  const url = '/tenants/t1/settings/control-handback';

  it('accepte une durée en secondes et la renvoie', async () => {
    const poses: Array<number | null> = [];
    const a = app({ settings: { setControlHandbackSeconds: async (_t: string, sec: number | null) => { poses.push(sec); } } });
    const res = await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { seconds: 1800 } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ controlHandbackSeconds: number }>().controlHandbackSeconds).toBe(1800);
    expect(poses).toEqual([1800]);
    await a.close();
  });

  it('accepte null (retour au défaut du serveur) et 0 (jamais de reprise auto)', async () => {
    const poses: Array<number | null> = [];
    const a = app({ settings: { setControlHandbackSeconds: async (_t: string, sec: number | null) => { poses.push(sec); } } });
    expect((await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { seconds: null } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { seconds: 0 } })).statusCode).toBe(200);
    expect(poses).toEqual([null, 0]);
    await a.close();
  });

  it('refuse ce qui laisserait un client sans réponse trop longtemps ou pour toujours', async () => {
    const poses: Array<number | null> = [];
    const a = app({ settings: { setControlHandbackSeconds: async (_t: string, sec: number | null) => { poses.push(sec); } } });
    // Au-delà de 7 jours ce n'est plus un gel, c'est un abandon. Négatif, décimal et non-nombre sont
    // des erreurs de saisie qu'il vaut mieux refuser que coercer en silence.
    for (const seconds of [7 * 24 * 3600 + 1, -1, 1.5, '1800', true, undefined]) {
      const res = await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { seconds } });
      expect(res.statusCode).toBe(400);
    }
    expect(poses).toEqual([]); // aucune écriture sur une valeur refusée
    await a.close();
  });

  it('un agent ne peut pas changer ce réglage (admin seulement)', async () => {
    const poses: Array<number | null> = [];
    const a = app({ settings: { setControlHandbackSeconds: async (_t: string, sec: number | null) => { poses.push(sec); } } });
    const res = await a.inject({ method: 'PATCH', url, ...h(agentTok), payload: { seconds: 60 } });
    expect(res.statusCode).toBe(403);
    expect(poses).toEqual([]);
    await a.close();
  });
});
