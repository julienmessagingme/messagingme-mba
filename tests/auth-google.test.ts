import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { DuplicateEmailError } from '../src/user/store.pg';
import type { AuthRouteDeps } from '../src/auth/routes';
import type { GoogleIdentity } from '../src/auth/google';

const SECRET = 'test-secret';
const j = { headers: { 'content-type': 'application/json' } };

interface Cap {
  created: Array<{ name: string; email: string; passwordHash: string | null }>;
}

// Vérificateur Google FAKE : exerce le chemin réel de la route sans dépendre du vrai JWKS Google.
const fakeVerify = (idToken: string): Promise<GoogleIdentity | null> => {
  if (idToken === 'GOOD') return Promise.resolve({ email: 'known@x.fr', name: 'Jean', emailVerified: true, sub: 'g1' });
  if (idToken === 'NEW') return Promise.resolve({ email: 'new@x.fr', name: 'Alice', emailVerified: true, sub: 'g2' });
  if (idToken === 'REVOKED') return Promise.resolve({ email: 'revoked@x.fr', name: null, emailVerified: true, sub: 'g3' });
  if (idToken === 'UNVERIFIED') return Promise.resolve({ email: 'known@x.fr', name: 'Jean', emailVerified: false, sub: 'g1' });
  return Promise.resolve(null); // jeton invalide
};

function app(over: Partial<AuthRouteDeps> = {}) {
  const cap: Cap = { created: [] };
  const deps: AuthRouteDeps = {
    users: { findByEmail: async () => null },
    secret: SECRET,
    getUserState: async () => ({ role: 'admin', disabled: false, tenantStatus: 'active' }),
    createTenantWithAdmin: async (name, admin) => {
      if (admin.email === 'taken@x.fr') throw new DuplicateEmailError();
      cap.created.push({ name, email: admin.email, passwordHash: admin.passwordHash });
      return { tenantId: 'tNew', userId: 'uNew' };
    },
    googleClientId: 'client-abc',
    verifyGoogle: fakeVerify,
    getUserByEmail: async (email) => {
      if (email === 'known@x.fr') return { id: 'u1', tenantId: 't1', role: 'agent', disabled: false };
      if (email === 'revoked@x.fr') return { id: 'u2', tenantId: 't1', role: 'admin', disabled: true };
      return null;
    },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: deps }), cap };
}

describe('GET /auth/config', () => {
  it('client configuré -> googleEnabled true + client_id exposé', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/auth/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ googleClientId: 'client-abc', googleEnabled: true });
    await server.close();
  });
  it('client vide -> googleEnabled false (bouton masqué côté front)', async () => {
    const { server } = app({ googleClientId: '' });
    const res = await server.inject({ method: 'GET', url: '/auth/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ googleClientId: '', googleEnabled: false });
    await server.close();
  });
});

describe('POST /auth/google', () => {
  it('compte existant + jeton valide -> 200 + token, AUCUN espace créé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/google', ...j, payload: { idToken: 'GOOD' } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; isNew: boolean; user: { role: string; tenantId: string; email: string } }>();
    expect(body.token).toBeTruthy();
    expect(body.isNew).toBe(false);
    expect(body.user).toMatchObject({ role: 'agent', tenantId: 't1', email: 'known@x.fr' });
    expect(cap.created).toHaveLength(0);
    await server.close();
  });

  it('email inconnu + jeton valide -> 201 + nouvel espace admin SANS mot de passe', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/google', ...j, payload: { idToken: 'NEW' } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; isNew: boolean; user: { role: string; tenantId: string; email: string } }>();
    expect(body.token).toBeTruthy();
    expect(body.isNew).toBe(true);
    expect(body.user).toMatchObject({ role: 'admin', tenantId: 'tNew', email: 'new@x.fr' });
    expect(cap.created).toEqual([{ name: 'Espace de Alice', email: 'new@x.fr', passwordHash: null }]);
    await server.close();
  });

  it('jeton invalide -> 401, aucun espace créé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/google', ...j, payload: { idToken: 'BAD' } });
    expect(res.statusCode).toBe(401);
    expect(cap.created).toHaveLength(0);
    await server.close();
  });

  it('email non vérifié chez Google -> 401 (pas de liaison sur un email non prouvé)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/google', ...j, payload: { idToken: 'UNVERIFIED' } });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('compte révoqué -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/google', ...j, payload: { idToken: 'REVOKED' } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('idToken manquant -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/auth/google', ...j, payload: {} });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('Google non configuré (dép absente) -> 503', async () => {
    const { server } = app({ verifyGoogle: undefined, getUserByEmail: undefined });
    const res = await server.inject({ method: 'POST', url: '/auth/google', ...j, payload: { idToken: 'GOOD' } });
    expect(res.statusCode).toBe(503);
    await server.close();
  });
});
