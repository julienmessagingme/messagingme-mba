import { describe, it, expect } from 'vitest';
import { makeRequireApiKey, requireScope } from '../src/auth/api-key';
import { RateLimiter } from '../src/auth/rate-limit';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { FastifyRequest, FastifyReply } from 'fastify';

class FakeKeys implements ApiKeyLookup {
  touched = 0;
  constructor(private readonly raw: string, private readonly rec: { id: string; tenantId: string; scopes: string[] }) {}
  async findActiveByHash(hash: string) { return hash === sha256Hex(this.raw) ? this.rec : null; }
  async touchLastUsed() { this.touched += 1; }
}

function fakeReq(auth?: string): FastifyRequest {
  return { headers: auth ? { authorization: auth } : {} } as unknown as FastifyRequest;
}
function fakeReply() {
  const state: { statusCode: number | null; body: unknown; headers: Record<string, string> } = { statusCode: null, body: undefined, headers: {} };
  const reply = {
    code(c: number) { state.statusCode = c; return reply; },
    header(k: string, v: string) { state.headers[k.toLowerCase()] = v; return reply; },
    async send(b: unknown) { state.body = b; return reply; },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

const REC = { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] };

describe('makeRequireApiKey', () => {
  it('clé valide -> pose req.auth synthétique role=api + apiScopes, touchLastUsed, headers', async () => {
    const guard = makeRequireApiKey(new FakeKeys('mba_ok', REC), new RateLimiter(5, 60_000));
    const req = fakeReq('Bearer mba_ok');
    const { reply, state } = fakeReply();
    await guard(req, reply);
    expect(state.statusCode).toBeNull(); // pas de réponse d'erreur -> passe
    expect(req.auth).toEqual({ userId: 'apikey:k1', tenantId: 't1', role: 'api' });
    expect(req.apiScopes).toEqual(['contacts:write']);
    expect(state.headers['x-ratelimit-limit']).toBe('5');
  });

  it('absente / mauvais préfixe / inconnue -> 401', async () => {
    const guard = makeRequireApiKey(new FakeKeys('mba_ok', REC), new RateLimiter(5, 60_000));
    for (const h of [undefined, 'Bearer jwtish', 'Bearer mba_wrong']) {
      const { reply, state } = fakeReply();
      await guard(fakeReq(h), reply);
      expect(state.statusCode).toBe(401);
    }
  });

  it('rate limit dépassé -> 429 + retry-after', async () => {
    const guard = makeRequireApiKey(new FakeKeys('mba_ok', REC), new RateLimiter(1, 60_000));
    const first = fakeReply();
    await guard(fakeReq('Bearer mba_ok'), first.reply);
    expect(first.state.statusCode).toBeNull(); // 1re passe
    const second = fakeReply();
    await guard(fakeReq('Bearer mba_ok'), second.reply);
    expect(second.state.statusCode).toBe(429);
    expect(second.state.headers['retry-after']).toBeDefined();
    expect(second.state.headers['x-ratelimit-remaining']).toBe('0');
  });
});

describe('requireScope', () => {
  it('scope présent -> passe ; absent -> 403', async () => {
    const req = { apiScopes: ['contacts:write'] } as unknown as FastifyRequest;
    const ok = fakeReply();
    await requireScope('contacts:write')(req, ok.reply);
    expect(ok.state.statusCode).toBeNull();
    const ko = fakeReply();
    await requireScope('sends:create')(req, ko.reply);
    expect(ko.state.statusCode).toBe(403);
  });
});
