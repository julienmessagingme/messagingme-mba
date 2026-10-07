import { describe, it, expect, beforeAll } from 'vitest';
import { decodeJwt } from 'jose';
import Fastify, { type FastifyRequest } from 'fastify';
import { buildServer } from '../src/server';
import { registerEspaces } from '../src/http/espaces';
import { monterAvecEtapeEspace } from '../src/http/scope';
import { FakeQueue } from './fake-queue';
import { signSession, verifySession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { ComptesAuthDep } from '../src/auth/routes';

/**
 * CHANGER D'ESPACE SANS SE DÉCONNECTER (RC3, `src/http/espaces.ts`).
 *
 * 🔴 Une route qui SIGNE une session : c'est l'endroit où une erreur ouvre un espace à quelqu'un qui n'y a pas de
 * compte, ou prolonge une session sans fin. Ces cas tiennent la liste (identité de la session, filtres de la
 * connexion), la bascule (rôle de CE compte, 404 hors liste), l'échéance conservée et le refus de l'observation.
 */

const SECRET = 'test-secret';
const MOI = 'julien@exemple.fr';
type Compte = { id: string; tenantId: string; tenantName: string; role: string; disabled: boolean };
const COMPTES: Record<string, Compte[]> = {
  [MOI]: [
    { id: 'u1', tenantId: 't1', tenantName: 'Alpha', role: 'admin', disabled: false },
    { id: 'u2', tenantId: 't2', tenantName: 'Beta', role: 'agent', disabled: false },
    // Espace suspendu : la garde refuserait toute session dessus.
    { id: 'u3', tenantId: 't3', tenantName: 'Gamma', role: 'admin', disabled: false },
    // Compte révoqué dans cet espace.
    { id: 'u4', tenantId: 't4', tenantName: 'Delta', role: 'admin', disabled: true },
  ],
  // Une autre identité : son espace ne doit jamais apparaître ni s'ouvrir.
  'autre@exemple.fr': [{ id: 'u9', tenantId: 't9', tenantName: 'Étranger', role: 'admin', disabled: false }],
};
const tous = (): Compte[] => Object.values(COMPTES).flat();
const adresseDe = (userId: string): string | undefined =>
  Object.entries(COMPTES).find(([, cs]) => cs.some((c) => c.id === userId))?.[0];

const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

function app(over: { lus?: string[]; connexions?: string[] } = {}) {
  const comptes: ComptesAuthDep = {
    getSessionUser: async (userId) => {
      over.lus?.push(userId);
      const c = tous().find((x) => x.id === userId);
      const email = adresseDe(userId);
      return c && email ? { tenantId: c.tenantId, role: c.role, email } : null;
    },
    getByEmail: async (email) => COMPTES[email] ?? [],
    touchLastLogin: async (userId) => { over.connexions?.push(userId); },
  };
  return buildServer({
    queue: new FakeQueue(),
    auth: {
      users: noUsers,
      secret: SECRET,
      comptes,
      getUserState: async (userId) => {
        const c = tous().find((x) => x.id === userId);
        return c ? { role: c.role, disabled: c.disabled, tenantStatus: c.tenantId === 't3' ? 'locked' : 'active', horsOffre: null } : null;
      },
    },
    me: { getById: async () => null },
  });
}

let adminT1 = '';
let observation = '';
beforeAll(async () => {
  adminT1 = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  observation = await signSession({ userId: 'ops-observation', tenantId: 't1', role: 'admin', impersonated: true, observateur: 'ops@exemple.fr' }, SECRET);
});

describe('GET /tenants/:tenantId/espaces', () => {
  it('rend les espaces de l’identité de la session, marque l’actuel, sans espace suspendu, révoqué ni étranger', async () => {
    const a = app();
    const r = await a.inject({ method: 'GET', url: '/tenants/t1/espaces', ...h(adminT1) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      espaces: [
        { tenantId: 't1', tenantName: 'Alpha', role: 'admin', actuel: true },
        { tenantId: 't2', tenantName: 'Beta', role: 'agent', actuel: false },
      ],
    });
    await a.close();
  });

  it('🔴 l’espace de l’URL doit être celui de la session (403 sinon)', async () => {
    const a = app();
    const r = await a.inject({ method: 'GET', url: '/tenants/t2/espaces', ...h(adminT1) });
    expect(r.statusCode).toBe(403);
    await a.close();
  });

  it('sans jeton : 401', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/espaces' })).statusCode).toBe(401);
    await a.close();
  });

  it('🔴 la session d’observation : une liste vide, sans lire aucun compte', async () => {
    const lus: string[] = [];
    const a = app({ lus });
    const r = await a.inject({ method: 'GET', url: '/tenants/t1/espaces', ...h(observation) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ espaces: [] });
    expect(lus).toEqual([]);
    await a.close();
  });
});

describe('POST /tenants/:tenantId/changer-espace', () => {
  const basculer = (a: ReturnType<typeof app>, jeton: string, tenantId: unknown, depuis = 't1') =>
    a.inject({ method: 'POST', url: `/tenants/${depuis}/changer-espace`, ...h(jeton), payload: { tenantId } });

  it('🔴 vers un espace de l’identité : une session sur CET espace, avec le rôle de CE compte', async () => {
    const connexions: string[] = [];
    const a = app({ connexions });
    const r = await basculer(a, adminT1, 't2');
    expect(r.statusCode).toBe(200);
    const corps = r.json() as { token: string; user: unknown };
    expect(corps.user).toEqual({ email: MOI, role: 'agent', tenantId: 't2' });
    expect(await verifySession(corps.token, SECRET)).toEqual({ userId: 'u2', tenantId: 't2', role: 'agent' });
    expect(connexions).toEqual(['u2']);
    // La session neuve ouvre l'espace cible, et lui seul.
    expect((await a.inject({ method: 'GET', url: '/tenants/t2/espaces', ...h(corps.token) })).json()).toMatchObject({
      espaces: [{ tenantId: 't1', actuel: false }, { tenantId: 't2', actuel: true }],
    });
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/espaces', ...h(corps.token) })).statusCode).toBe(403);
    // Et l'on revient de la même façon, admin de nouveau.
    const retour = await basculer(a, corps.token, 't1', 't2');
    expect(retour.statusCode).toBe(200);
    expect(await verifySession((retour.json() as { token: string }).token, SECRET)).toEqual({ userId: 'u1', tenantId: 't1', role: 'admin' });
    await a.close();
  });

  it('🔴 vers un espace étranger, suspendu, révoqué ou inexistant : 404, jamais 403, et aucune session', async () => {
    const connexions: string[] = [];
    const a = app({ connexions });
    for (const cible of ['t9', 't3', 't4', 'inconnu']) {
      const r = await basculer(a, adminT1, cible);
      expect(r.statusCode, cible).toBe(404);
      expect(r.json(), cible).toEqual({ error: 'espace introuvable' });
    }
    expect(connexions).toEqual([]);
    await a.close();
  });

  it('🔴 la session neuve garde l’ÉCHÉANCE de la présentée : basculer ne prolonge rien', async () => {
    // Une session à qui il reste 30 minutes : sa remplaçante n'en a pas 12 h.
    const courte = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET, '30m');
    const a = app();
    const r = await basculer(a, courte, 't2');
    expect(r.statusCode).toBe(200);
    const neuve = (r.json() as { token: string }).token;
    expect(decodeJwt(neuve).exp).toBe(decodeJwt(courte).exp);
    await a.close();
  });

  it('🔴 une session d’observation ne bascule pas : 403, et aucune session', async () => {
    const lus: string[] = [];
    const a = app({ lus });
    const r = await basculer(a, observation, 't2');
    expect(r.statusCode).toBe(403);
    expect(r.json()).not.toHaveProperty('token');
    expect(lus).toEqual([]);
    await a.close();
  });

  it('un corps sans espace : 400', async () => {
    const a = app();
    expect((await basculer(a, adminT1, undefined)).statusCode).toBe(400);
    expect((await basculer(a, adminT1, 42)).statusCode).toBe(400);
    await a.close();
  });

  it('sans jeton : 401', async () => {
    const a = app();
    const r = await a.inject({ method: 'POST', url: '/tenants/t1/changer-espace', headers: { 'content-type': 'application/json' }, payload: { tenantId: 't2' } });
    expect(r.statusCode).toBe(401);
    await a.close();
  });

  it('🔴 la ROUTE elle-même refuse l’observation, même derrière une garde qui la laisserait passer', async () => {
    // Le cas ci-dessus est refusé par la garde (`impersonation_read_only`) avant la route : il resterait vert si la
    // route perdait son propre refus. Ici la garde laisse passer une session d'emprunt, et c'est la route qui dit non.
    const a = Fastify();
    const laisserPasser = async (req: FastifyRequest): Promise<void> => {
      req.auth = { userId: 'u1', tenantId: 't1', role: 'admin', impersonated: true, observateur: 'ops@exemple.fr' };
    };
    const lus: string[] = [];
    const comptes = {
      getSessionUser: async (userId: string) => { lus.push(userId); return { tenantId: 't1', role: 'admin', email: MOI }; },
      getByEmail: async (email: string) => COMPTES[email] ?? [],
      touchLastLogin: async () => {},
    };
    monterAvecEtapeEspace(a, () => registerEspaces(a, { secret: SECRET, comptes }, laisserPasser));
    const r = await a.inject({ method: 'POST', url: '/tenants/t1/changer-espace', ...h(observation), payload: { tenantId: 't2' } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'session d’observation : elle ne change pas d’espace' });
    expect(lus).toEqual([]);
    await a.close();
  });
});
