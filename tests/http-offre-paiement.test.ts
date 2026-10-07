import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { OffrePaiementRouteDeps } from '../src/http/offre-paiement';
import type { PeriodicitePro } from '../src/stripe/pro';
import { refus } from '../src/lib/issue';

/**
 * PAYER LE PRO DEPUIS LA CONSOLE (lot 6, livraison B1, tâche 10) : deux routes d'administrateur, sous le plafond des
 * opérations coûteuses (chaque clic crée des objets chez Stripe). Le corps ne porte qu'une périodicité, jamais un prix.
 * Aucune garde d'offre : c'est une Base qui doit pouvoir payer.
 */
const SECRET = 'test-secret';
let admin = '';
let agent = '';
beforeAll(async () => {
  admin = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agent = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const personne: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

function monter(o: { ouvrir?: OffrePaiementRouteDeps['ouvrir']; portail?: OffrePaiementRouteDeps['portail'] } = {}) {
  const cap = { ouvertures: [] as Array<{ tenantId: string; periodicite: PeriodicitePro; payeur: string }>, portails: [] as string[] };
  const server = buildServer({
    queue: new FakeQueue(), auth: { users: personne, secret: SECRET },
    offrePaiement: {
      ouvrir: o.ouvrir ?? (async (tenantId, periodicite, payeur) => {
        cap.ouvertures.push({ tenantId, periodicite, payeur });
        return { ok: true, valeur: { url: `https://checkout.stripe.com/c/pay/${periodicite}`, portail: false } };
      }),
      portail: o.portail ?? (async (tenantId) => { cap.portails.push(tenantId); return { ok: true, valeur: { url: 'https://billing.stripe.com/p/session/x' } }; }),
    },
  });
  return { server, cap };
}
const poster = (server: ReturnType<typeof buildServer>, url: string, jeton: string, payload?: unknown) =>
  server.inject({ method: 'POST', url, headers: { authorization: `Bearer ${jeton}`, 'content-type': 'application/json' }, payload: JSON.stringify(payload ?? {}) });

describe('POST /tenants/:tenantId/offre/paiement', () => {
  it('🔴 chaque périodicité ouvre son paiement, payé par l’utilisateur de la session', async () => {
    const { server, cap } = monter();
    for (const periodicite of ['mois', 'an'] as const) {
      const r = await poster(server, '/tenants/t1/offre/paiement', admin, { periodicite });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ url: `https://checkout.stripe.com/c/pay/${periodicite}`, portail: false });
    }
    expect(cap.ouvertures).toEqual([{ tenantId: 't1', periodicite: 'mois', payeur: 'u1' }, { tenantId: 't1', periodicite: 'an', payeur: 'u1' }]);
    await server.close();
  });

  it('🔴 un membre non administrateur : 403, rien n’est ouvert', async () => {
    const { server, cap } = monter();
    expect((await poster(server, '/tenants/t1/offre/paiement', agent, { periodicite: 'mois' })).statusCode).toBe(403);
    expect(cap.ouvertures).toEqual([]);
    await server.close();
  });

  it('un corps sans périodicité valide, ou qui porte un prix : 400', async () => {
    const { server, cap } = monter();
    for (const payload of [{}, { periodicite: 'semaine' }, { periodicite: 'mois', prix: 'price_x' }]) {
      expect((await poster(server, '/tenants/t1/offre/paiement', admin, payload)).statusCode).toBe(400);
    }
    expect(cap.ouvertures).toEqual([]);
    await server.close();
  });

  it('le refus de l’ouverture garde son statut et son code (prix absent : 503 pro_indisponible)', async () => {
    const { server } = monter({ ouvrir: async () => refus(503, 'le Pro n’est pas encore en vente', { code: 'pro_indisponible' }) });
    const r = await poster(server, '/tenants/t1/offre/paiement', admin, { periodicite: 'mois' });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: 'pro_indisponible' });
    await server.close();
  });
});

describe('POST /tenants/:tenantId/offre/portail', () => {
  it('l’administrateur reçoit l’adresse du portail ; un agent est refusé', async () => {
    const { server, cap } = monter();
    const r = await poster(server, '/tenants/t1/offre/portail', admin);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ url: 'https://billing.stripe.com/p/session/x' });
    expect((await poster(server, '/tenants/t1/offre/portail', agent)).statusCode).toBe(403);
    expect(cap.portails).toEqual(['t1']);
    await server.close();
  });
});
