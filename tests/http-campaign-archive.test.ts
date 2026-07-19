import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { CampaignRouteDeps } from '../src/http/campaigns';

/**
 * Archivage et suppression d'une campagne.
 *
 * Ce que ces tests protègent, et qui n'est pas lisible dans le code de la route :
 *  1. la SÉPARATION 404 / 409. Un 404 dit « cette campagne n'est pas à toi », un 409 dit « elle est à toi mais
 *     elle est déjà partie ». Les confondre renverrait « inconnue » sur une campagne que l'utilisateur voit à
 *     l'écran, et l'interface ne pourrait plus proposer l'archivage en repli.
 *  2. l'ORDRE des barrières. Le contrôle d'appartenance doit précéder toute écriture, sinon un identifiant
 *     deviné suffirait à archiver la campagne d'un autre client avant de recevoir son 404.
 *  3. le filtre `?archived` est une ALLOWLIST : une query string bricolée ne doit jamais ouvrir la corbeille.
 */
const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (tok: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` } });

interface Calls {
  list: Array<{ archived?: boolean } | undefined>;
  writes: string[];
}

/** `known` appartient à t1 ; tout autre id est inconnu. `deleteOk` simule la garde métier du store. */
function appWith(calls: Calls, deleteOk = true) {
  const campaigns: CampaignRouteDeps = {
    repo: {} as CampaignRouteDeps['repo'],
    queue: new FakeQueue(),
    phoneNumberBelongsToTenant: async () => true,
    campaignBelongsTo: async (id, tenant) => id === 'known' && tenant === 't1',
    getRunSizing: async () => ({ ratePerMinute: null, pendingCount: 0 }),
    scheduleCampaign: async () => true,
    cancelSchedule: async () => true,
    getWorkflowGraph: async () => null,
    listCampaigns: async (_tenant, opts) => { calls.list.push(opts); return []; },
    archiveCampaign: async (id) => { calls.writes.push(`archive:${id}`); return true; },
    unarchiveCampaign: async (id) => { calls.writes.push(`unarchive:${id}`); return true; },
    deleteDraftCampaign: async (id) => { calls.writes.push(`delete:${id}`); return deleteOk; },
    getCampaignDetail: async () => null,
    listPhoneNumbers: async () => [],
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, campaigns });
}
const fresh = (): Calls => ({ list: [], writes: [] });

describe('archivage de campagne', () => {
  it('archive puis désarchive une campagne du tenant', async () => {
    const calls = fresh();
    const app = appWith(calls);
    const a = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns/known/archive', ...h(adminTok) });
    expect(a.statusCode).toBe(200);
    expect(a.json<{ archived: boolean }>().archived).toBe(true);
    const u = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns/known/unarchive', ...h(adminTok) });
    expect(u.statusCode).toBe(200);
    expect(u.json<{ archived: boolean }>().archived).toBe(false);
    expect(calls.writes).toEqual(['archive:known', 'unarchive:known']);
    await app.close();
  });

  it('campagne inconnue du tenant -> 404 SANS écriture (la barrière précède l’action)', async () => {
    const calls = fresh();
    const app = appWith(calls);
    for (const url of [
      '/tenants/t1/campaigns/inconnue/archive',
      '/tenants/t1/campaigns/inconnue/unarchive',
    ]) {
      const res = await app.inject({ method: 'POST', url, ...h(adminTok) });
      expect(res.statusCode).toBe(404);
    }
    const del = await app.inject({ method: 'DELETE', url: '/tenants/t1/campaigns/inconnue', ...h(adminTok) });
    expect(del.statusCode).toBe(404);
    // L'invariant : aucune de ces trois requêtes n'a atteint le store.
    expect(calls.writes).toEqual([]);
    await app.close();
  });

  it('tenant de l’URL != tenant du token -> 403', async () => {
    const app = appWith(fresh());
    const res = await app.inject({ method: 'POST', url: '/tenants/AUTRE/campaigns/known/archive', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('agent -> 403 sur les trois écritures (mutations réservées aux admins)', async () => {
    const calls = fresh();
    const app = appWith(calls);
    const a = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns/known/archive', ...h(agentTok) });
    const u = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns/known/unarchive', ...h(agentTok) });
    const d = await app.inject({ method: 'DELETE', url: '/tenants/t1/campaigns/known', ...h(agentTok) });
    expect([a.statusCode, u.statusCode, d.statusCode]).toEqual([403, 403, 403]);
    expect(calls.writes).toEqual([]);
    await app.close();
  });

  it('suppression d’un brouillon jamais lancé -> 200', async () => {
    const calls = fresh();
    const app = appWith(calls, true);
    const res = await app.inject({ method: 'DELETE', url: '/tenants/t1/campaigns/known', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ deleted: boolean }>().deleted).toBe(true);
    expect(calls.writes).toEqual(['delete:known']);
    await app.close();
  });

  it('suppression d’une campagne DÉJÀ LANCÉE -> 409, pas 404', async () => {
    // C'est la distinction qui compte : la campagne existe et appartient bien à l'appelant, ce que 404 nierait.
    const app = appWith(fresh(), false);
    const res = await app.inject({ method: 'DELETE', url: '/tenants/t1/campaigns/known', ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('archivée');
    await app.close();
  });
});

describe('filtre ?archived de la liste', () => {
  it('absent -> campagnes actives ; « 1 » et « true » -> archivées', async () => {
    const calls = fresh();
    const app = appWith(calls);
    for (const qs of ['', '?archived=1', '?archived=true']) {
      const res = await app.inject({ method: 'GET', url: `/tenants/t1/campaigns${qs}`, ...h(adminTok) });
      expect(res.statusCode).toBe(200);
    }
    expect(calls.list).toEqual([{ archived: false }, { archived: true }, { archived: true }]);
    await app.close();
  });

  it('toute autre valeur retombe sur les campagnes ACTIVES (allowlist, pas devinette)', async () => {
    const calls = fresh();
    const app = appWith(calls);
    // 'oui' et 'yes' sont des vraisemblances : une allowlist les refuse, un `Boolean(q.archived)` les accepterait
    // et montrerait la corbeille à qui tape n'importe quoi. '0' et 'false' doivent évidemment rester actifs.
    for (const v of ['0', 'false', 'oui', 'yes', 'TRUE', '']) {
      await app.inject({ method: 'GET', url: `/tenants/t1/campaigns?archived=${v}`, ...h(adminTok) });
    }
    expect(calls.list).toEqual(new Array(6).fill({ archived: false }));
    await app.close();
  });
});
