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
  it('POST valide -> 200, reply-to résolu EN BASE depuis le compte authentifié', async () => {
    let captured: unknown = null;
    const a = app({
      sendSupport: async (i) => { captured = i; },
      getUserEmail: async (id) => (id === 'u1' ? 'julien@x.fr' : null),
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'Bug', message: 'ça casse' } });
    expect(res.statusCode).toBe(200);
    expect(captured).toMatchObject({ tenantId: 't1', userId: 'u1', email: 'julien@x.fr', subject: 'Bug', message: 'ça casse' });
    await a.close();
  });

  it('un email GLISSÉ DANS LE CORPS est ignoré : le reply-to reste celui du compte', async () => {
    // C'est l'invariant du durcissement : avant, n'importe quel compte authentifié pouvait faire répondre
    // l'équipe à l'adresse de son choix, en la posant simplement dans le corps de la requête.
    let captured: { email?: string | null } = {};
    const a = app({
      sendSupport: async (i) => { captured = i; },
      getUserEmail: async () => 'vrai@compte.fr',
    });
    const res = await a.inject({
      method: 'POST', url: '/tenants/t1/support', ...h(token),
      payload: { subject: 'X', message: 'Y', email: 'attaquant@ailleurs.fr' },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.email).toBe('vrai@compte.fr');
    await a.close();
  });

  it('lookup d’email en panne -> envoi quand même, sans reply-to', async () => {
    let captured: { email?: string | null } = {};
    const a = app({
      sendSupport: async (i) => { captured = i; },
      getUserEmail: async () => { throw new Error('pool saturé'); },
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'X', message: 'Y' } });
    expect(res.statusCode).toBe(200);
    expect(captured.email).toBeNull();
    await a.close();
  });

  it('dep getUserEmail ABSENT -> pas de reply-to, jamais de TypeError', async () => {
    let captured: { email?: string | null } = {};
    const a = app({ sendSupport: async (i) => { captured = i; } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'X', message: 'Y' } });
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

  it('6e envoi dans la minute -> 429, et le message n’est PAS envoyé', async () => {
    let sends = 0;
    const a = app({ sendSupport: async () => { sends += 1; } });
    const post = () => a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'X', message: 'Y' } });
    for (let i = 0; i < 5; i += 1) expect((await post()).statusCode).toBe(200);
    const blocked = await post();
    expect(blocked.statusCode).toBe(429);
    expect(sends).toBe(5); // le 6e n'a pas atteint Resend : c'est tout l'intérêt du plafond
    await a.close();
  });

  it('un tenant interdit ne consomme PAS de quota', async () => {
    // Le 403 est rendu avant le limiteur : sinon un tiers pourrait épuiser le quota d'un compte en tapant
    // des URL d'autres tenants, et l'utilisateur légitime se verrait refuser son propre message.
    const a = app();
    for (let i = 0; i < 8; i += 1) {
      const res = await a.inject({ method: 'POST', url: '/tenants/AUTRE/support', ...h(token), payload: { subject: 'X', message: 'Y' } });
      expect(res.statusCode).toBe(403);
    }
    const mine = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'X', message: 'Y' } });
    expect(mine.statusCode).toBe(200);
    await a.close();
  });

  it('l’échec d’envoi laisse une TRACE serveur (ne pas masquer sans journaliser)', async () => {
    // Le `catch` nu d'avant rendait indiscernables une panne Resend et un bug de programmation : les deux
    // donnaient « réessaie plus tard », et il n'en restait RIEN nulle part.
    const logged: string[] = [];
    const spy = console.error;
    console.error = (...args: unknown[]) => { logged.push(String(args[0])); };
    try {
      const a = app({ sendSupport: async () => { throw new Error('resend 403 domaine non vérifié'); } });
      const res = await a.inject({ method: 'POST', url: '/tenants/t1/support', ...h(token), payload: { subject: 'X', message: 'Y' } });
      expect(res.statusCode).toBe(502);
      await a.close();
    } finally {
      console.error = spy;
    }
    const line = logged.find((l) => l.includes('support_send_failed'));
    expect(line).toBeTruthy();
    const parsed = JSON.parse(line as string) as { tenant: string; userId: string; err: string };
    expect(parsed).toMatchObject({ tenant: 't1', userId: 'u1' });
    expect(parsed.err).toContain('domaine non vérifié'); // la cause réelle, pas le message client
  });
});
