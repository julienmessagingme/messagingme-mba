import { describe, it, expect } from 'vitest';
import { buildServer, CORPS_OPAQUE_5XX } from '../src/server';
import { FakeQueue } from './fake-queue';
import { GardeUsageMemoire } from './aide/usage';
import { sha256Hex } from '../src/lib/signature';
import { STATUT_PAR_CODE } from '../src/api/erreurs';
import { ROUTES_V1 } from '../src/api/openapi/registre';
import { MetaApiError } from '../src/meta/errors';
import { NumeroDelieError } from '../src/meta/numero-delie';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { cleApiDeTest, aucunJetonOauth } from './aide/cle-api';

/**
 * 🔴 TOUTE RÉPONSE D'ERREUR DE `/v1` PORTE UN `code` DE LA TABLE (lot 17, livraison A).
 *
 * Un programme qui intègre l'API se branche sur `code`, jamais sur la phrase. Quatre réponses en sortaient sans : le
 * refus de Meta relancé jusqu'au gestionnaire commun, la panne, les refus de forme de Fastify (type de contenu sans
 * analyseur, corps trop gros), et la route inconnue. Elles le portent désormais, SUR `/v1` SEULEMENT : les routes de la
 * console gardent `{ error }` seul (leur écran lit la phrase, et le texte opaque des 5xx est tenu par
 * `tests/corps-opaque-parite.test.ts`). Une erreur de Meta est classée comme partout (`src/api/refus-meta.ts`).
 */

class Cles implements ApiKeyLookup {
  async findActiveByHash(hash: string) {
    return hash === sha256Hex(CLE) ? { id: 'k1', tenantId: 't1', scopes: DROITS } : null;
  }
  async touchLastUsed(): Promise<void> {}
}
const CLE = cleApiDeTest('erreurs_code');
const DROITS = [...new Set(ROUTES_V1.map((r) => r.droit))];
const UUID = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const CODES = Object.keys(STATUT_PAR_CODE);

/** Le serveur réel, son module `v1` monté sur des services vides : une route qui va jusqu'à eux tombe en panne. */
function serveur(catalogues: Record<string, unknown> = {}) {
  const app = buildServer({
    queue: new FakeQueue(),
    usage: new GardeUsageMemoire(),
    v1: {
      apiKeys: new Cles(), oauth: aucunJetonOauth, contacts: {}, sends: {}, catalogues, messages: {}, messagesRcs: {},
      conversations: {}, templates: {}, webhooks: {}, contactsAdmin: {},
    } as never,
  });
  // Deux routes d'essai, l'une sous `/v1`, l'autre comme une route de la console : le gestionnaire commun les sert.
  app.get('/v1/essai-meta', async () => { throw new MetaApiError(400, { code: 131009, message: 'Parameter value is not valid' }); });
  app.get('/essai-console-meta', async () => { throw new MetaApiError(400, { code: 131009, message: 'Parameter value is not valid' }); });
  app.get('/essai-console-panne', async () => { throw new Error('panne interne'); });
  app.get('/v1/essai-numero-delie', async () => { throw new NumeroDelieError('pn-1'); });
  app.get('/v1/essai-meta-passager', async () => { throw new MetaApiError(503, { code: 131016, message: 'Service unavailable' }); });
  app.get('/v1/essai-jeton', async () => { throw new MetaApiError(401, { code: 190, message: 'Invalid OAuth access token' }); });
  return app;
}
const auth = { authorization: `Bearer ${CLE}` };
const ecritures = ROUTES_V1.filter((r) => r.methode === 'POST' || r.methode === 'PATCH');

describe('🔴 toute erreur de /v1 porte un code de la table', () => {
  it('garde de la garde : le registre a des routes d’écriture', () => {
    expect(ecritures.length).toBeGreaterThan(5);
  });

  // Un type sans analyseur : Fastify refuse en 415 AVANT la route, donc c'est bien le gestionnaire commun qui répond.
  // ⚠️ Pas `text/plain` : Fastify a un analyseur pour lui, et la route refuserait elle-même la chaîne reçue.
  it.each(ecritures.map((r) => ({ cle: `${r.methode} ${r.chemin}`, r })))('$cle : un type de contenu refusé, 415 invalid_body', async ({ r }) => {
    const app = serveur();
    const res = await app.inject({
      method: r.methode, url: r.chemin.replace(/\{\w+\}/g, UUID), headers: { ...auth, 'content-type': 'application/xml' }, payload: '<a/>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    await app.close();
  });

  // ⚠️ Un JSON illisible n'est PAS refusé par Fastify : l'analyseur du récepteur de Meta (`src/webhooks/receiver.ts`),
  // posé pour tout le serveur, le lit comme un objet vide. La route refuse ensuite ce qui manque, ou va plus loin.
  it.each(ecritures.map((r) => ({ cle: `${r.methode} ${r.chemin}`, r })))('$cle : un JSON illisible (lu comme un objet vide)', async ({ r }) => {
    const app = serveur();
    const res = await app.inject({
      method: r.methode, url: r.chemin.replace(/\{\w+\}/g, UUID), headers: { ...auth, 'content-type': 'application/json' }, payload: '{"a":',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(CODES, res.body).toContain(res.json<{ code?: string }>().code);
    await app.close();
  });

  it('un corps trop gros : invalid_body', async () => {
    const app = serveur();
    const res = await app.inject({
      method: 'POST', url: '/v1/contacts', headers: { ...auth, 'content-type': 'application/json' }, payload: `{"x":"${'a'.repeat(1_100_000)}"}`,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    await app.close();
  });

  it('une route inconnue : 404 route_not_found', async () => {
    const app = serveur();
    for (const [method, url] of [['GET', '/v1/inconnue'], ['POST', '/v1/contacts/x/y/z'], ['DELETE', '/v1/conversations']] as const) {
      const res = await app.inject({ method, url, headers: auth });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json(), `${method} ${url}`).toMatchObject({ code: 'route_not_found' });
    }
    await app.close();
  });

  it('une panne : 500, le texte opaque et internal_error', async () => {
    const app = serveur();
    const res = await app.inject({ method: 'GET', url: '/v1/conversations', headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: CORPS_OPAQUE_5XX, code: 'internal_error' });
    await app.close();
  });

  it('🔴 un refus de Meta relancé : 422, la phrase, meta_rejected et le numéro de Meta', async () => {
    const app = serveur({
      templates: async () => { throw new MetaApiError(400, { code: 132001, message: 'Template name does not exist in the translation' }); },
      indices: { listerParEspace: async () => [] },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/templates', headers: auth });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'Meta: Template name does not exist in the translation', code: 'meta_rejected', metaCode: 132001 });
    const essai = await app.inject({ method: 'GET', url: '/v1/essai-meta', headers: auth });
    expect(essai.json()).toMatchObject({ code: 'meta_rejected', metaCode: 131009 });
    await app.close();
  });

  it('un refus de Meta sans numéro : metaCode à null', async () => {
    const app = serveur({ templates: async () => { throw new MetaApiError(400, null); }, indices: { listerParEspace: async () => [] } });
    const res = await app.inject({ method: 'GET', url: '/v1/templates', headers: auth });
    expect(res.json()).toMatchObject({ code: 'meta_rejected', metaCode: null });
    await app.close();
  });

  it('🔴 une panne ou une limite de Meta n’est JAMAIS meta_rejected : 429 rate_limited et son délai', async () => {
    const app = serveur();
    const res = await app.inject({ method: 'GET', url: '/v1/essai-meta-passager', headers: auth });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('le jeton refusé par Meta : 409 meta_auth_failed', async () => {
    const app = serveur();
    const res = await app.inject({ method: 'GET', url: '/v1/essai-jeton', headers: auth });
    expect([res.statusCode, res.json().code]).toEqual([409, 'meta_auth_failed']);
    await app.close();
  });

  it('un numéro délié qui échapperait à une route : 409 number_unlinked, pas invalid_body', async () => {
    const app = serveur();
    const res = await app.inject({ method: 'GET', url: '/v1/essai-numero-delie', headers: auth });
    expect([res.statusCode, res.json().code]).toEqual([409, 'number_unlinked']);
    await app.close();
  });
});

describe('🔴 les routes de la console ne changent pas', () => {
  it('un refus de Meta y garde { error } seul', async () => {
    const app = serveur();
    const res = await app.inject({ method: 'GET', url: '/essai-console-meta' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'Meta: Parameter value is not valid' });
    await app.close();
  });

  it('une panne y garde le texte opaque seul', async () => {
    const app = serveur();
    const res = await app.inject({ method: 'GET', url: '/essai-console-panne' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: CORPS_OPAQUE_5XX });
    await app.close();
  });

  it('une route inconnue hors /v1 garde le 404 de Fastify, sans code', async () => {
    const app = serveur();
    const res = await app.inject({ method: 'GET', url: '/inconnue' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty('code');
    expect(res.json()).toMatchObject({ error: 'Not Found' });
    await app.close();
  });
});
