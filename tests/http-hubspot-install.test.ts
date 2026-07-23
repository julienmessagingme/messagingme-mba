import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { HubspotInstallRouteDeps } from '../src/http/hubspot-install';

const SECRET = 'test-secret';
const SERVICE_SECRET = 'service-secret-partage-avec-mm-hubspot';
const PUBLIC_URL = 'https://mm-hubspot.example';
const NOW = 1_700_000_000_000;
let adminTok = '';
let agentTok = '';
let otherAdminTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  otherAdminTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (tok: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` } });

function app(over: Partial<HubspotInstallRouteDeps> = {}) {
  const deps: HubspotInstallRouteDeps = {
    connectorPublicUrl: PUBLIC_URL,
    serviceSecret: SERVICE_SECRET,
    now: () => NOW,
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, hubspotInstall: deps });
}

describe('POST /tenants/:t/hubspot/install-link', () => {
  it('agent -> 403 (admin-only)', async () => {
    const server = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/hubspot/install-link', ...h(agentTok), payload: '{}' });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('admin d\'un AUTRE tenant -> 403 (le tenant vient du JWT, pas de l\'URL)', async () => {
    const server = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/hubspot/install-link', ...h(otherAdminTok), payload: '{}' });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('admin -> 200 + installUrl signée (pas de tenant en clair dans l\'URL)', async () => {
    const server = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/hubspot/install-link', ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(200);
    const { installUrl } = res.json() as { installUrl: string };
    const u = new URL(installUrl);
    expect(u.origin + u.pathname).toBe(`${PUBLIC_URL}/oauth/install`);
    expect(u.searchParams.get('t')).toBeTruthy();
    expect(installUrl).not.toContain('tenant=t1'); // le tenant n'est plus en clair (c'était la faille)
    await server.close();
  });

  it('grant=lists -> le jeton porte le grant (re-consentement listes)', async () => {
    const server = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/hubspot/install-link', ...h(adminTok), payload: JSON.stringify({ grant: 'lists' }) });
    expect(res.statusCode).toBe(200);
    const { installUrl } = res.json() as { installUrl: string };
    // Le jeton se décode côté mm-hubspot ; ici on vérifie juste qu'un t= est présent et non vide.
    expect(new URL(installUrl).searchParams.get('t')).toBeTruthy();
    await server.close();
  });

  it('grant hors whitelist -> 400', async () => {
    const server = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/hubspot/install-link', ...h(adminTok), payload: JSON.stringify({ grant: 'contacts' }) });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('connecteur non configuré (URL publique ou secret vide) -> 503', async () => {
    const noUrl = app({ connectorPublicUrl: '' });
    expect((await noUrl.inject({ method: 'POST', url: '/tenants/t1/hubspot/install-link', ...h(adminTok), payload: '{}' })).statusCode).toBe(503);
    await noUrl.close();
    const noSecret = app({ serviceSecret: '' });
    expect((await noSecret.inject({ method: 'POST', url: '/tenants/t1/hubspot/install-link', ...h(adminTok), payload: '{}' })).statusCode).toBe(503);
    await noSecret.close();
  });
});
