import { describe, it, expect, beforeAll } from 'vitest';
import { sansPortailHubspot } from './hubspot';
import { GRILLE_DEFAUT } from '../src/stats/prix';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { SettingsRouteDeps } from '../src/http/settings';

/**
 * LE RÉGLAGE « LES AGENTS PEUVENT PRENDRE UNE CONVERSATION DU POT COMMUN » (migration 0160, demande de Julien
 * du 2026-09-19 : « une option à la main des admins et des managers »).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : c'est la SEULE écriture du module de réglages ouverte à l'encadrement. Tout
 * le reste de ce module est monté sous la garde d'administration ; une erreur de garde ici ferait soit taire
 * le manager (le réglage lui serait promis et refusé), soit ouvrir l'écriture aux agents, qui pourraient
 * alors s'autoriser eux-mêmes à se servir.
 */
const SECRET = 'test-secret';
const tok = { admin: '', manager: '', agent: '' };
beforeAll(async () => {
  tok.admin = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  tok.manager = await signSession({ userId: 'u2', tenantId: 't1', role: 'manager' }, SECRET);
  tok.agent = await signSession({ userId: 'u3', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
const URL = '/tenants/t1/settings/agents-peuvent-prendre';

function app(o: { cable?: boolean } = {}) {
  const ecrits: boolean[] = [];
  let courant = false;
  const settings: SettingsRouteDeps = {
    // Aucun portail lie : c est le defaut, et la fixture le DIT (cf. `tests/hubspot.ts`).
    hubspotPortalConnecte: sansPortailHubspot,
    getSettings: async () => ({
      mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false,
      controlHandbackSeconds: null, mbaHandoffMode: null, agentTransfertMode: null, agentsPeuventPrendre: courant,
      optoutRequestId: null, mentionIaFrequence: null, timezone: 'Europe/Paris', businessHours: {}, prix: GRILLE_DEFAUT,
    }),
    setMbaEnabled: async () => {},
    setHubspotListsEnabled: async () => {},
    setMbaHandoffMode: async () => {},
    setControlHandbackSeconds: async () => {},
    setTimezone: async () => {},
    setBusinessHours: async () => {},
    ...(o.cable === false ? {} : { setAgentsPeuventPrendre: async (_t: string, actif: boolean) => { ecrits.push(actif); courant = actif; } }),
  };
  return { ecrits, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, settings }) };
}

describe('le réglage « les agents peuvent prendre »', () => {
  it('🔴 un MANAGER le lit ET l’écrit : c’est la demande de Julien', async () => {
    const { srv, ecrits } = app();
    expect((await srv.inject({ method: 'GET', url: URL, ...h(tok.manager) })).json()).toEqual({ actif: false });
    const res = await srv.inject({ method: 'PATCH', url: URL, ...h(tok.manager), payload: { actif: true } });
    expect(res.statusCode).toBe(200);
    expect(ecrits).toEqual([true]);
    expect((await srv.inject({ method: 'GET', url: URL, ...h(tok.manager) })).json()).toEqual({ actif: true });
    await srv.close();
  });

  it('un admin aussi', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'PATCH', url: URL, ...h(tok.admin), payload: { actif: true } })).statusCode).toBe(200);
    await srv.close();
  });

  it('🔴 un AGENT ne peut ni le lire ni surtout l’écrire : il s’autoriserait lui-même', async () => {
    const { srv, ecrits } = app();
    expect((await srv.inject({ method: 'GET', url: URL, ...h(tok.agent) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'PATCH', url: URL, ...h(tok.agent), payload: { actif: true } })).statusCode).toBe(403);
    expect(ecrits).toEqual([]);
    await srv.close();
  });

  it('🔴 le reste de Paramètres reste FERMÉ au manager', async () => {
    // L'ouverture est UNE route, pas le module : le fuseau, les prix et la lecture complète restent admin.
    const { srv } = app();
    expect((await srv.inject({ method: 'GET', url: '/tenants/t1/settings', ...h(tok.manager) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'PATCH', url: '/tenants/t1/settings/timezone', ...h(tok.manager), payload: { timezone: 'Europe/Paris' } })).statusCode).toBe(403);
    await srv.close();
  });

  it('une valeur qui n’est pas un booléen est refusée, jamais lue comme « activé »', async () => {
    const { srv, ecrits } = app();
    for (const actif of ['true', 1, null, undefined]) {
      expect((await srv.inject({ method: 'PATCH', url: URL, ...h(tok.manager), payload: { actif } })).statusCode).toBe(400);
    }
    expect(ecrits).toEqual([]);
    await srv.close();
  });

  it('écriture non câblée : 503, jamais un « enregistré » qui n’écrit rien', async () => {
    const { srv } = app({ cable: false });
    expect((await srv.inject({ method: 'PATCH', url: URL, ...h(tok.manager), payload: { actif: true } })).statusCode).toBe(503);
    await srv.close();
  });

  it('tenant croisé : 403', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'PATCH', url: '/tenants/AUTRE/settings/agents-peuvent-prendre', ...h(tok.manager), payload: { actif: true } })).statusCode).toBe(403);
    await srv.close();
  });
});
