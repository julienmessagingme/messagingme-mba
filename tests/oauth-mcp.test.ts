import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { sha256Hex } from '../src/lib/signature';
import { nouveauJeton, PREFIXE_ACCES } from '../src/oauth/jetons';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { AccesOauth, AccesOauthLookup } from '../src/oauth/store.pg';
import type { CablageMcp } from '../src/mcp/outils';
import type { AuteurDuChangement } from '../src/inbox/evenements';
import { FakeQueue } from './fake-queue';
import { cleApiDeTest } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import { jamaisDesabonne } from './consentement';
import { mcpAgentInerte, mcpNumeroInerte, mcpOffreInerte, mcpEtiquettesInertes, mcpInerte, mcpWidgetsInertes } from './routes-inertes';

/**
 * `/mcp` ET L'OAUTH (tâche 5 du plan `2026-10-03-oauth-mcp.md`).
 *
 * 🔴 Deux choses, et aucune n'est du protocole MCP :
 *   1. le 401 de `/mcp` porte `WWW-Authenticate`, qui fait ouvrir la connexion à Claude, mais SEULEMENT sur
 *      l'hôte de `PUBLIC_API_URL` : ailleurs (`mba.`), la ressource annoncée ne correspondrait pas à l'adresse
 *      appelée. Jamais sur `/v1`, ni sur un 403 ou un 429 ;
 *   2. une écriture faite avec un jeton est signée de la personne qui l'a autorisé ; avec une clé, de personne.
 */

const BASE = 'https://api.exemple.test';
const API = 'api.exemple.test';
const CLE = cleApiDeTest('oauth_mcp');
const JETON = nouveauJeton(PREFIXE_ACCES);
const JETON_SUSPENDU = nouveauJeton(PREFIXE_ACCES);

class FaussesCles implements ApiKeyLookup {
  async findActiveByHash(hash: string) {
    return hash === sha256Hex(CLE) ? { id: 'k1', tenantId: 't1', scopes: ['mcp:read', 'mcp:write', 'contacts:write'] } : null;
  }
  async touchLastUsed() { /* sans objet */ }
}

class FauxJetons implements AccesOauthLookup {
  async resoudreAcces(empreinte: string): Promise<AccesOauth | null> {
    const base = { autorisationId: 'a1', tenantId: 't1', userId: 'u-admin', scopes: ['mcp:read', 'mcp:write'], valide: true };
    if (empreinte === JETON.empreinte) return { ...base, tenantStatus: 'active' };
    if (empreinte === JETON_SUSPENDU.empreinte) return { ...base, tenantStatus: 'locked' };
    return null;
  }
}

interface Traces {
  envois: Array<{ auteur: string | null | undefined; origine: string }>;
  assignations: AuteurDuChangement[];
}

function monter(o: { publicApiUrl?: string; apiParMinute?: number } = {}) {
  const traces: Traces = { envois: [], assignations: [] };
  const mcp: CablageMcp = {
    estDesabonne: jamaisDesabonne,
    inbox: {
      ...mcpInerte,
      listConversations: async () => [],
      getConversationContext: async (id, tenant) => (tenant === 't1' && id === 'cv1'
        ? { waId: '33600000001', lastInboundAt: '2026-10-03T09:00:00.000Z', windowOpen: true }
        : null),
      getDerniersMessages: async () => [],
      recordOutbound: async (_id, _corps, _msg, origine, _type, _cat, _nom, auteur) => { traces.envois.push({ auteur, origine }); },
      setAssignee: async (_t, _id, _membre, par) => { traces.assignations.push(par); return true; },
    },
    repo: { getTenantPhoneNumberId: async () => 'pn-1' },
    sendReply: async () => 'wamid-1',
    takeControl: async () => {},
    contacts: {
      query: async () => [],
      findByPhone: async () => null,
      analysesEtResumes: async () => new Map(),
    },
    listerMembres: async () => [],
    ...mcpEtiquettesInertes,
    ...mcpWidgetsInertes,
    ...mcpAgentInerte,
    ...mcpNumeroInerte,
    ...mcpOffreInerte,
  };
  const server = buildServer({
    queue: new FakeQueue(),
    publicApiUrl: o.publicApiUrl ?? BASE,
    plafonds: { apiParMinute: o.apiParMinute ?? 1000 },
    v1: { apiKeys: new FaussesCles(), oauth: new FauxJetons(), contacts: contactsV1Muets(), mcp },
  });
  return { server, traces };
}

const entetes = (hote: string, bearer?: string) => ({
  host: hote,
  'content-type': 'application/json',
  ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
});
const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
const appeler = (nom: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: nom, arguments: args } });
const ANNONCE = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mcp:read mcp:write"`;

describe('le 401 de /mcp annonce la connexion OAuth', () => {
  it('🔴 sur l’hôte de PUBLIC_API_URL : sans authentification, l’en-tête sans code d’erreur', async () => {
    const { server } = monter();
    for (const method of ['POST', 'GET'] as const) {
      const res = await server.inject({ method, url: '/mcp', headers: entetes(API), ...(method === 'POST' ? { payload: ping } : {}) });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe(ANNONCE);
    }
    await server.close();
  });

  it('🔴 un jeton OAuth refusé : `error="invalid_token"` ; une clé refusée : l’en-tête sans code d’erreur', async () => {
    const { server } = monter();
    const jeton = await server.inject({ method: 'POST', url: '/mcp', headers: entetes(API, nouveauJeton(PREFIXE_ACCES).brut), payload: ping });
    expect(jeton.statusCode).toBe(401);
    expect(jeton.headers['www-authenticate']).toBe(`${ANNONCE}, error="invalid_token"`);
    const cle = await server.inject({ method: 'POST', url: '/mcp', headers: entetes(API, cleApiDeTest('inconnue')), payload: ping });
    expect(cle.statusCode).toBe(401);
    expect(cle.headers['www-authenticate']).toBe(ANNONCE);
    await server.close();
  });

  it('🔴 jamais sur un autre hôte (mba.), ni sans PUBLIC_API_URL', async () => {
    const { server } = monter();
    for (const hote of ['mba.exemple.test', 'api.exemple.test.evil.test', 'localhost']) {
      const res = await server.inject({ method: 'POST', url: '/mcp', headers: entetes(hote), payload: ping });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate'], hote).toBeUndefined();
    }
    await server.close();
    const sans = monter({ publicApiUrl: '' });
    const res = await sans.server.inject({ method: 'POST', url: '/mcp', headers: entetes(API), payload: ping });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeUndefined();
    await sans.server.close();
  });

  it('🔴 jamais sur /v1, ni sur un 403 ou un 429, ni sur un succès', async () => {
    const { server } = monter({ apiParMinute: 2 });
    const v1 = await server.inject({ method: 'POST', url: '/v1/contacts', headers: entetes(API), payload: { phone: '+33612345678' } });
    expect(v1.statusCode).toBe(401);
    expect(v1.headers['www-authenticate']).toBeUndefined();
    const suspendu = await server.inject({ method: 'POST', url: '/mcp', headers: entetes(API, JETON_SUSPENDU.brut), payload: ping });
    expect(suspendu.statusCode).toBe(403);
    expect(suspendu.headers['www-authenticate']).toBeUndefined();
    const ok = await server.inject({ method: 'POST', url: '/mcp', headers: entetes(API, JETON.brut), payload: ping });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['www-authenticate']).toBeUndefined();
    const trop = await server.inject({ method: 'POST', url: '/mcp', headers: entetes(API, JETON.brut), payload: ping });
    expect(trop.statusCode).toBe(429);
    expect(trop.headers['www-authenticate']).toBeUndefined();
    await server.close();
  });
});

describe('qui signe une écriture faite par /mcp', () => {
  it('🔴 avec un jeton, la personne qui l’a autorisé signe la réponse, origine `mcp` ; avec une clé, personne', async () => {
    const { server, traces } = monter();
    const args = { conversation_id: 'cv1', text: 'bonjour' };
    const parJeton = await server.inject({ method: 'POST', url: '/mcp', headers: entetes(API, JETON.brut), payload: appeler('reply_in_open_window', args) });
    expect(parJeton.json<{ result: { isError: boolean } }>().result.isError).toBe(false);
    await server.inject({ method: 'POST', url: '/mcp', headers: entetes(API, CLE), payload: appeler('reply_in_open_window', args) });
    expect(traces.envois).toEqual([{ auteur: 'u-admin', origine: 'mcp' }, { auteur: null, origine: 'mcp' }]);
    await server.close();
  });

  it('🔴 avec un jeton, la personne est l’acteur d’une assignation ; avec une clé, la cause « agent tiers »', async () => {
    const { server, traces } = monter();
    const args = { conversation_id: 'cv1', member_id: 'u2' };
    await server.inject({ method: 'POST', url: '/mcp', headers: entetes(API, JETON.brut), payload: appeler('assign_conversation', args) });
    await server.inject({ method: 'POST', url: '/mcp', headers: entetes(API, CLE), payload: appeler('assign_conversation', args) });
    expect(traces.assignations).toEqual([{ collaborateur: 'u-admin' }, { cause: 'automatique : agent tiers (MCP)' }]);
    await server.close();
  });
});
