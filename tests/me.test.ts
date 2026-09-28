import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { MeRouteDeps } from '../src/http/me';

const SECRET = 'test-secret';
let agentTok = '';
let otherTenantTok = '';
let observationTok = '';
beforeAll(async () => {
  agentTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'agent' }, SECRET);
  otherTenantTok = await signSession({ userId: 'u9', tenantId: 't2', role: 'admin' }, SECRET);
  // Le jeton que `/ops/observe` émet (`src/index.ts`) : une identité qui n'est PAS un uuid, et aucun compte.
  observationTok = await signSession({ userId: 'ops-observation', tenantId: 't1', role: 'admin', impersonated: true }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

function app(over: Partial<MeRouteDeps> = {}) {
  const deps: MeRouteDeps = {
    getById: async (userId) => (userId === 'u1' ? { email: 'julien@messagingme.fr', name: 'Julien Dumas', role: 'agent' } : null),
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, me: deps });
}

describe('route me', () => {
  it('renvoie le profil de l\'utilisateur courant (depuis req.auth.userId)', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/me', ...h(agentTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'julien@messagingme.fr', name: 'Julien Dumas', role: 'agent' });
    await server.close();
  });

  it('tenant croisé -> 403', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/me', ...h(otherTenantTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('utilisateur inconnu -> 404', async () => {
    const server = app({ getById: async () => null });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/me', ...h(agentTok) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('🔴 la session d’observation de /ops : une réponse propre, SANS lecture en base (son identité n’est pas un uuid)', async () => {
    const lus: string[] = [];
    // Lue en base, `ops-observation` fait lever Postgres (22P02) : le faux dépôt fait de même.
    const server = app({ getById: async (userId) => { lus.push(userId); throw new Error('invalid input syntax for type uuid: "ops-observation"'); } });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/me', ...h(observationTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: '', name: null, role: 'admin' });
    expect(lus).toEqual([]);
    await server.close();
  });

  it('le lien d’exploitation : `exploitation: true` pour une adresse de la liste, rien sinon', async () => {
    // Un confort du menu du compte, jamais une autorisation : `/ops` a sa propre garde. Le champ n'est posé que
    // vrai, pour qu'une réponse ordinaire garde exactement sa forme d'avant.
    const vus: string[] = [];
    const oui = app({ estExploitant: (email) => { vus.push(email); return true; } });
    expect((await oui.inject({ method: 'GET', url: '/tenants/t1/me', ...h(agentTok) })).json()).toMatchObject({ exploitation: true });
    expect(vus).toEqual(['julien@messagingme.fr']);
    await oui.close();
    const non = app({ estExploitant: () => false });
    expect((await non.inject({ method: 'GET', url: '/tenants/t1/me', ...h(agentTok) })).json()).not.toHaveProperty('exploitation');
    await non.close();
    // Une session d'observation n'a pas d'identité à elle : jamais de lien.
    const observation = app({ estExploitant: () => true });
    expect((await observation.inject({ method: 'GET', url: '/tenants/t1/me', ...h(observationTok) })).json()).not.toHaveProperty('exploitation');
    await observation.close();
  });

  it('sans token -> 401', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/me' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});
