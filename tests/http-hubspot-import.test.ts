import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import { ReconsentRequiredError } from '../src/crm/hubspot-import';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { HubspotImportRouteDeps } from '../src/http/hubspot-import';
import type { HubspotList } from '../src/crm/hubspot-import';

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
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
const LIST: HubspotList = { listId: '1', name: 'Chauds', size: 3, processingType: 'DYNAMIC' };

function app(over: Partial<HubspotImportRouteDeps> = {}) {
  const cap = { fetchCalls: 0, imports: [] as Array<{ listId: string; listName: string }> };
  const deps: HubspotImportRouteDeps = {
    isListsEnabled: async () => true,
    fetchLists: async () => { cap.fetchCalls += 1; return [LIST]; },
    importList: async (_t, listId, listName) => { cap.imports.push({ listId, listName }); return { report: { created: 2, updated: 0, skipped: 0, errors: [] }, truncated: false, skippedNoPhone: 1, tags: [`HubSpot: ${listName}`] }; },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, hubspotImport: deps }), cap };
}

describe('GET /tenants/:t/hubspot/lists', () => {
  it('toggle OFF -> {available:false} SANS appeler le connecteur', async () => {
    const { server, cap } = app({ isListsEnabled: async () => false });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/hubspot/lists', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
    expect(cap.fetchCalls).toBe(0); // aucun appel réseau quand OFF
    await server.close();
  });
  it('toggle ON -> {available:true, lists}', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/hubspot/lists?query=chaud', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, lists: [LIST] });
    expect(cap.fetchCalls).toBe(1);
    await server.close();
  });
  it('scope non accordé -> {available:true, reason:reconsent_required, reconsentUrl}', async () => {
    const { server } = app({ fetchLists: async () => { throw new ReconsentRequiredError('https://hub/install?grant=lists'); } });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/hubspot/lists', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, reason: 'reconsent_required', reconsentUrl: 'https://hub/install?grant=lists', lists: [] });
    await server.close();
  });
  it('agent -> 403 ; tenant croisé -> 403', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/hubspot/lists', ...h(agentTok) })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/hubspot/lists', ...h(otherTok) })).statusCode).toBe(403);
    await server.close();
  });
});

describe('POST /tenants/:t/hubspot/import', () => {
  it('nominal -> 200 rapport + truncated + skippedNoPhone', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/hubspot/import', ...h(adminTok), payload: { listId: '1', listName: 'Chauds' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 2, truncated: false, skippedNoPhone: 1, tags: ['HubSpot: Chauds'] });
    expect(cap.imports[0]).toEqual({ listId: '1', listName: 'Chauds' });
    await server.close();
  });
  it('listId manquant -> 400 ; toggle OFF -> 409 ; reconsent -> 409', async () => {
    expect((await app().server.inject({ method: 'POST', url: '/tenants/t1/hubspot/import', ...h(adminTok), payload: {} })).statusCode).toBe(400);
    expect((await app({ isListsEnabled: async () => false }).server.inject({ method: 'POST', url: '/tenants/t1/hubspot/import', ...h(adminTok), payload: { listId: '1' } })).statusCode).toBe(409);
    const rec = app({ importList: async () => { throw new ReconsentRequiredError('u'); } });
    const res = await rec.server.inject({ method: 'POST', url: '/tenants/t1/hubspot/import', ...h(adminTok), payload: { listId: '1' } });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('reconsent_required');
  });
  it('agent -> 403', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/hubspot/import', ...h(agentTok), payload: { listId: '1' } })).statusCode).toBe(403);
    await server.close();
  });
});
