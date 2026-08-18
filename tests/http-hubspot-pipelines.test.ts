import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import { HubspotServiceError } from '../src/crm/hubspot-service';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { HubspotDealPipeline } from '../src/crm/hubspot-service';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
let otherTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  otherTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

const PIPELINES: HubspotDealPipeline[] = [
  { id: 'default', label: 'Vente', stages: [{ id: 'rdv', label: 'Rendez-vous', closed: false }, { id: 'won', label: 'Gagné', closed: true }] },
];
const URL_OK = '/tenants/t1/hubspot/deal-stages';

function app(fetchDealStages: (tenantId: string) => Promise<HubspotDealPipeline[]> = async () => PIPELINES) {
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, hubspotPipelines: { fetchDealStages } });
}

describe('GET /tenants/:t/hubspot/deal-stages', () => {
  it('nominal -> 200 {connected:true, pipelines} pour le tenant du JWT', async () => {
    const server = app(async (tenantId) => { expect(tenantId).toBe('t1'); return PIPELINES; });
    const res = await server.inject({ method: 'GET', url: URL_OK, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: true, pipelines: PIPELINES });
    await server.close();
  });

  it('portail non lié (404 du connecteur) -> 200 {connected:false}, pas une erreur', async () => {
    // L'écran doit pouvoir dire « connecte HubSpot d'abord » ; un 500 afficherait « chargement impossible ».
    const server = app(async () => { throw new HubspotServiceError(404, 'tenant_not_connected', false); });
    const res = await server.inject({ method: 'GET', url: URL_OK, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false, pipelines: [] });
    await server.close();
  });

  it('panne du connecteur -> 500 : une indispo ne se déguise PAS en « non connecté »', async () => {
    const server = app(async () => { throw new HubspotServiceError(503, undefined, true); });
    const res = await server.inject({ method: 'GET', url: URL_OK, ...h(adminTok) });
    expect(res.statusCode).toBe(500);
    await server.close();
  });

  it('agent -> 403 (configuration = admin) ; tenant d’autrui -> 403 ; sans jeton -> 401', async () => {
    const server = app();
    expect((await server.inject({ method: 'GET', url: URL_OK, ...h(agentTok) })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: URL_OK, ...h(otherTok) })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: URL_OK })).statusCode).toBe(401);
    await server.close();
  });
});
