import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { EtatDeLEspace } from '../src/stripe/abonnements.pg';

/**
 * L'ÉTAT DE L'ABONNEMENT DU NUMÉRO POUR LA CONSOLE (lot 4) : le bandeau le lit sur chaque page. Tout MEMBRE de l'espace
 * le lit (la suspension coupe aussi les réponses des agents de l'Inbox) ; l'isolation entre espaces est tenue par
 * `tests/scope-tenant.test.ts`, qui sonde chaque route d'espace.
 */
const SECRET = 'test-secret';
let admin = '';
let agent = '';
beforeAll(async () => {
  admin = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agent = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const personne: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

function monter(e: EtatDeLEspace | null) {
  const lus: string[] = [];
  const server = buildServer({
    queue: new FakeQueue(), auth: { users: personne, secret: SECRET },
    abonnementNumero: { etat: async (t) => { lus.push(t); return e; } },
  });
  return { server, lus };
}
const lire = (server: ReturnType<typeof buildServer>, jeton: string) =>
  server.inject({ method: 'GET', url: '/tenants/t1/abonnement-numero', headers: { authorization: `Bearer ${jeton}` } });

describe('GET /tenants/:tenantId/abonnement-numero', () => {
  it('🔴 un membre (pas seulement un admin) lit l’état et ses dates, en ISO', async () => {
    const { server, lus } = monter({
      abonnementId: 'sub_1', etat: 'suspendu', finPrevueLe: null, coupureLe: null,
      finiLe: new Date('2026-10-06T15:14:51Z'), liberationLe: new Date('2026-10-13T15:14:51Z'), libereLe: null,
    });
    for (const jeton of [admin, agent]) {
      const res = await lire(server, jeton);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ etat: 'suspendu', finPrevueLe: null, coupureLe: null, liberationLe: '2026-10-13T15:14:51.000Z', fini: true });
    }
    expect(lus).toEqual(['t1', 't1']);
    await server.close();
  });

  it('jamais d’abonnement : tout à null', async () => {
    const { server } = monter(null);
    expect((await lire(server, admin)).json()).toEqual({ etat: null, finPrevueLe: null, coupureLe: null, liberationLe: null, fini: false });
    await server.close();
  });

  it('sans session : 401', async () => {
    const { server } = monter(null);
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/abonnement-numero' })).statusCode).toBe(401);
    await server.close();
  });
});
