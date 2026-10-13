import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { Dossier, DossierStore } from '../src/dossiers/store.pg';
import { MAX_CLES_RANGEMENT } from '../src/http/dossiers';
import { MAX_NOM_DOSSIER, type TypeDossier } from '../src/dossiers/regles';

/**
 * Les routes des dossiers (décision de Julien du 2026-10-13, plan `docs/superpowers/plans/2026-10-13-dossiers-scenarios-
 * templates.md`), montées par `buildServer` : la garde est celle que le REGISTRE pose. Le magasin est un faux qui note
 * ce qu'il reçoit ; l'isolation en base (un dossier d'un autre espace refusé) est prouvée par le test d'intégration.
 */
const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
const D1 = '11111111-1111-4111-8111-111111111111';
const WF = '22222222-2222-4222-8222-222222222222';

function app(o: { creer?: Dossier | 'pris' | 'plein'; renommer?: Dossier | 'pris' | null; supprimer?: boolean; ranger?: number | 'dossier_inconnu' } = {}) {
  const appels: Array<{ fn: string; args: unknown[] }> = [];
  const note = (fn: string, args: unknown[]) => { appels.push({ fn, args }); };
  const dossiers: DossierStore = {
    lister: async (...a) => { note('lister', a); return [{ id: D1, nom: 'SAV' }]; },
    rangement: async (...a) => { note('rangement', a); return { [WF]: D1 }; },
    creer: async (...a) => { note('creer', a); return o.creer ?? { id: D1, nom: String(a[2]) }; },
    renommer: async (...a) => { note('renommer', a); return o.renommer === undefined ? { id: D1, nom: String(a[2]) } : o.renommer; },
    supprimer: async (...a) => { note('supprimer', a); return o.supprimer ?? true; },
    ranger: async (...a) => { note('ranger', a); return o.ranger ?? (a[2] as string[]).length; },
  };
  const server = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, dossiers });
  return { server, appels };
}
const url = (suite = '') => `/tenants/t1/dossiers${suite}`;

describe('les routes des dossiers', () => {
  it('🔴 la liste rend les dossiers ET le rangement, à toute session de l’espace, pour SON espace', async () => {
    const { server, appels } = app();
    const res = await server.inject({ method: 'GET', url: `${url()}?type=scenario`, ...h(agentTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dossiers: [{ id: D1, nom: 'SAV' }], rangement: { [WF]: D1 } });
    expect(appels.map((a) => a.args.slice(0, 2))).toEqual([['t1', 'scenario'], ['t1', 'scenario']]);
  });

  it('un type absent ou inconnu est refusé', async () => {
    const { server, appels } = app();
    expect((await server.inject({ method: 'GET', url: url(), ...h(adminTok) })).statusCode).toBe(400);
    expect((await server.inject({ method: 'GET', url: `${url()}?type=email`, ...h(adminTok) })).statusCode).toBe(400);
    expect(appels).toEqual([]);
  });

  it('🔴 un autre espace que celui du jeton est refusé avant le magasin', async () => {
    const { server, appels } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t2/dossiers?type=scenario', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    expect(appels).toEqual([]);
  });

  it('🔴 chaque écriture est réservée aux administrateurs', async () => {
    const { server, appels } = app();
    const essais = [
      { method: 'POST' as const, url: url(), payload: { type: 'scenario', nom: 'SAV' } },
      { method: 'PATCH' as const, url: url(`/${D1}`), payload: { nom: 'Support' } },
      { method: 'DELETE' as const, url: url(`/${D1}`) },
      { method: 'PUT' as const, url: url('/rangement'), payload: { type: 'scenario', cles: [WF], dossierId: D1 } },
    ];
    for (const e of essais) expect((await server.inject({ ...e, ...h(agentTok) })).statusCode, e.method).toBe(403);
    expect(appels).toEqual([]);
  });

  it('🔴 créer : le nom est ramené par trim, borné, et le magasin reçoit l’espace du JETON', async () => {
    const { server, appels } = app();
    const res = await server.inject({ method: 'POST', url: url(), ...h(adminTok), payload: { type: 'template', nom: '  Black Friday  ' } });
    expect(res.statusCode).toBe(201);
    expect(appels[0]).toEqual({ fn: 'creer', args: ['t1', 'template', 'Black Friday'] });
    for (const nom of ['', '   ', 'x'.repeat(MAX_NOM_DOSSIER + 1)]) {
      expect((await server.inject({ method: 'POST', url: url(), ...h(adminTok), payload: { type: 'scenario', nom } })).statusCode, `« ${nom.slice(0, 5)} »`).toBe(400);
    }
    // Un champ de trop (un tenantId glissé dans le corps) est refusé, pas ignoré.
    expect((await server.inject({ method: 'POST', url: url(), ...h(adminTok), payload: { type: 'scenario', nom: 'SAV', tenantId: 't2' } })).statusCode).toBe(400);
  });

  it('créer : 409 sur un nom pris, 422 au-delà du plafond', async () => {
    expect((await app({ creer: 'pris' }).server.inject({ method: 'POST', url: url(), ...h(adminTok), payload: { type: 'scenario', nom: 'SAV' } })).statusCode).toBe(409);
    expect((await app({ creer: 'plein' }).server.inject({ method: 'POST', url: url(), ...h(adminTok), payload: { type: 'scenario', nom: 'SAV' } })).statusCode).toBe(422);
  });

  it('renommer et supprimer : 404 sur un dossier inconnu ou un id qui n’est pas un uuid, sans toucher le magasin', async () => {
    const { server, appels } = app();
    expect((await server.inject({ method: 'PATCH', url: url('/pas-un-uuid'), ...h(adminTok), payload: { nom: 'X' } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: url('/pas-un-uuid'), ...h(adminTok) })).statusCode).toBe(404);
    expect(appels).toEqual([]);
    expect((await app({ renommer: null }).server.inject({ method: 'PATCH', url: url(`/${D1}`), ...h(adminTok), payload: { nom: 'X' } })).statusCode).toBe(404);
    expect((await app({ renommer: 'pris' }).server.inject({ method: 'PATCH', url: url(`/${D1}`), ...h(adminTok), payload: { nom: 'X' } })).statusCode).toBe(409);
    expect((await app({ supprimer: false }).server.inject({ method: 'DELETE', url: url(`/${D1}`), ...h(adminTok) })).statusCode).toBe(404);
  });

  it('🔴 ranger : chaque clé à la forme de son type, et le dossier inconnu rend 404', async () => {
    const { server, appels } = app();
    const ranger = (type: TypeDossier, cles: string[], dossierId: string | null) =>
      server.inject({ method: 'PUT', url: url('/rangement'), ...h(adminTok), payload: { type, cles, dossierId } });
    expect((await ranger('scenario', [WF], D1)).json()).toEqual({ ranges: 1 });
    expect((await ranger('template', ['promo_ete', 'promo_ete'], null)).statusCode).toBe(200);
    // Un nom de template n'est pas un id de scénario, et inversement : refusés avant le magasin.
    expect((await ranger('scenario', ['promo_ete'], D1)).statusCode).toBe(400);
    expect((await ranger('template', ['Promo Été'], D1)).statusCode).toBe(400);
    expect((await ranger('scenario', [WF], 'pas-un-uuid')).statusCode).toBe(400);
    expect((await ranger('scenario', Array.from({ length: MAX_CLES_RANGEMENT + 1 }, () => WF), D1)).statusCode).toBe(400);
    expect(appels.map((a) => a.args)).toEqual([['t1', 'scenario', [WF], D1], ['t1', 'template', ['promo_ete', 'promo_ete'], null]]);
    expect((await app({ ranger: 'dossier_inconnu' }).server.inject({ method: 'PUT', url: url('/rangement'), ...h(adminTok), payload: { type: 'scenario', cles: [WF], dossierId: D1 } })).statusCode).toBe(404);
  });
});
