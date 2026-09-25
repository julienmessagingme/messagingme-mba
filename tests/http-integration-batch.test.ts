import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { IntegrationBatchRouteDeps } from '../src/http/integration-batch';
import type { VueIntegrationBatch } from '../src/signaux/integration-batch.pg';

const SECRET = 'test-secret';
let admin = '';
let agent = '';
beforeAll(async () => {
  admin = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agent = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const en = (jeton: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` } });
const URL_T1 = '/tenants/t1/integrations/batch';
/** La cible d'audit : ce qui est branché (la remontée des signaux), jamais le nom de l'outil (spec § 10). */
const CIBLE = { kind: 'integration', id: 'signaux' };
const VUE: VueIntegrationBatch = {
  envoyerResume: false, sansIdentifiant: 12, sansIdentifiantLe: '2026-09-24T09:00:00.000Z', refusClesLe: null, majLe: '2026-09-24T08:00:00.000Z',
};

function monter(initial: VueIntegrationBatch | null = null, chiffrementPret = true) {
  const trace = {
    enregistre: [] as Array<{ tenant: string; r: { cleRest?: string; cleProjet?: string; envoyerResume: boolean } }>,
    supprime: [] as string[],
    audit: [] as Array<{ action: string; cible: unknown; detail: unknown }>,
  };
  let ligne = initial;
  const deps: IntegrationBatchRouteDeps = {
    chiffrementPret,
    lire: async () => ligne,
    enregistrer: async (tenant, r) => {
      trace.enregistre.push({ tenant, r });
      if (ligne === null && (r.cleRest === undefined || r.cleProjet === undefined)) return false;
      ligne = { envoyerResume: r.envoyerResume, sansIdentifiant: ligne?.sansIdentifiant ?? 0, sansIdentifiantLe: null, refusClesLe: null, majLe: '2026-09-24T10:00:00.000Z' };
      return true;
    },
    supprimer: async (tenant) => { trace.supprime.push(tenant); const avait = ligne !== null; ligne = null; return avait; },
    audit: async (_t, _acteur, action, cible, detail) => { trace.audit.push({ action, cible, detail }); },
  };
  const app = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, integrationBatch: deps });
  return { app, trace };
}

describe('le réglage de l’adaptateur Batch', () => {
  it('non branché : la lecture le dit', async () => {
    const { app } = monter();
    const r = await app.inject({ method: 'GET', url: URL_T1, ...en(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ branche: false });
  });

  it('branché : la lecture rend le compte des signaux non poussés, et jamais les clés', async () => {
    const { app } = monter(VUE);
    const r = await app.inject({ method: 'GET', url: URL_T1, ...en(admin) });
    expect(r.json()).toEqual({ branche: true, ...VUE });
  });

  it('🔴 un premier branchement sans les DEUX clés est refusé, sans rien écrire', async () => {
    const { app, trace } = monter();
    const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { cleRest: 'k', envoyerResume: false } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/clé REST et la clé de projet/);
    expect(trace.audit).toEqual([]);
  });

  it('brancher : clés détourées, réponse SANS clé, audit sans clé', async () => {
    const { app, trace } = monter();
    const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { cleRest: '  rest-1  ', cleProjet: 'projet-1', envoyerResume: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ branche: true, envoyerResume: false });
    expect(trace.enregistre).toEqual([{ tenant: 't1', r: { cleRest: 'rest-1', cleProjet: 'projet-1', envoyerResume: false } }]);
    expect(JSON.stringify(r.json())).not.toContain('rest-1');
    expect(trace.audit).toEqual([{ action: 'integration.branchee', cible: CIBLE, detail: { envoyerResume: false, clesChangees: true } }]);
    expect(JSON.stringify(trace.audit)).not.toContain('rest-1');
  });

  it('modifier l’option sans renvoyer les clés', async () => {
    const { app, trace } = monter(VUE);
    const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { envoyerResume: true } });
    expect(r.statusCode).toBe(200);
    expect(trace.enregistre[0]!.r).toEqual({ envoyerResume: true });
    expect(trace.audit).toEqual([{ action: 'integration.modifiee', cible: CIBLE, detail: { envoyerResume: true, clesChangees: false } }]);
  });

  it('🔴 un corps hors contrat est refusé AVANT toute écriture (clé inconnue, option absente, clé vide)', async () => {
    const { app, trace } = monter(VUE);
    for (const payload of [{ envoyerResume: true, url: 'https://ailleurs' }, { cleRest: 'k' }, { cleRest: '', envoyerResume: false }]) {
      const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(trace.enregistre).toEqual([]);
  });

  it('🔴 sans clé de chiffrement sur l’instance : des clés reçues sont refusées LISIBLEMENT, rien n’est écrit', async () => {
    const { app, trace } = monter(null, false);
    const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { cleRest: 'k', cleProjet: 'p', envoyerResume: false } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/chiffrement/);
    expect(trace.enregistre).toEqual([]);
    expect(trace.audit).toEqual([]);
  });

  it('sans clé de chiffrement, changer la seule option reste possible (rien à chiffrer)', async () => {
    const { app } = monter(VUE, false);
    const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { envoyerResume: true } });
    expect(r.statusCode).toBe(200);
  });

  it('débrancher, puis débrancher ce qui ne l’est plus', async () => {
    const { app, trace } = monter(VUE);
    expect((await app.inject({ method: 'DELETE', url: URL_T1, ...en(admin) })).json()).toEqual({ branche: false });
    expect(trace.audit).toEqual([{ action: 'integration.debranchee', cible: CIBLE, detail: {} }]);
    expect((await app.inject({ method: 'DELETE', url: URL_T1, ...en(admin) })).statusCode).toBe(404);
  });

  it('🔴 le journal des ACTIONS ne nomme pas l’outil : c’est un écran de la marque (spec § 10)', async () => {
    const { app, trace } = monter();
    await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { cleRest: 'rest-1', cleProjet: 'projet-1', envoyerResume: false } });
    await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { envoyerResume: true } });
    await app.inject({ method: 'DELETE', url: URL_T1, ...en(admin) });
    expect(trace.audit.map((a) => a.action)).toEqual(['integration.branchee', 'integration.modifiee', 'integration.debranchee']);
    // Cible ET détail : les deux s'affichent dans Sécurité > Journal des actions, et partent dans son export.
    expect(JSON.stringify(trace.audit)).not.toMatch(/batch/i);
  });

  it('🔴 un AGENT ne lit ni n’écrit rien : les clés de l’espace sont une décision d’admin', async () => {
    const { app, trace } = monter(VUE);
    expect((await app.inject({ method: 'GET', url: URL_T1, ...en(agent) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: URL_T1, ...en(agent), payload: { envoyerResume: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: URL_T1, ...en(agent) })).statusCode).toBe(403);
    expect(trace.enregistre).toEqual([]);
    expect(trace.supprime).toEqual([]);
  });

  it('🔴 l’espace d’un autre client dans l’adresse : refusé', async () => {
    const { app, trace } = monter(VUE);
    expect((await app.inject({ method: 'GET', url: '/tenants/t2/integrations/batch', ...en(admin) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/tenants/t2/integrations/batch', ...en(admin) })).statusCode).toBe(403);
    expect(trace.supprime).toEqual([]);
  });
});
