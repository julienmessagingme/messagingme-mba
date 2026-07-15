import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import { ResendClient } from '../src/support/resend';
import type { FetchLike } from '../src/support/resend';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { SupportRouteDeps } from '../src/http/support';

const SECRET = 'test-secret';
let token = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

function app(over: Partial<SupportRouteDeps> = {}) {
  const deps: SupportRouteDeps = {
    enabled: true,
    sendSupport: async () => {},
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, support: deps });
}

describe('ResendClient.send', () => {
  function makeFetch(res: { ok: boolean; status: number; json: unknown }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: res.ok, status: res.status, json: async () => res.json } as Response;
    };
    return { fn, calls };
  }

  it('POST /emails : to en tableau + reply_to', async () => {
    const { fn, calls } = makeFetch({ ok: true, status: 200, json: { id: 'em1' } });
    const client = new ResendClient('key', fn);
    const r = await client.send({ from: 'a@x.fr', to: 'b@y.fr', subject: 'Hi', text: 'body', replyTo: 'reply@z.fr' });
    expect(r).toEqual({ id: 'em1' });
    expect(calls[0]!.url).toContain('/emails');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.to).toEqual(['b@y.fr']);
    expect(body.reply_to).toBe('reply@z.fr');
  });

  it('HTTP non-ok -> ResendError', async () => {
    const { fn } = makeFetch({ ok: false, status: 403, json: { message: 'domaine non vérifié' } });
    const client = new ResendClient('key', fn);
    await expect(client.send({ from: 'a@x.fr', to: 'b@y.fr', subject: 'Hi', text: 'body' })).rejects.toMatchObject({ name: 'ResendError', status: 403 });
  });

  it('inclut `html` dans le body POST quand fourni', async () => {
    const { fn, calls } = makeFetch({ ok: true, status: 200, json: { id: 'em2' } });
    const client = new ResendClient('key', fn);
    await client.send({ from: 'a@x.fr', to: 'b@y.fr', subject: 'Hi', text: 'body', html: '<h1>Coucou</h1>' });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.html).toBe('<h1>Coucou</h1>');
    expect(body.text).toBe('body');
  });

  it('omet `html` quand non fourni', async () => {
    const { fn, calls } = makeFetch({ ok: true, status: 200, json: { id: 'em3' } });
    const client = new ResendClient('key', fn);
    await client.send({ from: 'a@x.fr', to: 'b@y.fr', subject: 'Hi', text: 'body' });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect('html' in body).toBe(false);
  });
});

describe('routes support', () => {
  it('POST valide -> 200, sendSupport appelé avec l auteur + reply-to', async () => {
    let captured: unknown = null;
    const a = app({ sendSupport: async (i) => { captured = i; } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'Bug', message: 'ça casse', email: 'julien@x.fr' } });
    expect(res.statusCode).toBe(200);
    expect(captured).toMatchObject({ tenantId: 't1', userId: 'u1', email: 'julien@x.fr', subject: 'Bug', message: 'ça casse' });
    await a.close();
  });

  it('POST email invalide -> ignoré (reply-to null), envoi quand même', async () => {
    let captured: { email?: string | null } = {};
    const a = app({ sendSupport: async (i) => { captured = i; } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'X', message: 'Y', email: 'pas-un-email' } });
    expect(res.statusCode).toBe(200);
    expect(captured.email).toBeNull();
    await a.close();
  });

  it('POST sujet vide -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: '  ', message: 'Y' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('POST message vide -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'X', message: '' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('support non configuré -> 503', async () => {
    const a = app({ enabled: false });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'X', message: 'Y' } });
    expect(res.statusCode).toBe(503);
    await a.close();
  });

  it('erreur d envoi (Resend down) -> 502 propre (pas de 500 nu)', async () => {
    const a = app({ sendSupport: async () => { throw new Error('resend 403'); } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'X', message: 'Y' } });
    expect(res.statusCode).toBe(502);
    await a.close();
  });

  it('tenant != token -> 403', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/AUTRE/support', ...h(token), payload: { subject: 'X', message: 'Y' } });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('sans token -> 401', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', headers: { 'content-type': 'application/json' }, payload: { subject: 'X', message: 'Y' } });
    expect(res.statusCode).toBe(401);
    await a.close();
  });
});
