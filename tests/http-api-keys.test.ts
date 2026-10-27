import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { ApiKeysRouteDeps } from '../src/http/api-keys';
import type { ApiKeyRow, PlafondCles } from '../src/auth/api-key-store.pg';
import type { AuditSink } from '../src/audit/journal';
import { journalMuet } from './routes-inertes';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
let otherTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  otherTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

function app(over: Partial<ApiKeysRouteDeps> = {}) {
  const cap = { created: [] as Array<{ name: string; scopes: string[] }>, revoked: [] as string[], plafonds: [] as PlafondCles[] };
  const deps: ApiKeysRouteDeps = {
    audit: journalMuet,
    cles: {
      creerSousPlafond: async (_t, name, scopes, plafond) => {
        cap.plafonds.push(plafond);
        cap.created.push({ name, scopes });
        return { id: 'k1', key: 'mba_secret_shown_once' };
      },
      listByTenant: async (): Promise<ApiKeyRow[]> => [{ id: 'k1', name: 'CI', scopes: ['contacts:write'], createdAt: '2026-07-17T00:00:00.000Z', lastUsedAt: null, revokedAt: null }],
      revoke: async (_t, id) => { cap.revoked.push(id); return id === 'k1'; },
    },
    limiteCles: async () => 10,
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, apiKeys: deps }), cap };
}

describe('routes api-keys (admin)', () => {
  it('POST -> 201 avec la clé EN CLAIR (montrée une fois)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'Intégration', scopes: ['contacts:write', 'sends:create'] } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ id: string; key: string }>()).toMatchObject({ id: 'k1', key: 'mba_secret_shown_once' });
    expect(cap.created[0]).toEqual({ name: 'Intégration', scopes: ['contacts:write', 'sends:create'] });
    await server.close();
  });

  it('🔴 le plafond de clés est celui de l’offre de l’espace, la clé du relais mise à part (spec offres v2)', async () => {
    const lues: string[] = [];
    const free = app({ limiteCles: async (t) => { lues.push(t); return 2; } });
    await free.server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'X', scopes: ['contacts:write'] } });
    expect(free.cap.plafonds).toEqual([{ max: 2, horsDroit: 'mba:relais' }]);
    expect(lues).toEqual(['t1']);
    await free.server.close();
    // L'Entreprise est sans limite : le magasin ne compte pas.
    const entreprise = app({ limiteCles: async () => null });
    await entreprise.server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'X', scopes: ['contacts:write'] } });
    expect(entreprise.cap.plafonds).toEqual([{ max: null, horsDroit: 'mba:relais' }]);
    await entreprise.server.close();
  });

  const plafondAtteint = (max: number, journal: string[]) => app({
    audit: async (_t, _a, action) => { journal.push(action); },
    cles: { creerSousPlafond: async () => null, listByTenant: async () => [], revoke: async () => false },
    limiteCles: async () => max,
  });

  it('🔴 plafond de la Free atteint -> 402 de l’offre qui renvoie au Pro, aucune clé rendue, rien au journal', async () => {
    const journal: string[] = [];
    const { server } = plafondAtteint(2, journal);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'X', scopes: ['contacts:write'] } });
    expect(res.statusCode).toBe(402);
    const corps = res.json<{ error: string; code: string; limite: string; max: number; upgradeUrl: string }>();
    expect(corps).toMatchObject({ code: 'plan_limit_reached', limite: 'clesApi', max: 2 });
    expect(corps.error).toMatch(/2 clés d’API actives.*révoquez-en une.*Passez en Pro/);
    expect(corps.upgradeUrl).toMatch(/\/offre$/);
    expect(corps).not.toHaveProperty('key');
    expect(journal).toEqual([]);
    await server.close();
  });

  it('la 11e clé d’un Pro -> 402 qui renvoie au Business, l’offre suivante (spec Business)', async () => {
    const { server } = plafondAtteint(10, []);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'X', scopes: ['contacts:write'] } });
    expect(res.statusCode).toBe(402);
    expect(res.json<{ error: string }>().error).toMatch(/10 clés d’API actives.*Passez en Business/);
    await server.close();
  });

  it('une création réussie est tracée au journal, avec les droits accordés et jamais la clé', async () => {
    const traces: Array<{ actor: unknown; action: string; detail: unknown }> = [];
    const audit: AuditSink = async (_t, actor, action, _cible, detail) => { traces.push({ actor, action, detail }); };
    const { server } = app({ audit });
    await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'X', scopes: ['contacts:write'] } });
    expect(traces).toEqual([{ actor: { userId: 'u1', email: null }, action: 'cle_api.creee', detail: { scopes: ['contacts:write'] } }]);
    expect(JSON.stringify(traces)).not.toMatch(/mba_secret_shown_once/);
    await server.close();
  });

  it('POST name vide -> 400 ; aucun scope -> 400 ; scope inconnu -> 400', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: '', scopes: ['contacts:write'] } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'X', scopes: [] } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'X', scopes: ['god:mode'] } })).statusCode).toBe(400);
    await server.close();
  });

  it('🔴 le droit `mba:relais` N’EST PAS attribuable : seule la publication crée cette clé', async () => {
    // Son porteur appelle les outils de l'espace au nom de n'importe lequel de ses contacts (c'est l'en-tête
    // qui désigne le contact) : il ne doit exister que chez Meta, posé par la publication (migration 0161).
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'X', scopes: ['mba:relais'] } });
    expect(res.statusCode).toBe(400);
    expect(cap.created).toEqual([]);
    await server.close();
  });

  it('GET liste (sans hash)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/api-keys', ...h(adminTok) });
    const keys = res.json<{ keys: Array<Record<string, unknown>> }>().keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty('keyHash');
    expect(keys[0]).not.toHaveProperty('key');
    await server.close();
  });

  it('DELETE -> 200 ; inconnue/déjà révoquée -> 404', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'DELETE', url: '/tenants/t1/api-keys/k1', ...h(adminTok) })).statusCode).toBe(200);
    expect((await server.inject({ method: 'DELETE', url: '/tenants/t1/api-keys/nope', ...h(adminTok) })).statusCode).toBe(404);
    await server.close();
  });

  it('agent -> 403 ; tenant croisé -> 403', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(agentTok), payload: { name: 'X', scopes: ['contacts:write'] } })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/api-keys', ...h(otherTok) })).statusCode).toBe(403);
    await server.close();
  });
});
