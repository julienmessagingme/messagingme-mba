import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { makeRequireApiKey, requireScope } from '../src/auth/api-key';
import { RateLimiter, consommerAvecEntetes } from '../src/auth/rate-limit';
import { compterOuRefuser, type ApiUsageGuard } from '../src/api/usage-guard';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { cleApiDeTest } from './aide/cle-api';

/**
 * LES REFUS DE LA GARDE COMMUNE PORTENT UN CODE (spec du 2026-09-24, § 9).
 *
 * 🔴 ELLE EST PARTAGÉE (`/v1`, `/mcp`, le relais de l'agent de Meta) : lui ajouter un `code` ne doit changer
 * NI ses statuts NI ses en-têtes (`retry-after`, `x-ratelimit-*`). Et la console, qui passe par les mêmes
 * limiteurs, garde ses refus `{ error }` seuls : le code est un paramètre FACULTATIF.
 */
class FauxCles implements ApiKeyLookup {
  constructor(private readonly brut: string) {}
  async findActiveByHash(hash: string) { return hash === sha256Hex(this.brut) ? { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] } : null; }
  async touchLastUsed() { /* sans objet ici */ }
}

function fauxReply() {
  const state: { statusCode: number | null; body: unknown; headers: Record<string, string> } = { statusCode: null, body: undefined, headers: {} };
  const reply = {
    code(c: number) { state.statusCode = c; return reply; },
    header(k: string, v: string) { state.headers[k.toLowerCase()] = v; return reply; },
    async send(b: unknown) { state.body = b; return reply; },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

const CLE = cleApiDeTest('garde_codes');
const large = (): RateLimiter => new RateLimiter(1000, 60_000);
const requete = (h?: string): FastifyRequest => ({ headers: h ? { authorization: h } : {} }) as unknown as FastifyRequest;

describe('la garde de clé', () => {
  it('🔴 clé absente, mal formée ou inconnue : 401 `unauthorized`', async () => {
    const garde = makeRequireApiKey(new FauxCles(CLE), large(), large());
    for (const h of [undefined, 'Bearer jwt', `Bearer ${cleApiDeTest('inconnue')}`]) {
      const { reply, state } = fauxReply();
      await garde(requete(h), reply);
      expect(state.statusCode).toBe(401);
      expect(state.body).toMatchObject({ code: 'unauthorized' });
    }
  });

  it('🔴 droit manquant : 403 `missing_scope`, et le message nomme le droit', async () => {
    const { reply, state } = fauxReply();
    await requireScope('contacts:read')({ apiScopes: ['contacts:write'] } as unknown as FastifyRequest, reply);
    expect(state.statusCode).toBe(403);
    expect(state.body).toEqual({ error: 'scope requis : contacts:read', code: 'missing_scope' });
  });

  it('🔴 plafond par clé : 429 `rate_limited`, avec les MÊMES en-têtes qu’avant', async () => {
    const garde = makeRequireApiKey(new FauxCles(CLE), new RateLimiter(1, 60_000), large());
    await garde(requete(`Bearer ${CLE}`), fauxReply().reply);
    const { reply, state } = fauxReply();
    await garde(requete(`Bearer ${CLE}`), reply);
    expect(state.statusCode).toBe(429);
    expect(state.body).toMatchObject({ code: 'rate_limited' });
    expect(Number(state.headers['retry-after'])).toBeGreaterThan(0);
    expect(state.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('🔴 plafond par clé à la PREMIÈRE résolution (clé encore inconnue du process) : 429 `rate_limited` aussi', async () => {
    // Le cas précédent ne passe que par le refus d'une clé DÉJÀ connue ; celui-ci prend l'autre branche,
    // celle d'une clé résolue pour la première fois, dont le seau est déjà vide.
    const limiteur = new RateLimiter(1, 60_000);
    limiteur.take(sha256Hex(CLE));
    const garde = makeRequireApiKey(new FauxCles(CLE), limiteur, large());
    const { reply, state } = fauxReply();
    await garde(requete(`Bearer ${CLE}`), reply);
    expect(state.statusCode).toBe(429);
    expect(state.body).toMatchObject({ code: 'rate_limited' });
    expect(state.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('budget spéculatif épuisé : 429 `rate_limited`, et toujours AUCUN en-tête x-ratelimit', async () => {
    const garde = makeRequireApiKey(new FauxCles(CLE), large(), new RateLimiter(1, 60_000));
    await garde(requete(`Bearer ${cleApiDeTest('sonde_a')}`), fauxReply().reply);
    const { reply, state } = fauxReply();
    await garde(requete(`Bearer ${cleApiDeTest('sonde_b')}`), reply);
    expect(state.statusCode).toBe(429);
    expect(state.body).toMatchObject({ code: 'rate_limited' });
    expect(Object.keys(state.headers).filter((k) => k.startsWith('x-ratelimit'))).toEqual([]);
  });
});

describe('la console garde ses refus sans code', () => {
  it('⚠️ un refus de débit SANS code demandé reste `{ error }` seul', async () => {
    const limiteur = new RateLimiter(1, 60_000);
    await consommerAvecEntetes(limiteur, 'u1', fauxReply().reply);
    const { reply, state } = fauxReply();
    expect(await consommerAvecEntetes(limiteur, 'u1', reply)).toBe(false);
    expect(state.body).toEqual({ error: 'trop de requêtes, patientez un instant' });
  });
});

describe('le garde d’usage', () => {
  it('🔴 401 `unauthorized` sans authentification, 429 `rate_limited` sur un quota ou une place lourde', async () => {
    const refusant: ApiUsageGuard = {
      demander: () => ({ accepte: false, raison: 'quota d’essai atteint' }),
      compteurs: () => [],
      entrerLourde: () => null,
      noterRefus: () => {},
    };
    const sansAuth = fauxReply();
    expect(await compterOuRefuser(refusant, requete(), sansAuth.reply, 'contacts.upsert')).toBe(false);
    expect(sansAuth.state).toMatchObject({ statusCode: 401, body: { code: 'unauthorized' } });

    const authentifiee = { headers: {}, auth: { userId: 'apikey:k1', tenantId: 't1', role: 'api' }, apiKeyId: 'k1' } as unknown as FastifyRequest;
    const quota = fauxReply();
    expect(await compterOuRefuser(refusant, authentifiee, quota.reply, 'contacts.upsert')).toBe(false);
    expect(quota.state).toMatchObject({ statusCode: 429, body: { error: 'quota d’essai atteint', code: 'rate_limited' } });

    const lourde = fauxReply();
    expect(await compterOuRefuser(refusant, authentifiee, lourde.reply, 'contacts.batch', 10)).toBe(false);
    expect(lourde.state).toMatchObject({ statusCode: 429, body: { code: 'rate_limited' } });
    expect(lourde.state.headers['retry-after']).toBe('2');
  });
});
