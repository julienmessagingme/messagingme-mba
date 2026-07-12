import { describe, it, expect, beforeAll } from 'vitest';
import { computeAccountStatus, normalizeQuality } from '../src/account/service';
import { pullFromInfo, pullFromError } from '../src/account/pull';
import { MetaPhoneNumberClient } from '../src/meta/phone-number';
import { MetaApiError } from '../src/meta/errors';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { FetchLike } from '../src/meta/templates';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { AccountRouteDeps } from '../src/http/account';

// --- Service pur (composition de la pastille) ---
describe('computeAccountStatus', () => {
  it('token invalide -> rouge (jamais gris)', () => {
    const s = computeAccountStatus({ reachable: false, authError: true, quality: 'GREEN', numberStatus: 'CONNECTED' });
    expect(s.dot).toBe('red');
  });
  it('injoignable (transitoire, sans erreur auth) -> gris', () => {
    expect(computeAccountStatus({ reachable: false, quality: 'GREEN', numberStatus: 'CONNECTED' }).dot).toBe('grey');
  });
  it('numéro en état bloquant -> rouge', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'GREEN', numberStatus: 'RESTRICTED' }).dot).toBe('red');
  });
  it('qualité rouge -> rouge', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'RED', numberStatus: 'CONNECTED' }).dot).toBe('red');
  });
  it('non connecté (PENDING) -> gris', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'GREEN', numberStatus: 'PENDING' }).dot).toBe('grey');
  });
  it('connecté + qualité jaune -> ambre', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'YELLOW', numberStatus: 'CONNECTED' }).dot).toBe('amber');
  });
  it('connecté + qualité verte -> vert', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'GREEN', numberStatus: 'CONNECTED' }).dot).toBe('green');
  });
  it('connecté + qualité inconnue -> gris (JAMAIS faux vert)', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'UNKNOWN', numberStatus: 'CONNECTED' }).dot).toBe('grey');
  });
  it('normalizeQuality : valeurs hors ensemble -> UNKNOWN', () => {
    expect(normalizeQuality('green')).toBe('GREEN');
    expect(normalizeQuality(null)).toBe('UNKNOWN');
    expect(normalizeQuality('FOO')).toBe('UNKNOWN');
  });
});

// --- Mapping du pull (anti faux-vert : la qualité UNKNOWN doit ÉCRASER l'ancienne, pas être omise) ---
describe('pullFromInfo / pullFromError', () => {
  it('inclut TOUJOURS qualityRating, y compris UNKNOWN (dégradation doit écraser en base)', () => {
    const r = pullFromInfo({ status: 'CONNECTED', qualityRating: undefined, messagingLimitTier: 'TIER_1K' });
    expect(r).toMatchObject({ ok: true, status: 'CONNECTED', qualityRating: 'UNKNOWN', messagingLimitTier: 'TIER_1K' });
  });
  it('normalise la qualité renvoyée', () => {
    expect(pullFromInfo({ qualityRating: 'green' })).toMatchObject({ ok: true, qualityRating: 'GREEN' });
    expect(pullFromInfo({ qualityRating: 'NA' })).toMatchObject({ ok: true, qualityRating: 'UNKNOWN' });
  });
  it('code 190 / HTTP 401 -> authError ; code 100 générique -> PAS authError (gris, pas rouge token)', () => {
    expect(pullFromError(new MetaApiError(401, { code: 190 }))).toEqual({ ok: false, authError: true });
    expect(pullFromError(new MetaApiError(400, { code: 100 }))).toEqual({ ok: false, authError: false });
    expect(pullFromError(new Error('boom'))).toEqual({ ok: false, authError: false });
  });
});

// --- Client Graph GET /{phone_number_id} ---
function makeFetch(responses: Array<{ ok: boolean; status: number; json: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return { ok: r.ok, status: r.status, json: async () => r.json } as Response;
  };
  return { fn, calls };
}

describe('MetaPhoneNumberClient.get', () => {
  it('GET avec fields + Bearer -> parse le statut', async () => {
    const { fn, calls } = makeFetch([
      { ok: true, status: 200, json: { status: 'CONNECTED', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', display_phone_number: '+33 5 25 68 02 50' } },
    ]);
    const client = new MetaPhoneNumberClient('tok', 'v25.0', fn);
    const info = await client.get('PN1');
    expect(info).toMatchObject({ status: 'CONNECTED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K' });
    expect(calls[0]!.url).toContain('/v25.0/PN1?fields=');
    expect(calls[0]!.url).toContain('quality_rating');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('token invalide (401 code 190) -> MetaApiError code 190', async () => {
    const { fn } = makeFetch([{ ok: false, status: 401, json: { error: { code: 190, message: 'token expiré' } } }]);
    const client = new MetaPhoneNumberClient('tok', 'v25.0', fn);
    await expect(client.get('PN1')).rejects.toBeInstanceOf(MetaApiError);
  });
});

// --- Route /account-status ---
const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
let otherTenantTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  otherTenantTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

function app(over: Partial<AccountRouteDeps> = {}) {
  const saved: Array<{ id: string; patch: unknown }> = [];
  const deps: AccountRouteDeps = {
    getPhoneNumber: async () => ({ id: 'PN1', displayPhoneNumber: '+33 5 25 68 02 50', status: null, qualityRating: null, messagingLimitTier: null }),
    pullStatus: async () => ({ ok: true, status: 'CONNECTED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', displayPhoneNumber: '+33 5 25 68 02 50' }),
    saveStatus: async (id, patch) => { saved.push({ id, patch }); },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, account: deps }), saved };
}

describe('route account-status', () => {
  it('admin + pull vert -> 200 dot=green + persiste la qualité', async () => {
    const { server, saved } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: { dot: string }; number: string; hasNumber: boolean }>();
    expect(body.status.dot).toBe('green');
    expect(body.hasNumber).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.patch).toMatchObject({ status: 'CONNECTED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K' });
    await server.close();
  });

  it('GREEN persisté + pull frais UNKNOWN -> dot=grey (jamais faux vert) + écrase en base', async () => {
    const { server, saved } = app({
      getPhoneNumber: async () => ({ id: 'PN1', displayPhoneNumber: '+33123', status: 'CONNECTED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K' }),
      pullStatus: async () => ({ ok: true, status: 'CONNECTED', qualityRating: 'UNKNOWN' }),
    });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    expect(res.json<{ status: { dot: string } }>().status.dot).toBe('grey');
    expect(saved[0]!.patch).toMatchObject({ qualityRating: 'UNKNOWN' });
    await server.close();
  });

  it('pull en erreur d\'auth -> dot=red, ne persiste rien', async () => {
    const { server, saved } = app({ pullStatus: async () => ({ ok: false, authError: true }) });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    expect(res.json<{ status: { dot: string } }>().status.dot).toBe('red');
    expect(saved).toHaveLength(0);
    await server.close();
  });

  it('pull transitoire (sans auth) -> dot=grey', async () => {
    const { server } = app({ pullStatus: async () => ({ ok: false, authError: false }) });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    expect(res.json<{ status: { dot: string } }>().status.dot).toBe('grey');
    await server.close();
  });

  it('aucun numéro -> hasNumber=false, dot=grey', async () => {
    const { server } = app({ getPhoneNumber: async () => null });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    const body = res.json<{ hasNumber: boolean; status: { dot: string } }>();
    expect(body.hasNumber).toBe(false);
    expect(body.status.dot).toBe('grey');
    await server.close();
  });

  it('agent -> 403 (réservé admin)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('tenant croisé -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(otherTenantTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });
});
