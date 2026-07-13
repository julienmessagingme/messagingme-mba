import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import { hashPasswordSync } from '../src/auth/password';
import { DuplicateEmailError } from '../src/user/store.pg';
import type { AuthRouteDeps } from '../src/auth/routes';
import type { AuthUser } from '../src/auth/store';

const SECRET = 'test-secret';
const KNOWN_HASH = hashPasswordSync('current-pass-123');
let tok = '';
beforeAll(async () => { tok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET); });
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
const j = { headers: { 'content-type': 'application/json' } };

interface Cap { created: Array<{ name: string; email: string }>; setPass: string[]; emails: Array<{ to: string; text: string }>; tokens: Array<{ p: string; uid: string }> }

function app(over: Partial<AuthRouteDeps> = {}) {
  const cap: Cap = { created: [], setPass: [], emails: [], tokens: [] };
  const deps: AuthRouteDeps = {
    users: { findByEmail: async (email: string): Promise<AuthUser | null> => (email === 'known@x.fr' ? { id: 'u1', tenantId: 't1', role: 'admin', email, passwordHash: KNOWN_HASH } : null) },
    secret: SECRET,
    getUserState: async () => ({ role: 'admin', disabled: false, tenantStatus: 'active' }),
    createTenantWithAdmin: async (name, admin) => { if (admin.email === 'taken@x.fr') throw new DuplicateEmailError(); cap.created.push({ name, email: admin.email }); return { tenantId: 'tNew', userId: 'uNew' }; },
    setPassword: async (userId) => { cap.setPass.push(userId); return true; },
    getPasswordHash: async () => KNOWN_HASH,
    tokens: { create: async (p, uid) => { cap.tokens.push({ p, uid }); return 'RAWTOKEN'; }, consume: async (_p, raw) => (raw === 'GOOD' ? 'u1' : null) },
    sendEmail: async (e) => { cap.emails.push({ to: e.to, text: e.text }); },
    appUrl: 'https://mba.messagingme.app',
    resetTtlMs: 3600000,
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: deps }), cap };
}

describe('POST /auth/signup', () => {
  it('crée un espace + admin, connecte (201 + token)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/signup', ...j, payload: { workspaceName: 'Mon Espace', email: 'A@X.fr', password: 'motdepasse1', name: 'Jean' } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; user: { role: string; tenantId: string } }>();
    expect(body.token).toBeTruthy();
    expect(body.user).toMatchObject({ role: 'admin', tenantId: 'tNew' });
    expect(cap.created).toEqual([{ name: 'Mon Espace', email: 'a@x.fr' }]); // email normalisé
    await server.close();
  });
  it('email déjà pris -> 409', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/signup', ...j, payload: { workspaceName: 'E', email: 'taken@x.fr', password: 'motdepasse1' } });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
  it('validations -> 400 (mdp court, email invalide, espace vide)', async () => {
    const { server } = app();
    const short = await server.inject({ method: 'POST', url: '/auth/signup', ...j, payload: { workspaceName: 'E', email: 'a@x.fr', password: 'court' } });
    const mail = await server.inject({ method: 'POST', url: '/auth/signup', ...j, payload: { workspaceName: 'E', email: 'pasunemail', password: 'motdepasse1' } });
    const ws = await server.inject({ method: 'POST', url: '/auth/signup', ...j, payload: { workspaceName: '', email: 'a@x.fr', password: 'motdepasse1' } });
    expect([short.statusCode, mail.statusCode, ws.statusCode]).toEqual([400, 400, 400]);
    await server.close();
  });
});

describe('POST /auth/forgot-password (anti-énumération)', () => {
  it('email connu -> 200 + lien envoyé + token créé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/forgot-password', ...j, payload: { email: 'known@x.fr' } });
    expect(res.statusCode).toBe(200);
    expect(cap.emails).toHaveLength(1);
    expect(cap.emails[0]!.text).toContain('/reset/RAWTOKEN');
    expect(cap.tokens).toEqual([{ p: 'reset', uid: 'u1' }]);
    await server.close();
  });
  it('email INCONNU -> 200 GÉNÉRIQUE, AUCUN email (pas de fuite d\'existence)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/forgot-password', ...j, payload: { email: 'inconnu@x.fr' } });
    expect(res.statusCode).toBe(200);
    expect(cap.emails).toHaveLength(0);
    await server.close();
  });
  it('email malformé -> 200 générique (jamais 400 révélateur)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/forgot-password', ...j, payload: { email: 'xxx' } });
    expect(res.statusCode).toBe(200);
    expect(cap.emails).toHaveLength(0);
    await server.close();
  });
});

describe('POST /auth/reset-password', () => {
  it('token valide -> 200 + mot de passe posé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/reset-password', ...j, payload: { token: 'GOOD', password: 'nouveaupass1' } });
    expect(res.statusCode).toBe(200);
    expect(cap.setPass).toEqual(['u1']);
    await server.close();
  });
  it('token invalide/expiré -> 400, aucun mdp posé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/reset-password', ...j, payload: { token: 'BAD', password: 'nouveaupass1' } });
    expect(res.statusCode).toBe(400);
    expect(cap.setPass).toHaveLength(0);
    await server.close();
  });
  it('mot de passe trop court -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/reset-password', ...j, payload: { token: 'GOOD', password: 'court' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });
});

describe('POST /auth/change-password (connecté)', () => {
  it('mot de passe actuel correct -> 200 + nouveau posé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/change-password', ...h(tok), payload: { currentPassword: 'current-pass-123', newPassword: 'nouveaupass1' } });
    expect(res.statusCode).toBe(200);
    expect(cap.setPass).toEqual(['u1']);
    await server.close();
  });
  it('mot de passe actuel INCORRECT -> 401, rien posé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/change-password', ...h(tok), payload: { currentPassword: 'mauvais', newPassword: 'nouveaupass1' } });
    expect(res.statusCode).toBe(401);
    expect(cap.setPass).toHaveLength(0);
    await server.close();
  });
  it('non authentifié -> 401', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/change-password', ...j, payload: { currentPassword: 'x', newPassword: 'nouveaupass1' } });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});
