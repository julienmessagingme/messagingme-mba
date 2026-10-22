import { describe, expect, it, vi } from 'vitest';
import { creerAlerteConnexion, REPOS_ALERTE_CONNEXION_MS } from '../src/ops/alerte-connexion';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { GoogleIdentity } from '../src/auth/google';

describe('alerte sur un 500 des routes de connexion', () => {
  it('prévient au premier 500 d’une route d’entrée, se tait pendant le repos, puis reprévient', () => {
    let maintenant = 1_000;
    const alerter = vi.fn();
    const alerte = creerAlerteConnexion(alerter, () => maintenant);
    alerte({ method: 'POST', url: '/auth/google' }, new TypeError('this perdu'));
    expect(alerter).toHaveBeenCalledTimes(1);
    expect(alerter.mock.calls[0]![0]).toContain('POST /auth/google a rendu 500 (this perdu)');
    alerte({ method: 'POST', url: '/oauth/token' }, new Error('x'));
    expect(alerter).toHaveBeenCalledTimes(1);
    maintenant += REPOS_ALERTE_CONNEXION_MS;
    alerte({ method: 'GET', url: '/.well-known/oauth-authorization-server?x=1' }, new Error('x'));
    expect(alerter).toHaveBeenCalledTimes(2);
    expect(alerter.mock.calls[1]![0]).toContain('GET /.well-known/oauth-authorization-server a rendu');
  });

  it('ignore les autres routes et ne lève jamais, même si Telegram lève', () => {
    const alerter = vi.fn(() => { throw new Error('telegram'); });
    const alerte = creerAlerteConnexion(alerter);
    alerte({ method: 'GET', url: '/tenants/t1/contacts' }, new Error('x'));
    alerte({ method: 'GET', url: '/authentique' }, new Error('x'));
    expect(alerter).not.toHaveBeenCalled();
    expect(() => alerte({ method: 'POST', url: '/auth/login' }, new Error('x'))).not.toThrow();
    expect(alerter).toHaveBeenCalledTimes(1);
  });

  it('est branchée sur le gestionnaire d’erreurs : /auth/google en 500 prévient l’exploitation', async () => {
    const alerter = vi.fn();
    const identite: GoogleIdentity = { email: 'a@x.fr', name: null, emailVerified: true, sub: 'g1' };
    const server = buildServer({
      queue: new FakeQueue(),
      alerter,
      auth: {
        users: { findIdentity: async () => null },
        secret: 's',
        getUserState: async () => ({ role: 'admin', disabled: false, tenantStatus: 'active', horsOffre: null }),
        comptes: {
          getByEmail: async () => { throw new TypeError("Cannot read properties of undefined (reading 'query')"); },
          createTenantWithAdmin: async () => ({ tenantId: 't', userId: 'u' }),
        },
        googleClientId: 'client',
        verifyGoogle: async () => identite,
      },
    });
    const res = await server.inject({
      method: 'POST', url: '/auth/google', headers: { 'content-type': 'application/json' }, payload: { idToken: 'X' },
    });
    expect(res.statusCode).toBe(500);
    expect(alerter).toHaveBeenCalledTimes(1);
    expect(alerter.mock.calls[0]![0]).toContain('POST /auth/google a rendu 500');
    await server.close();
  });
});
