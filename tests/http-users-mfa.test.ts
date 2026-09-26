import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore } from '../src/auth/store';
import type { UsersRouteDeps } from '../src/http/users';
import type { OpsRouteDeps } from '../src/http/ops';
import type { AuditSink } from '../src/audit/journal';
import { MfaEnMemoire } from './mfa';

/**
 * RÉINITIALISER LE SECOND FACTEUR D'UN MEMBRE (plan du 2026-09-25, tâche 6), par un admin de l'espace, et par
 * l'exploitation pour le cas qu'un admin d'espace ne doit pas trancher : une personne qui a des comptes ailleurs.
 */
const SECRET = 'test-secret-users-mfa';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const MEMBRE = '22222222-2222-4222-8222-222222222222';
const MULTI = '33333333-3333-4333-8333-333333333333';
const INCONNU = '44444444-4444-4444-8444-444444444444';
const noUsers: UserAuthStore = { findIdentity: async () => null };
const h = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

function app() {
  const mfa = new MfaEnMemoire([
    { userId: ADMIN, tenantId: 't1', role: 'admin', email: 'admin@x.fr' },
    { userId: MEMBRE, tenantId: 't1', role: 'admin', email: 'membre@x.fr' },
    { userId: MULTI, tenantId: 't1', role: 'agent', email: 'multi@x.fr' },
    { userId: 'ailleurs', tenantId: 't2', role: 'admin', email: 'multi@x.fr' },
  ]);
  mfa.poserFacteur('membre@x.fr');
  mfa.poserFacteur('multi@x.fr');
  const journal: Array<{ tenant: string; action: string; target: string; acteur: string | null }> = [];
  const audit: AuditSink = async (tenant, actor, action, target) => { journal.push({ tenant, action, target: target.id, acteur: actor.userId }); };
  const deps: UsersRouteDeps = {
    audit,
    listUsers: async () => [],
    setUserRole: async () => 'ok',
    setUserDisabled: async () => 'ok',
    deleteUser: async () => 'ok',
    reinitialiserMfa: (tenant, userId) => mfa.reinitialiserDansEspace(tenant, userId),
  };
  const reinitialisesOps: string[] = [];
  const ops: Partial<OpsRouteDeps> = {
    reinitialiserMfa: async (email) => {
      const identityId = await mfa.reinitialiserParEmail(email);
      if (identityId) reinitialisesOps.push(identityId);
      return identityId ? { identityId, espaces: 2 } : null;
    },
  };
  const server = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    admin: deps,
    ops: ops as OpsRouteDeps,
    opsToken: 'jeton-ops-de-test-assez-long-pour-passer',
  });
  return { server, mfa, journal, reinitialisesOps };
}

const jeton = (userId: string, role: string, tenantId = 't1') => signSession({ userId, tenantId, role }, SECRET);

describe('DELETE /tenants/:tenantId/users/:userId/mfa', () => {
  it('un admin réinitialise le facteur d’un membre de SON espace, et le journal nomme l’acteur et la cible', async () => {
    const { server, mfa, journal } = app();
    const res = await server.inject({ method: 'DELETE', url: `/tenants/t1/users/${MEMBRE}/mfa`, ...h(await jeton(ADMIN, 'admin')) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: MEMBRE, mfaReinitialise: true });
    expect(mfa.estActif('membre@x.fr')).toBe(false);
    expect(journal).toEqual([{ tenant: 't1', action: 'mfa.reinitialise', target: MEMBRE, acteur: ADMIN }]);
    await server.close();
  });

  it('🔴 refusé (409) si la personne a un compte dans un AUTRE espace : son facteur reste en place', async () => {
    const { server, mfa, journal } = app();
    const res = await server.inject({ method: 'DELETE', url: `/tenants/t1/users/${MULTI}/mfa`, ...h(await jeton(ADMIN, 'admin')) });
    expect(res.statusCode).toBe(409);
    expect(mfa.estActif('multi@x.fr')).toBe(true);
    expect(journal).toEqual([]);
    await server.close();
  });

  it('🔴 réservé aux admins (403), à SON espace (403), et jamais sur soi-même (400)', async () => {
    const { server, mfa } = app();
    const agent = await server.inject({ method: 'DELETE', url: `/tenants/t1/users/${MEMBRE}/mfa`, ...h(await jeton(MULTI, 'agent')) });
    expect(agent.statusCode).toBe(403);
    const autreEspace = await server.inject({ method: 'DELETE', url: `/tenants/t1/users/${MEMBRE}/mfa`, ...h(await jeton(ADMIN, 'admin', 't2')) });
    expect(autreEspace.statusCode).toBe(403);
    const soi = await server.inject({ method: 'DELETE', url: `/tenants/t1/users/${ADMIN}/mfa`, ...h(await jeton(ADMIN, 'admin')) });
    expect(soi.statusCode).toBe(400);
    expect(mfa.estActif('membre@x.fr')).toBe(true);
    expect((await server.inject({ method: 'DELETE', url: `/tenants/t1/users/${MEMBRE}/mfa` })).statusCode).toBe(401);
    await server.close();
  });

  it('un membre inconnu ou un identifiant mal formé : 404, jamais un 500', async () => {
    const { server } = app();
    const tok = await jeton(ADMIN, 'admin');
    expect((await server.inject({ method: 'DELETE', url: `/tenants/t1/users/${INCONNU}/mfa`, ...h(tok) })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: '/tenants/t1/users/pas-un-uuid/mfa', ...h(tok) })).statusCode).toBe(404);
    await server.close();
  });
});

describe('POST /ops/mfa/reinitialiser', () => {
  const ops = { 'x-ops-token': 'jeton-ops-de-test-assez-long-pour-passer' };

  it('le cas multi-espace passe par l’exploitation, avec une note', async () => {
    const { server, mfa } = app();
    const res = await server.inject({ method: 'POST', url: '/ops/mfa/reinitialiser', headers: ops, payload: { email: 'Multi@x.fr', note: 'téléphone perdu, ticket 42' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reinitialise: true, espaces: 2 });
    expect(mfa.estActif('multi@x.fr')).toBe(false);
    await server.close();
  });

  it('🔴 sans jeton d’exploitation, ou avec une session d’admin : 401', async () => {
    const { server, reinitialisesOps } = app();
    const corps = { email: 'multi@x.fr', note: 'test' };
    expect((await server.inject({ method: 'POST', url: '/ops/mfa/reinitialiser', payload: corps })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/ops/mfa/reinitialiser', payload: corps, ...h(await jeton(ADMIN, 'admin')) })).statusCode).toBe(401);
    expect(reinitialisesOps).toEqual([]);
    await server.close();
  });

  it('note absente ou adresse manquante : 400 ; adresse inconnue : 404', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/ops/mfa/reinitialiser', headers: ops, payload: { email: 'multi@x.fr' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/ops/mfa/reinitialiser', headers: ops, payload: { note: 'une note' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/ops/mfa/reinitialiser', headers: ops, payload: { email: 'personne@x.fr', note: 'une note' } })).statusCode).toBe(404);
    await server.close();
  });
});
