import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { RcsChannelCheck, RcsChannelInfo } from '../src/rcs/channel-info';

const SECRET = 'test-secret';
let adminToken = '';
let agentToken = '';
beforeAll(async () => {
  adminToken = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentToken = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const asAdmin = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` } });
const asAgent = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` } });

const CANAL: RcsChannelInfo = {
  channelId: 'ch-1', name: 'CANAL RCS (test)', agentName: 'MessagingMe', flow: 'MARKETING',
  dailyLimit: 500, dailyUsed: 0, monthlyLimit: 300, monthlyUsed: 12,
};

function appWith(opts: { check?: RcsChannelCheck; actif?: boolean } = {}) {
  const active: Array<{ tenant: string; apiKey: string }> = [];
  const app = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    rcsChannel: {
      etat: async () => (opts.actif ? { agentId: 'ch-1', brandName: 'MessagingMe', displayName: 'Messaging Me (TEST)', status: 'testing', checkedAt: null } : null),
      verifier: async () => opts.check ?? { ok: true, channel: CANAL },
      activer: async (tenant, _canal, apiKey) => { active.push({ tenant, apiKey }); },
      desactiver: async () => opts.actif === true,
    },
  });
  return { app, active };
}

describe('Activation du canal RCS', () => {
  it('dit que le canal est ETEINT quand aucun agent n est pose', async () => {
    const { app } = appWith();
    const r = await app.inject({ method: 'GET', url: '/tenants/t1/rcs/channel', ...asAdmin() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ active: false });
  });

  it('active le canal avec une cle valide et rend ce a quoi elle donne droit', async () => {
    const { app, active } = appWith();
    const r = await app.inject({ method: 'POST', url: '/tenants/t1/rcs/channel', ...asAdmin(), payload: { apiKey: '  ma-cle  ' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().channel).toMatchObject({ agentName: 'MessagingMe', flow: 'MARKETING', monthlyLimit: 300 });
    // La cle est enregistree DETOUREE des espaces, et jamais renvoyee dans la reponse.
    expect(active).toEqual([{ tenant: 't1', apiKey: 'ma-cle' }]);
    expect(JSON.stringify(r.json())).not.toContain('ma-cle');
  });

  it('REFUSE une cle de canal SMS en 422, avec la raison, et n enregistre RIEN', async () => {
    const { app, active } = appWith({
      check: { ok: false, reason: 'no_rcs_channel', detail: 'Cette clé ne donne pas accès à un canal RCS (canaux vus : SMS).' },
    });
    const r = await app.inject({ method: 'POST', url: '/tenants/t1/rcs/channel', ...asAdmin(), payload: { apiKey: 'cle-sms' } });
    // 422 et pas 500 : c'est une saisie a corriger, et un 5xx serait masque par la page d'erreur Cloudflare.
    expect(r.statusCode).toBe(422);
    expect(r.json().reason).toBe('no_rcs_channel');
    expect(r.json().error).toContain('SMS');
    expect(active).toEqual([]);
  });

  it('REFUSE une cle vide', async () => {
    const { app } = appWith();
    const r = await app.inject({ method: 'POST', url: '/tenants/t1/rcs/channel', ...asAdmin(), payload: { apiKey: '   ' } });
    expect(r.statusCode).toBe(400);
  });

  it('un AGENT peut LIRE l etat mais pas activer ni desactiver', async () => {
    const { app, active } = appWith({ actif: true });
    expect((await app.inject({ method: 'GET', url: '/tenants/t1/rcs/channel', ...asAgent() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/tenants/t1/rcs/channel', ...asAgent(), payload: { apiKey: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/tenants/t1/rcs/channel', ...asAgent() })).statusCode).toBe(403);
    expect(active).toEqual([]);
  });

  it('refuse le workspace d un AUTRE tenant', async () => {
    const { app } = appWith();
    expect((await app.inject({ method: 'GET', url: '/tenants/t-autre/rcs/channel', ...asAdmin() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/tenants/t-autre/rcs/channel', ...asAdmin(), payload: { apiKey: 'x' } })).statusCode).toBe(403);
  });

  it('desactive le canal', async () => {
    const { app } = appWith({ actif: true });
    const r = await app.inject({ method: 'DELETE', url: '/tenants/t1/rcs/channel', ...asAdmin() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ active: false });
  });
});
