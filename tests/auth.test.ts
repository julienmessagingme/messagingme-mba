import { describe, it, expect } from 'vitest';
import { hashPassword, hashPasswordSync, verifyPassword } from '../src/auth/password';
import { signSession, verifySession } from '../src/auth/token';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import type { UserAuthStore, AuthUser } from '../src/auth/store';

const SECRET = 'test-secret-please-change';

describe('password', () => {
  it('hash puis vérifie le bon mot de passe', async () => {
    const h = await hashPassword('s3cret!');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('s3cret!', h)).toBe(true);
  });
  it('rejette un mauvais mot de passe ou un hash malformé', async () => {
    const h = await hashPassword('s3cret!');
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'pas-un-hash')).toBe(false);
  });
  it('deux hash du même mot de passe diffèrent (sel aléatoire)', async () => {
    expect(await hashPassword('a')).not.toBe(await hashPassword('a'));
  });
});

describe('token', () => {
  it('signe puis vérifie une session', async () => {
    const token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
    const s = await verifySession(token, SECRET);
    expect(s).toEqual({ userId: 'u1', tenantId: 't1', role: 'admin' });
  });
  it('rejette un token signé avec un autre secret', async () => {
    const token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
    expect(await verifySession(token, 'autre-secret')).toBeNull();
  });
  it('rejette un token malformé', async () => {
    expect(await verifySession('pas.un.jwt', SECRET)).toBeNull();
  });
});

class FakeUsers implements UserAuthStore {
  constructor(private readonly users: AuthUser[]) {}
  async findByEmail(email: string): Promise<AuthUser | null> {
    return this.users.find((u) => u.email === email) ?? null;
  }
}

describe('POST /auth/login', () => {
  function appWith(users: AuthUser[]) {
    return buildServer({ queue: new FakeQueue(), auth: { users: new FakeUsers(users), secret: SECRET } });
  }
  const admin: AuthUser = { id: 'u1', tenantId: 't1', email: 'a@b.co', role: 'admin', passwordHash: hashPasswordSync('pw') };

  it('identifiants valides -> 200 + token exploitable', async () => {
    const app = appWith([admin]);
    const res = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.co', password: 'pw' } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; user: { tenantId: string } }>();
    expect(body.user.tenantId).toBe('t1');
    expect(await verifySession(body.token, SECRET)).toMatchObject({ tenantId: 't1', userId: 'u1' });
    await app.close();
  });

  it('mauvais mot de passe -> 401', async () => {
    const app = appWith([admin]);
    const res = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.co', password: 'nope' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('email inconnu -> 401 (pas de fuite d existence)', async () => {
    const app = appWith([admin]);
    const res = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'x@y.co', password: 'pw' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('champs manquants -> 400', async () => {
    const app = appWith([admin]);
    const res = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.co' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rate-limit : trop de tentatives sur le MÊME email -> 429', async () => {
    const app = buildServer({
      queue: new FakeQueue(),
      auth: { users: new FakeUsers([admin]), secret: SECRET, loginRateLimit: { max: 3, windowMs: 60_000 } },
    });
    const attempt = () =>
      app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.co', password: 'nope' } });
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429); // 4e tentative bloquée
    await app.close();
  });

  it('rate-limit : la clé porte l\'email -> un email saturé NE bloque PAS un autre (fin du plafond global)', async () => {
    const app = buildServer({
      queue: new FakeQueue(),
      auth: { users: new FakeUsers([admin]), secret: SECRET, loginRateLimit: { max: 3, windowMs: 60_000 } },
    });
    const attempt = (email: string) =>
      app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email, password: 'nope' } });
    // On sature victime@b.co (req.ip constant en test -> l'ancien code aurait bloqué TOUT le monde ici).
    await attempt('victime@b.co');
    await attempt('victime@b.co');
    await attempt('victime@b.co');
    expect((await attempt('victime@b.co')).statusCode).toBe(429);
    // Un AUTRE email passe encore : plus de blocage transverse.
    expect((await attempt('autre@b.co')).statusCode).toBe(401);
    await app.close();
  });
});
