import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { EmbeddedSignupRouteDeps } from '../src/http/embedded-signup';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

interface Cap {
  exchanged: string[];
  verifiedWaba: string[];
  linked: Array<{ tenantId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null }>;
  subscribed: string[];
  registered: Array<{ phoneNumberId: string; pin: string }>;
  saved: Array<{ wabaId: string; tenantId: string; token: string; pin: string | null }>;
}

function app(over: Partial<EmbeddedSignupRouteDeps> = {}) {
  const cap: Cap = { exchanged: [], verifiedWaba: [], linked: [], subscribed: [], registered: [], saved: [] };
  const deps: EmbeddedSignupRouteDeps = {
    configId: 'cfg-123',
    appId: 'app-1',
    graphVersion: 'v25.0',
    exchangeCode: async (code) => { cap.exchanged.push(code); return 'BIZ_TOKEN'; },
    verifyWaba: async (wabaId) => { cap.verifiedWaba.push(wabaId); },
    getPhone: async () => ({ displayPhoneNumber: '+33525680250', verifiedName: 'Messaging Me Tech', status: 'CONNECTED' }),
    subscribeApp: async (wabaId) => { cap.subscribed.push(wabaId); },
    register: async (phoneNumberId, _tok, pin) => { cap.registered.push({ phoneNumberId, pin }); },
    link: async (input) => { cap.linked.push({ tenantId: input.tenantId, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, displayPhoneNumber: input.displayPhoneNumber }); },
    saveCredentials: async (wabaId, tenantId, token, pin) => { cap.saved.push({ wabaId, tenantId, token, pin }); },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, embeddedSignup: deps }), cap };
}

const BODY = { code: 'code-abc', wabaId: 'waba-1', phoneNumberId: 'pn-1' };

describe('GET /embedded-signup/config', () => {
  it('admin -> 200 avec appId/configId (enabled true)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/embedded-signup/config', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, appId: 'app-1', configId: 'cfg-123', graphVersion: 'v25.0' });
    await server.close();
  });

  it('configId vide -> enabled false (le front garde le placeholder)', async () => {
    const { server } = app({ configId: '' });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/embedded-signup/config', ...h(adminTok) });
    expect(res.json()).toMatchObject({ enabled: false });
    await server.close();
  });

  it('agent -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/embedded-signup/config', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });
});

describe('POST /embedded-signup/complete', () => {
  it('numéro déjà CONNECTED : échange + link + subscribe + credentials, SANS register', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: true, wabaId: 'waba-1', phoneNumberId: 'pn-1', displayPhoneNumber: '+33525680250' });
    expect(cap.exchanged).toEqual(['code-abc']);
    expect(cap.linked[0]).toMatchObject({ tenantId: 't1', wabaId: 'waba-1', phoneNumberId: 'pn-1', displayPhoneNumber: '+33525680250' });
    expect(cap.subscribed).toEqual(['waba-1']);
    expect(cap.registered).toHaveLength(0); // déjà connecté -> pas de register
    expect(cap.saved[0]).toMatchObject({ wabaId: 'waba-1', tenantId: 't1', token: 'BIZ_TOKEN', pin: null });
    await server.close();
  });

  it('numéro NEUF (status non CONNECTED) : register appelé avec un pin 6 chiffres, pin conservé', async () => {
    const { server, cap } = app({ getPhone: async () => ({ displayPhoneNumber: null, verifiedName: null, status: 'PENDING' }) });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(cap.registered).toHaveLength(1);
    expect(cap.registered[0]!.pin).toMatch(/^\d{6}$/);
    expect(cap.saved[0]!.pin).toBe(cap.registered[0]!.pin);
    await server.close();
  });

  it('échange du code échoue -> 502, RIEN n\'est rattaché', async () => {
    const { server, cap } = app({ exchangeCode: async () => { throw new Error('Graph 400 (#100) : code expiré'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(502);
    expect(cap.linked).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('anti-hijack : le token ne possède PAS le WABA (verifyWaba throw) -> 502, RIEN persisté', async () => {
    const { server, cap } = app({ verifyWaba: async () => { throw new Error('Graph 403 (#200) : accès refusé au WABA'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(502);
    expect(cap.linked).toHaveLength(0);
    expect(cap.subscribed).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('anti-hijack : le token ne possède PAS le numéro (getPhone throw) -> 502, RIEN persisté', async () => {
    const { server, cap } = app({ getPhone: async () => { throw new Error('Graph 403 (#200) : accès refusé au numéro'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(502);
    expect(cap.linked).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('subscribe échoue -> 200 avec warnings (jamais de demi-échec silencieux)', async () => {
    const { server, cap } = app({ subscribeApp: async () => { throw new Error('Graph 403 : permission'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ warnings?: string[] }>().warnings?.[0]).toMatch(/abonnement webhooks/);
    expect(cap.saved).toHaveLength(1); // le token est quand même conservé
    await server.close();
  });

  it('register échoue -> 200 avec warning et pin NON stocké', async () => {
    const { server, cap } = app({
      getPhone: async () => ({ displayPhoneNumber: null, verifiedName: null, status: null }),
      register: async () => { throw new Error('Graph 400 : pin mismatch'); },
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ warnings?: string[] }>().warnings?.some((w) => w.includes('register'))).toBe(true);
    expect(cap.saved[0]!.pin).toBeNull();
    await server.close();
  });

  it('body incomplet -> 400 ; agent -> 403 ; feature OFF -> 503', async () => {
    const { server } = app();
    const bad = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: { code: 'x' } });
    const agent = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(agentTok), payload: BODY });
    expect(bad.statusCode).toBe(400);
    expect(agent.statusCode).toBe(403);
    await server.close();
    const { server: off } = app({ configId: '' });
    const disabled = await off.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(disabled.statusCode).toBe(503);
    await off.close();
  });
});
