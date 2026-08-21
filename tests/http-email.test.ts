import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { EmailRoutesDeps, EmailAccountsDep, EmailTemplatesDep, EmailResolverDep } from '../src/http/email';
import type { EmailAccount, EmailAccountInput, EmailAccountUpdate, EmailTemplate, EmailTemplateInput, EmailTemplateUpdate } from '../src/email/types';

/**
 * Tests d'intégration des routes email (comptes SMTP + modèles), calqués sur tests/http-mba.test.ts :
 * `buildServer` réel (même auth JWT, même montage que la prod), mais stores/résolveur FACTICES en mémoire
 * (pas de Postgres, pas de vraie connexion SMTP).
 */

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
let autreTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  autreTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

let seq = 0;
const nextId = () => `acc${++seq}`;

type StoredAccount = EmailAccount & { password: string };

/** Store de comptes FACTICE en mémoire, même contrat que PgEmailAccountStore (CRUD scopé tenant). */
function fakeAccountsStore(): { dep: EmailAccountsDep; rows: Map<string, StoredAccount> } {
  const rows = new Map<string, StoredAccount>();
  const dep: EmailAccountsDep = {
    list: async (tenantId) => [...rows.values()].filter((r) => r.tenantId === tenantId).map(({ password: _password, ...a }) => a),
    create: async (tenantId, input: EmailAccountInput) => {
      const id = nextId();
      const row: StoredAccount = {
        id, tenantId, label: input.label, host: input.host, port: input.port, secure: input.secure,
        username: input.username, password: input.password, fromAddress: input.fromAddress,
        fromName: input.fromName ?? null, replyTo: input.replyTo ?? null, verifiedAt: null,
        createdAt: new Date().toISOString(),
      };
      rows.set(id, row);
      const { password: _password, ...a } = row;
      return a;
    },
    update: async (tenantId, id, patch: EmailAccountUpdate) => {
      const row = rows.get(id);
      if (!row || row.tenantId !== tenantId) return null;
      Object.assign(row, patch);
      const { password: _password, ...a } = row;
      return a;
    },
    softDelete: async (tenantId, id) => {
      const row = rows.get(id);
      if (!row || row.tenantId !== tenantId) return false;
      rows.delete(id);
      return true;
    },
    markVerified: async (tenantId, id) => {
      const row = rows.get(id);
      if (row && row.tenantId === tenantId) row.verifiedAt = new Date().toISOString();
    },
  };
  return { dep, rows };
}

/** Store de modèles FACTICE en mémoire, même contrat que PgEmailTemplateStore. */
function fakeTemplatesStore(): { dep: EmailTemplatesDep; rows: Map<string, EmailTemplate> } {
  const rows = new Map<string, EmailTemplate>();
  const dep: EmailTemplatesDep = {
    list: async (tenantId) => [...rows.values()].filter((r) => r.tenantId === tenantId),
    create: async (tenantId, input: EmailTemplateInput) => {
      const id = nextId();
      const row: EmailTemplate = {
        id, tenantId, name: input.name, format: input.format, subject: input.subject, body: input.body,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      rows.set(id, row);
      return row;
    },
    update: async (tenantId, id, patch: EmailTemplateUpdate) => {
      const row = rows.get(id);
      if (!row || row.tenantId !== tenantId) return null;
      Object.assign(row, patch);
      return row;
    },
    softDelete: async (tenantId, id) => {
      const row = rows.get(id);
      if (!row || row.tenantId !== tenantId) return false;
      rows.delete(id);
      return true;
    },
  };
  return { dep, rows };
}

/** Résolveur FACTICE : sert un transport dont `sendMail` est injectable (succès ou échec), sans jamais
 *  toucher le réseau. `as never` pour le cast de transport factice : même convention que tests/email-smtp.test.ts. */
function fakeResolver(accountRows: Map<string, StoredAccount>, sendMail: (msg: unknown) => Promise<unknown>): { dep: EmailResolverDep; invalidated: string[] } {
  const invalidated: string[] = [];
  const dep: EmailResolverDep = {
    getTransport: async (tenantId, accountId) => {
      const row = accountRows.get(accountId);
      if (!row || row.tenantId !== tenantId) return null;
      return { transport: { sendMail } as never, account: { ...row } };
    },
    invalidate: (accountId) => { invalidated.push(accountId); },
  };
  return { dep, invalidated };
}

function app(sendMail: (msg: unknown) => Promise<unknown> = vi.fn().mockResolvedValue({})) {
  const accounts = fakeAccountsStore();
  const templates = fakeTemplatesStore();
  const resolver = fakeResolver(accounts.rows, sendMail);
  const deps: EmailRoutesDeps = { accounts: accounts.dep, templates: templates.dep, resolver: resolver.dep };
  const server = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, email: deps });
  return { server, accountRows: accounts.rows, templateRows: templates.rows, invalidated: resolver.invalidated };
}

const validAccountPayload = {
  label: 'support', host: 'ssl0.ovh.net', port: 465, secure: true,
  username: 'support@exemple.fr', password: 's3cr3t', fromAddress: 'support@exemple.fr',
};

describe('routes email : comptes SMTP', () => {
  it('agent (non-admin) -> 403 sur la création', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/email/accounts', ...h(agentTok), payload: validAccountPayload });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('admin crée un compte -> 200, sans password ni password_enc, avec hasPassword:true', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/email/accounts', ...h(adminTok), payload: validAccountPayload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.password).toBeUndefined();
    expect(body.password_enc).toBeUndefined();
    expect(body.hasPassword).toBe(true);
    expect(body.label).toBe('support');
    await server.close();
  });

  it('corps invalide (port hors bornes, adresse non email) -> 400', async () => {
    const { server } = app();
    const bad = async (payload: object) => (await server.inject({ method: 'POST', url: '/tenants/t1/email/accounts', ...h(adminTok), payload })).statusCode;
    expect(await bad({ ...validAccountPayload, port: 999999 })).toBe(400);
    expect(await bad({ ...validAccountPayload, fromAddress: 'pas-un-email' })).toBe(400);
    expect(await bad({ label: 'x' })).toBe(400);
    await server.close();
  });

  it('tenant croisé -> 403 (dérivé du JWT, jamais de l’URL)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/email/accounts', ...h(autreTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('list isole par tenant : un compte créé pour t1 est invisible pour un autre tenant', async () => {
    const { server } = app();
    await server.inject({ method: 'POST', url: '/tenants/t1/email/accounts', ...h(adminTok), payload: validAccountPayload });
    const autreTenantTok = await signSession({ userId: 'u9', tenantId: 't9', role: 'admin' }, SECRET);
    const res = await server.inject({ method: 'GET', url: '/tenants/t9/email/accounts', ...h(autreTenantTok) });
    expect(res.json().accounts).toEqual([]);
    await server.close();
  });

  it('PATCH inconnu -> 404 ; PATCH existant invalide le transport en cache', async () => {
    const { server, invalidated } = app();
    const created = (await server.inject({ method: 'POST', url: '/tenants/t1/email/accounts', ...h(adminTok), payload: validAccountPayload })).json();
    const notFound = await server.inject({ method: 'PATCH', url: '/tenants/t1/email/accounts/inconnu', ...h(adminTok), payload: { label: 'x' } });
    expect(notFound.statusCode).toBe(404);
    const ok = await server.inject({ method: 'PATCH', url: `/tenants/t1/email/accounts/${created.id}`, ...h(adminTok), payload: { label: 'renommé' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().label).toBe('renommé');
    expect(invalidated).toContain(created.id);
    await server.close();
  });

  it('DELETE existant -> ok:true puis 404 au 2e appel ; invalide le cache', async () => {
    const { server, invalidated } = app();
    const created = (await server.inject({ method: 'POST', url: '/tenants/t1/email/accounts', ...h(adminTok), payload: validAccountPayload })).json();
    const first = await server.inject({ method: 'DELETE', url: `/tenants/t1/email/accounts/${created.id}`, ...h(adminTok) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    const second = await server.inject({ method: 'DELETE', url: `/tenants/t1/email/accounts/${created.id}`, ...h(adminTok) });
    expect(second.statusCode).toBe(404);
    expect(invalidated).toContain(created.id);
    await server.close();
  });
});

describe('routes email : test d’envoi (4xx, jamais 5xx)', () => {
  it('succès : 200, ok:true, et le compte passe vérifié', async () => {
    const { server, accountRows } = app(vi.fn().mockResolvedValue({}));
    const created = (await server.inject({ method: 'POST', url: '/tenants/t1/email/accounts', ...h(adminTok), payload: validAccountPayload })).json();
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/email/accounts/${created.id}/test`, ...h(adminTok), payload: { to: 'destinataire@exemple.fr' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(accountRows.get(created.id)?.verifiedAt).not.toBeNull();
    await server.close();
  });

  it('🔴 échec SMTP : 422 (jamais 5xx, Cloudflare remplacerait le corps d’une 5xx par sa page d’erreur)', async () => {
    const { server } = app(vi.fn().mockRejectedValue(new Error('connexion refusée')));
    const created = (await server.inject({ method: 'POST', url: '/tenants/t1/email/accounts', ...h(adminTok), payload: validAccountPayload })).json();
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/email/accounts/${created.id}/test`, ...h(adminTok), payload: { to: 'destinataire@exemple.fr' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().ok).toBe(false);
    await server.close();
  });

  it('destinataire invalide -> 400 ; compte inconnu -> 404', async () => {
    const { server } = app();
    const created = (await server.inject({ method: 'POST', url: '/tenants/t1/email/accounts', ...h(adminTok), payload: validAccountPayload })).json();
    const badTo = await server.inject({ method: 'POST', url: `/tenants/t1/email/accounts/${created.id}/test`, ...h(adminTok), payload: { to: 'pas-un-email' } });
    expect(badTo.statusCode).toBe(400);
    const unknown = await server.inject({ method: 'POST', url: '/tenants/t1/email/accounts/inconnu/test', ...h(adminTok), payload: { to: 'x@ex.fr' } });
    expect(unknown.statusCode).toBe(404);
    await server.close();
  });
});

describe('routes email : modèles', () => {
  const payload = { name: 'Confirmation', format: 'basic' as const, subject: 'Bonjour {{prenom}}', body: 'Merci.' };

  it('agent -> 403 sur la création ; admin -> 200 puis visible en liste', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/email/templates', ...h(agentTok), payload })).statusCode).toBe(403);
    const created = await server.inject({ method: 'POST', url: '/tenants/t1/email/templates', ...h(adminTok), payload });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: 'Confirmation', format: 'basic' });
    const list = await server.inject({ method: 'GET', url: '/tenants/t1/email/templates', ...h(adminTok) });
    expect(list.json().templates).toHaveLength(1);
    await server.close();
  });

  it('format hors énum (« text ») -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/email/templates', ...h(adminTok), payload: { ...payload, format: 'text' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('DELETE existant -> ok:true, puis introuvable en liste', async () => {
    const { server } = app();
    const created = (await server.inject({ method: 'POST', url: '/tenants/t1/email/templates', ...h(adminTok), payload })).json();
    const del = await server.inject({ method: 'DELETE', url: `/tenants/t1/email/templates/${created.id}`, ...h(adminTok) });
    expect(del.statusCode).toBe(200);
    const list = await server.inject({ method: 'GET', url: '/tenants/t1/email/templates', ...h(adminTok) });
    expect(list.json().templates).toEqual([]);
    await server.close();
  });
});
