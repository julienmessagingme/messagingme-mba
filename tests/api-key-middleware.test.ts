import { describe, it, expect } from 'vitest';
import { makeRequireApiKey, requireScope } from '../src/auth/api-key';
import { RateLimiter } from '../src/auth/rate-limit';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { cleApiDeTest } from './aide/cle-api';

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

/**
 * ⚠️ DES CLÉS AU FORMAT QUE LE PRODUIT ÉMET VRAIMENT (2026-09-14). Ces cas s'authentifiaient avec
 * « mba_ok », une clé de deux caractères que le générateur n'a jamais pu produire : tant que la garde ne
 * regardait que le préfixe, ça ne se voyait pas. Depuis qu'elle contrôle le FORMAT, un tel jeton est
 * refusé, et c'est le bon comportement.
 *
 * ⚠️ LE PRÉ-FILTRE EST LARGE ICI (1 000/minute) : ces cas éprouvent le plafond MÉTIER, et un pré-filtre
 * serré le masquerait en refusant avant lui.
 */
const CLE = cleApiDeTest('ok');
const prefiltreLarge = (): RateLimiter => new RateLimiter(1000, 60_000);

describe('makeRequireApiKey', () => {
  it('clé valide -> pose req.auth synthétique role=api + apiScopes, touchLastUsed, headers', async () => {
    const guard = makeRequireApiKey(new FakeKeys(CLE, REC), new RateLimiter(5, 60_000), prefiltreLarge());
    const req = fakeReq(`Bearer ${CLE}`);
    const { reply, state } = fakeReply();
    await guard(req, reply);
    expect(state.statusCode).toBeNull(); // pas de réponse d'erreur -> passe
    expect(req.auth).toEqual({ userId: 'apikey:k1', tenantId: 't1', role: 'api' });
    expect(req.apiScopes).toEqual(['contacts:write']);
    expect(state.headers['x-ratelimit-limit']).toBe('5');
  });

  it('absente / mauvais préfixe / inconnue -> 401', async () => {
    const guard = makeRequireApiKey(new FakeKeys(CLE, REC), new RateLimiter(5, 60_000), prefiltreLarge());
    for (const h of [undefined, 'Bearer jwtish', `Bearer ${cleApiDeTest('inconnue')}`, 'Bearer mba_trop_court']) {
      const { reply, state } = fakeReply();
      await guard(fakeReq(h), reply);
      expect(state.statusCode).toBe(401);
    }
  });

  it('rate limit dépassé -> 429 + retry-after', async () => {
    const guard = makeRequireApiKey(new FakeKeys(CLE, REC), new RateLimiter(1, 60_000), prefiltreLarge());
    const first = fakeReply();
    await guard(fakeReq(`Bearer ${CLE}`), first.reply);
    expect(first.state.statusCode).toBeNull(); // 1re passe
    const second = fakeReply();
    await guard(fakeReq(`Bearer ${CLE}`), second.reply);
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
