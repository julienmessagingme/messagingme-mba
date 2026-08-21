import { describe, it, expect } from 'vitest';
import { hashPassword, hashPasswordSync, verifyPassword } from '../src/auth/password';
import { signSession, verifySession } from '../src/auth/token';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import type { UserAuthStore, AuthUser, EmailIdentity } from '../src/auth/store';

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
  /**
   * Adapte les `AuthUser` du test à la nouvelle forme : une adresse porte UN mot de passe et un ou plusieurs
   * espaces. Les tests existants décrivent une adresse par compte, ce qui reste le cas courant.
   */
  async findIdentity(email: string): Promise<EmailIdentity | null> {
    const trouves = this.users.filter((u) => u.email.toLowerCase() === email.toLowerCase());
    const hash = trouves[0]?.passwordHash;
    if (!hash) return null;
    return {
      passwordHash: hash,
      comptes: trouves.map((u) => ({ id: u.id, tenantId: u.tenantId, tenantName: `Espace ${u.tenantId}`, email: u.email, role: u.role })),
    };
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

/**
 * Une adresse, plusieurs espaces (migrations 0072/0073).
 *
 * La migration 0010 avait fermé ce cas faute de savoir « lequel ouvrir ». La réponse est désormais : on
 * DEMANDE. Ces tests vérifient qu'on ne répond jamais à la place de l'utilisateur, et surtout qu'un jeton de
 * choix ne vaut pas une session.
 */
describe('POST /auth/login — plusieurs espaces pour une adresse', () => {
  const HASH = hashPasswordSync('pw');
  /** Deux comptes, MÊME adresse, même mot de passe : c'est le cas que 0073 rend possible. */
  const deuxEspaces: AuthUser[] = [
    { id: 'u1', tenantId: 't-alpha', email: 'a@b.co', role: 'admin', passwordHash: HASH },
    { id: 'u2', tenantId: 't-beta', email: 'a@b.co', role: 'agent', passwordHash: HASH },
  ];
  // L'inbox est montée pour éprouver le refus BOUT EN BOUT sur une vraie route gardée : sans elle, le
  // serveur répondrait 404 et le test ne prouverait rien de l'authentification.
  const appDeux = () => buildServer({
    queue: new FakeQueue(),
    auth: { users: new FakeUsers(deuxEspaces), secret: SECRET },
    inbox: {
      listConversations: async () => [],
      getConversationContext: async () => null,
      getMessages: async () => [],
      recordOutbound: async () => {},
      getTenantPhoneNumberId: async () => 'pn1',
      sendReply: async () => 'wamid.1',
      sendTemplateMessage: async () => 'wamid.2',
    },
  } as never);
  const login = (app: ReturnType<typeof buildServer>, password = 'pw') =>
    app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.co', password } });

  it('🔴 ne choisit PAS à la place de l’utilisateur : aucune session n’est émise', async () => {
    // C'est exactement ce que 0010 reprochait au cas multi-comptes : départager au hasard. Ici on rend la
    // liste, et rien qui permette d'entrer quelque part sans avoir choisi.
    const a = appDeux();
    const res = await login(a);
    expect(res.statusCode).toBe(200);
    const b = res.json<{ token?: string; choiceToken?: string; workspaces?: Array<{ tenantId: string; tenantName: string }> }>();
    expect(b.token).toBeUndefined();
    expect(b.choiceToken).toBeTruthy();
    expect(b.workspaces?.map((w) => w.tenantId)).toEqual(['t-alpha', 't-beta']);
    await a.close();
  });

  it('🔴 le jeton de CHOIX ne vaut pas une session', async () => {
    // S'il pouvait servir de jeton d'API, il donnerait un accès sans avoir choisi d'espace, donc sans
    // `tenantId` : la porte ouverte sur tout ou sur n'importe quoi.
    const a = appDeux();
    const { choiceToken } = (await login(a)).json<{ choiceToken: string }>();
    expect(await verifySession(choiceToken, SECRET)).toBeNull();
    const res = await a.inject({
      method: 'GET', url: '/tenants/t-alpha/conversations',
      headers: { authorization: `Bearer ${choiceToken}` },
    });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it('choisir un espace rend une VRAIE session, sur le bon compte', async () => {
    const a = appDeux();
    const { choiceToken } = (await login(a)).json<{ choiceToken: string }>();
    const res = await a.inject({
      method: 'POST', url: '/auth/choose-workspace',
      headers: { 'content-type': 'application/json' },
      payload: { choiceToken, tenantId: 't-beta' },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ token: string; user: { tenantId: string; role: string } }>();
    expect(b.user).toMatchObject({ tenantId: 't-beta', role: 'agent' });
    // Le rôle vient du compte de CET espace : le même utilisateur est admin ailleurs.
    expect(await verifySession(b.token, SECRET)).toMatchObject({ userId: 'u2', tenantId: 't-beta', role: 'agent' });
    await a.close();
  });

  it('🔴 un espace HORS de la liste signée est refusé', async () => {
    // Sans cette vérification, il suffirait de présenter un jeton de choix légitime avec l'identifiant d'un
    // espace quelconque pour y entrer.
    const a = appDeux();
    const { choiceToken } = (await login(a)).json<{ choiceToken: string }>();
    const res = await a.inject({
      method: 'POST', url: '/auth/choose-workspace',
      headers: { 'content-type': 'application/json' },
      payload: { choiceToken, tenantId: 't-du-voisin' },
    });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('un mot de passe faux ne révèle rien du nombre d’espaces', async () => {
    const a = appDeux();
    const res = await login(a, 'mauvais');
    expect(res.statusCode).toBe(401);
    expect(res.json<{ workspaces?: unknown }>().workspaces).toBeUndefined();
    await a.close();
  });

  it('🔴 UN seul espace : rien ne change, on entre directement', async () => {
    // Le cas de tout le monde aujourd'hui. Il ne doit surtout pas gagner un écran de plus.
    const a = buildServer({
      queue: new FakeQueue(),
      auth: { users: new FakeUsers([{ id: 'u1', tenantId: 't1', email: 'a@b.co', role: 'admin', passwordHash: HASH }]), secret: SECRET },
    });
    const res = await login(a);
    const b = res.json<{ token?: string; choiceToken?: string }>();
    expect(b.token).toBeTruthy();
    expect(b.choiceToken).toBeUndefined();
    await a.close();
  });
});
