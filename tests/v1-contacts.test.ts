import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { ApiContactInput, ApiUpsertOutcome } from '../src/api/contacts-upsert';

/** Fake du lookup de clé : mappe des clés claires -> {tenantId, scopes} via leur hash sha256. */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  touched: string[] = [];
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed(id: string) { this.touched.push(id); }
}

const VALID = 'mba_valid_key';
const NOSCOPE = 'mba_noscope_key';

function app(over: Partial<{ upsertContacts: (t: string, items: ApiContactInput[]) => Promise<ApiUpsertOutcome[]> }> = {}) {
  const cap = { calls: [] as Array<{ tenant: string; items: ApiContactInput[] }> };
  const keys = new FakeApiKeys()
    .add(VALID, { id: 'k1', tenantId: 't1', scopes: ['contacts:write', 'sends:create'] })
    .add(NOSCOPE, { id: 'k2', tenantId: 't1', scopes: ['sends:create'] });
  const upsertContacts = over.upsertContacts ?? (async (tenant: string, items: ApiContactInput[]) => {
    cap.calls.push({ tenant, items });
    return items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` }));
  });
  return { server: buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts: { upsertContacts } } }), cap, keys };
}
const auth = (key: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } });

describe('POST /v1/contacts', () => {
  it('clé valide + scope -> 200, tenant issu de la clé, touchLastUsed', async () => {
    const { server, cap, keys } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(VALID), payload: { phone: '+33612345678', name: 'Marc' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ contactId: string; status: string }>()).toMatchObject({ contactId: 'c0', status: 'created' });
    expect(cap.calls[0]!.tenant).toBe('t1'); // tenant dérivé de la clé, jamais du body
    expect(keys.touched).toEqual(['k1']);
    await server.close();
  });

  it('sans Bearer -> 401 ; préfixe non mba_ -> 401 ; clé inconnue -> 401', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/v1/contacts', headers: { 'content-type': 'application/json' }, payload: { phone: '+336' } })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/v1/contacts', ...auth('jwt_or_whatever'), payload: { phone: '+336' } })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/v1/contacts', ...auth('mba_inconnue'), payload: { phone: '+336' } })).statusCode).toBe(401);
    await server.close();
  });

  it('clé sans le scope contacts:write -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(NOSCOPE), payload: { phone: '+33612345678' } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('phone manquant -> 400 ; en-têtes x-ratelimit-* posés', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(VALID), payload: { name: 'sans tel' } });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    await server.close();
  });

  it('outcome error (téléphone invalide côté layer) -> 400', async () => {
    const { server } = app({ upsertContacts: async () => [{ index: 0, status: 'error', reason: 'téléphone invalide' }] });
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(VALID), payload: { phone: 'abc' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('invalide');
    await server.close();
  });
});

describe('POST /v1/contacts/batch', () => {
  it('lot -> 200 avec compteurs', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth(VALID), payload: { contacts: [{ phone: '+33611' }, { phone: '+33622' }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ created: number; updated: number; errors: number; results: unknown[] }>()).toMatchObject({ created: 2, updated: 0, errors: 0 });
    expect(cap.calls[0]!.items).toHaveLength(2);
    await server.close();
  });
  it('tableau vide ou absent -> 400 ; au-dessus de 500 -> 400', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth(VALID), payload: {} })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth(VALID), payload: { contacts: [] } })).statusCode).toBe(400);
    const tooMany = { contacts: Array.from({ length: 501 }, () => ({ phone: '+33611' })) };
    expect((await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth(VALID), payload: tooMany })).statusCode).toBe(400);
    await server.close();
  });
});
