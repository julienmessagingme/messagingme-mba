import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { makeRequireApiKey } from '../src/auth/api-key';
import { RateLimiter } from '../src/auth/rate-limit';
import { buildServer } from '../src/server';
import { sha256Hex } from '../src/lib/signature';
import { nouveauJeton, PREFIXE_ACCES } from '../src/oauth/jetons';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { AccesOauthLookup, AccesOauthResolu } from '../src/oauth/store.pg';
import type { ApiUsageGuard, DemandeUsage } from '../src/api/usage-guard';
import type { MbaRelaisDeps } from '../src/http/mba-relais';
import { DROIT_RELAIS } from '../src/mba/cle-relais';
import { FakeQueue } from './fake-queue';
import { cleApiDeTest } from './aide/cle-api';
import { plafondsDeTest } from './aide/plafonds';
import { contactsV1Muets } from './aide/contacts-v1';

/**
 * LA GARDE DE `/v1`, `/mcp` ET DU RELAIS, AVEC UN JETON OAUTH (tâche 4 du plan `2026-10-03-oauth-mcp.md`).
 *
 * 🔴 Ce qui est protégé ici : le préfixe aiguille sans ambiguïté (`mba_` vers les clés, `mbo_` vers les
 * autorisations, jamais l'un dans le magasin de l'autre) ; un jeton refusé par la base rend 401 ; le rôle posé
 * reste `api` ; et un jeton compte dans le plafond de l'ESPACE, le même que les clés.
 */

class FaussesCles implements ApiKeyLookup {
  lectures = 0;
  private readonly parEmpreinte = new Map<string, { id: string; tenantId: string; scopes: string[]; tenantStatus?: string }>();
  ajouter(brut: string, r: { id: string; tenantId: string; scopes: string[]; tenantStatus?: string }): this { this.parEmpreinte.set(sha256Hex(brut), r); return this; }
  async findActiveByHash(hash: string) { this.lectures += 1; return this.parEmpreinte.get(hash) ?? null; }
  async touchLastUsed() { /* sans objet */ }
}

class FauxJetons implements AccesOauthLookup {
  lectures = 0;
  private readonly parEmpreinte = new Map<string, AccesOauthResolu>();
  ajouter(empreinte: string, a: Partial<AccesOauthResolu> = {}): this {
    this.parEmpreinte.set(empreinte, {
      autorisationId: 'a1', tenantId: 't1', userId: 'u-admin', scopes: ['mcp:read', 'mcp:write'], tenantStatus: 'active', valide: true,
      horsOffre: null,
      ...a,
    });
    return this;
  }
  async resoudreAcces(empreinte: string) { this.lectures += 1; return this.parEmpreinte.get(empreinte) ?? null; }
}

function fauxReply() {
  const etat: { statusCode: number | null; body: unknown } = { statusCode: null, body: undefined };
  const reply = {
    code(c: number) { etat.statusCode = c; return reply; },
    header() { return reply; },
    async send(b: unknown) { etat.body = b; return reply; },
  };
  return { reply: reply as unknown as FastifyReply, etat };
}
const requete = (bearer: string): FastifyRequest => ({ headers: { authorization: `Bearer ${bearer}` } }) as unknown as FastifyRequest;
const large = (): RateLimiter => new RateLimiter(1000, 60_000);

const CLE = cleApiDeTest('oauth_garde');
const JETON = nouveauJeton(PREFIXE_ACCES);

describe('la garde : un jeton mbo_', () => {
  it('🔴 un jeton valide passe, au rôle `api`, avec son autorisation et sa personne ; le magasin des clés n’est pas lu', async () => {
    const cles = new FaussesCles().ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['mcp:read'] });
    const jetons = new FauxJetons().ajouter(JETON.empreinte, { scopes: ['mcp:read'] });
    const garde = makeRequireApiKey(cles, plafondsDeTest(), large(), jetons);
    const req = requete(JETON.brut);
    const { reply, etat } = fauxReply();
    await garde(req, reply);
    expect(etat.statusCode).toBeNull();
    // Jamais le vrai rôle : il ouvrirait un jour une route qui le composerait.
    expect(req.auth).toEqual({ userId: 'oauth:a1', tenantId: 't1', role: 'api' });
    expect(req.apiScopes).toEqual(['mcp:read']);
    expect(req.apiAcces).toEqual({ type: 'oauth', id: 'a1' });
    expect(req.apiPersonne).toEqual({ userId: 'u-admin' });
    expect(cles.lectures).toBe(0);
    expect(jetons.lectures).toBe(1);
  });

  it('🔴 et une clé ne va jamais dans le magasin des jetons ; elle n’a pas de personne', async () => {
    const cles = new FaussesCles().ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['mcp:read'] });
    const jetons = new FauxJetons();
    const garde = makeRequireApiKey(cles, plafondsDeTest(), large(), jetons);
    const req = requete(CLE);
    const { reply, etat } = fauxReply();
    await garde(req, reply);
    expect(etat.statusCode).toBeNull();
    expect(req.auth).toEqual({ userId: 'apikey:k1', tenantId: 't1', role: 'api' });
    expect(req.apiAcces).toEqual({ type: 'cle', id: 'k1' });
    expect(req.apiPersonne).toBeNull();
    expect(jetons.lectures).toBe(0);
  });

  it('🔴 révoqué, échu, compte désactivé ou plus admin (valide: false), ou inconnu : 401', async () => {
    const invalide = nouveauJeton(PREFIXE_ACCES);
    const jetons = new FauxJetons().ajouter(invalide.empreinte, { valide: false });
    const garde = makeRequireApiKey(new FaussesCles(), plafondsDeTest(), large(), jetons);
    for (const brut of [invalide.brut, nouveauJeton(PREFIXE_ACCES).brut]) {
      const req = requete(brut);
      const { reply, etat } = fauxReply();
      await garde(req, reply);
      expect(etat.statusCode).toBe(401);
      expect(etat.body).toMatchObject({ code: 'unauthorized' });
      expect(req.auth).toBeUndefined();
    }
  });

  it('🔴 un jeton mal formé est refusé avant toute lecture, dans aucun des deux magasins', async () => {
    const cles = new FaussesCles();
    const jetons = new FauxJetons();
    const garde = makeRequireApiKey(cles, plafondsDeTest(), large(), jetons);
    for (const brut of [`${PREFIXE_ACCES}court`, `${JETON.brut}x`, `${PREFIXE_ACCES}${'a'.repeat(42)}+`, 'mbr_' + JETON.brut.slice(4)]) {
      const { reply, etat } = fauxReply();
      await garde(requete(brut), reply);
      expect(etat.statusCode).toBe(401);
    }
    expect(cles.lectures + jetons.lectures).toBe(0);
  });

  it('🔴 un jeton valide d’un espace suspendu : 403 `tenant_locked` (un 401 relancerait la connexion en boucle)', async () => {
    const jetons = new FauxJetons().ajouter(JETON.empreinte, { tenantStatus: 'locked' });
    const garde = makeRequireApiKey(new FaussesCles(), plafondsDeTest(), large(), jetons);
    const { reply, etat } = fauxReply();
    await garde(requete(JETON.brut), reply);
    expect(etat.statusCode).toBe(403);
    expect(etat.body).toMatchObject({ code: 'tenant_locked' });
  });

  it('🔴 la personne du jeton est au-delà de l’offre (lot 6, B2a) : 402 plan_limit_reached, pas un 401 qui relancerait la connexion', async () => {
    const jetons = new FauxJetons().ajouter(JETON.empreinte, { horsOffre: { limite: 'admins', max: 1 } });
    const garde = makeRequireApiKey(new FaussesCles(), plafondsDeTest(), large(), jetons);
    const { reply, etat } = fauxReply();
    await garde(requete(JETON.brut), reply);
    expect(etat.statusCode).toBe(402);
    expect(etat.body).toMatchObject({ code: 'plan_limit_reached' });
    expect(JSON.stringify(etat.body)).toMatch(/1 administrateur/);
  });

  it('🔴 le budget des empreintes inconnues freine aussi les jetons inventés', async () => {
    const jetons = new FauxJetons().ajouter(JETON.empreinte);
    const garde = makeRequireApiKey(new FaussesCles(), plafondsDeTest(), new RateLimiter(1, 60_000), jetons);
    const premier = fauxReply();
    await garde(requete(nouveauJeton(PREFIXE_ACCES).brut), premier.reply);
    expect(premier.etat.statusCode).toBe(401);
    const second = fauxReply();
    await garde(requete(nouveauJeton(PREFIXE_ACCES).brut), second.reply);
    expect(second.etat.statusCode).toBe(429);
    expect(jetons.lectures).toBe(1);
  });
});

/** Le relais muet : sa route existe, sa garde est la vraie. */
const relaisMuet = { numeros: { getTenantPhoneNumberId: async () => null } } as unknown as MbaRelaisDeps;

function monter(o: { apiParMinute?: number; usage?: ApiUsageGuard } = {}) {
  const cles = new FaussesCles()
    .ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['mcp:read', 'contacts:write', 'contacts:read', 'sends:create'] })
    .ajouter(cleApiDeTest('oauth_garde_t2'), { id: 'k2', tenantId: 't2', scopes: ['mcp:read'] });
  const jetons = new FauxJetons().ajouter(JETON.empreinte);
  return buildServer({
    queue: new FakeQueue(),
    plafonds: { apiParMinute: o.apiParMinute ?? 1000 },
    ...(o.usage ? { usage: o.usage } : {}),
    v1: { apiKeys: cles, oauth: jetons, contacts: contactsV1Muets(), mcp: {} as never, mbaRelais: relaisMuet },
  });
}
const avec = (bearer: string) => ({ authorization: `Bearer ${bearer}`, 'content-type': 'application/json' });

describe('la garde : un jeton mbo_ dans le vrai câblage', () => {
  it('🔴 le plafond de l’ESPACE est commun aux clés et aux jetons', async () => {
    const server = monter({ apiParMinute: 2 });
    // `GET /mcp` rend 405 APRÈS la garde : l'appel le plus simple qui traverse le plafond.
    expect((await server.inject({ method: 'GET', url: '/mcp', headers: avec(CLE) })).statusCode).toBe(405);
    expect((await server.inject({ method: 'GET', url: '/mcp', headers: avec(JETON.brut) })).statusCode).toBe(405);
    expect((await server.inject({ method: 'GET', url: '/mcp', headers: avec(JETON.brut) })).statusCode).toBe(429);
    expect((await server.inject({ method: 'GET', url: '/mcp', headers: avec(CLE) })).statusCode).toBe(429);
    // L'espace voisin n'a rien payé.
    expect((await server.inject({ method: 'GET', url: '/mcp', headers: avec(cleApiDeTest('oauth_garde_t2')) })).statusCode).toBe(405);
    await server.close();
  });

  it('🔴 `/v1` et le relais refusent un jeton OAuth par leurs droits (403 `missing_scope`)', async () => {
    const server = monter();
    const v1 = await server.inject({ method: 'POST', url: '/v1/contacts', headers: avec(JETON.brut), payload: { phone: '+33612345678' } });
    expect(v1.statusCode).toBe(403);
    expect(v1.json()).toMatchObject({ code: 'missing_scope' });
    const recherche = await server.inject({ method: 'POST', url: '/v1/contacts/search', headers: avec(JETON.brut), payload: {} });
    expect(recherche.statusCode).toBe(403);
    const relais = await server.inject({
      method: 'POST', url: '/mba/relais/outils/o1', headers: { ...avec(JETON.brut), 'x-contact-whatsapp': '+33612345678' }, payload: {},
    });
    expect(relais.statusCode).toBe(403);
    expect(relais.json()).toMatchObject({ error: `scope requis : ${DROIT_RELAIS}` });
    // Et `/mcp` l'accepte : le refus vient bien des droits, pas de la garde.
    const mcp = await server.inject({ method: 'POST', url: '/mcp', headers: avec(JETON.brut), payload: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    expect(mcp.statusCode).toBe(200);
    await server.close();
  });

  it('le journal d’usage range un jeton sous son autorisation, préfixée, et une clé sous son identifiant', async () => {
    const demandes: DemandeUsage[] = [];
    const usage: ApiUsageGuard = {
      demander: async (d) => { demandes.push(d); return { accepte: true }; },
      compteurs: async () => [],
      entrerLourde: () => () => {},
      noterRefus: async () => {},
    };
    const server = monter({ usage });
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    await server.inject({ method: 'POST', url: '/mcp', headers: avec(JETON.brut), payload: ping });
    await server.inject({ method: 'POST', url: '/mcp', headers: avec(CLE), payload: ping });
    expect(demandes.map((d) => d.cleId)).toEqual(['oauth:a1', 'k1']);
    await server.close();
  });
});
