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

function monter(o: { ouvrir?: OffrePaiementRouteDeps['ouvrir']; portail?: OffrePaiementRouteDeps['portail']; proVivant?: boolean; sieges?: OffrePaiementRouteDeps['sieges']; resiliation?: OffrePaiementRouteDeps['resiliation'] } = {}) {
  const cap = {
    ouvertures: [] as Array<{ tenantId: string; periodicite: PeriodicitePro; payeur: string }>, portails: [] as string[],
    rendus: [] as Array<{ tenantId: string; rendre: boolean }>,
    sieges: [] as Array<{ tenantId: string; depuis: number; cible: number; payeur: string }>,
    resiliations: [] as Array<{ tenantId: string; resilier: boolean; payeur: string }>, factures: [] as Array<{ tenantId: string; payeur: string }>,
  };
  const server = buildServer({
    queue: new FakeQueue(), auth: { users: personne, secret: SECRET },
    offrePaiement: {
      ouvrir: o.ouvrir ?? (async (tenantId, periodicite, payeur) => {
        cap.ouvertures.push({ tenantId, periodicite, payeur });
        return { ok: true, valeur: { url: `https://checkout.stripe.com/c/pay/${periodicite}`, portail: false } };
      }),
      portail: o.portail ?? (async (tenantId) => { cap.portails.push(tenantId); return { ok: true, valeur: { url: 'https://billing.stripe.com/p/session/x' } }; }),
      rendreLeNumero: async (tenantId, rendre) => { cap.rendus.push({ tenantId, rendre }); return o.proVivant ?? true; },
      sieges: o.sieges ?? (async (tenantId, demande, payeur) => { cap.sieges.push({ tenantId, ...demande, payeur }); return { ok: true, valeur: { sieges: demande.cible } }; }),
      resiliation: o.resiliation ?? (async (tenantId, resilier, payeur) => {
        cap.resiliations.push({ tenantId, resilier, payeur });
        return { ok: true, valeur: { finPrevueLe: resilier ? '2026-11-12T08:00:00.000Z' : null } };
      }),
      factures: async (tenantId, payeur) => { cap.factures.push({ tenantId, payeur }); return { ok: true, valeur: { factures: [], plusSurStripe: false } }; },
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

/** Rendre le numéro fourni à la fin du Pro (lot 6, B2b) : un choix de l'administrateur, réversible tant que le Pro court. */
describe('PUT /tenants/:tenantId/offre/numero', () => {
  const mettre = (server: ReturnType<typeof buildServer>, jeton: string, payload: unknown) =>
    server.inject({ method: 'PUT', url: '/tenants/t1/offre/numero', headers: { authorization: `Bearer ${jeton}`, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

  it('🔴 l’administrateur pose puis retire « rendre le numéro » sur le Pro de SON espace', async () => {
    const { server, cap } = monter();
    expect((await mettre(server, admin, { rendre: true })).json()).toEqual({ rendreNumero: true });
    expect((await mettre(server, admin, { rendre: false })).json()).toEqual({ rendreNumero: false });
    expect(cap.rendus).toEqual([{ tenantId: 't1', rendre: true }, { tenantId: 't1', rendre: false }]);
    await server.close();
  });

  it('sans Pro vivant : 409, il n’y a pas de « fin du Pro » où rendre le numéro', async () => {
    const { server } = monter({ proVivant: false });
    const r = await mettre(server, admin, { rendre: true });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ cause: 'aucun_pro' });
    await server.close();
  });

  it('un agent : 403 ; un corps qui n’est pas un booléen, ou porte autre chose : 400 ; rien n’est écrit', async () => {
    const { server, cap } = monter();
    expect((await mettre(server, agent, { rendre: true })).statusCode).toBe(403);
    expect((await mettre(server, admin, { rendre: 'oui' })).statusCode).toBe(400);
    expect((await mettre(server, admin, { rendre: true, tenantId: 't2' })).statusCode).toBe(400);
    expect(cap.rendus).toEqual([]);
    await server.close();
  });
});

describe('POST /tenants/:tenantId/offre/sieges (spec offres v2, livraison 7)', () => {
  it('🔴 un administrateur porte les sièges d’un état de départ à la cible ; le payeur est l’utilisateur de la session', async () => {
    const { server, cap } = monter();
    const r = await poster(server, '/tenants/t1/offre/sieges', admin, { depuis: 1, cible: 2 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ sieges: 2 });
    expect(cap.sieges).toEqual([{ tenantId: 't1', depuis: 1, cible: 2, payeur: 'u1' }]);
    await server.close();
  });

  it('🔴 un membre non administrateur : 403, rien n’est acheté', async () => {
    const { server, cap } = monter();
    expect((await poster(server, '/tenants/t1/offre/sieges', agent, { depuis: 0, cible: 1 })).statusCode).toBe(403);
    expect(cap.sieges).toEqual([]);
    await server.close();
  });

  it('🔴 un siège à la fois, depuis un état de départ, jamais un prix : tout le reste en 400 (une requête ne charge pas mille sièges)', async () => {
    // Un serveur par cas : le plafond des opérations coûteuses (10 par minute et par espace) compterait les refus.
    for (const corps of [
      {}, { cible: 1 }, { depuis: 0 }, { depuis: 0, cible: 1000 }, { depuis: 0, cible: 2 }, { depuis: 2, cible: 0 }, { depuis: 1, cible: 1 },
      { depuis: -1, cible: 0 }, { depuis: 0, cible: 1.5 }, { depuis: 0, cible: '1' }, { depuis: 0, cible: 1, prix: 'price_x' },
    ]) {
      const { server, cap } = monter();
      expect((await poster(server, '/tenants/t1/offre/sieges', admin, corps)).statusCode, JSON.stringify(corps)).toBe(400);
      expect(cap.sieges).toEqual([]);
      await server.close();
    }
  });

  it('un refus garde son statut, sa phrase et ses détails (la facture à régler)', async () => {
    const { server } = monter({
      sieges: async () => refus(402, 'Le paiement de l’utilisateur en plus n’a pas abouti.', { code: 'paiement_siege_incomplet', url: 'https://invoice.stripe.com/i/x' }),
    });
    const r = await poster(server, '/tenants/t1/offre/sieges', admin, { depuis: 0, cible: 1 });
    expect(r.statusCode).toBe(402);
    expect(r.json()).toEqual({ error: 'Le paiement de l’utilisateur en plus n’a pas abouti.', code: 'paiement_siege_incomplet', url: 'https://invoice.stripe.com/i/x' });
    await server.close();
  });
});

/** Résilier le Pro ou annuler la résiliation, depuis la console (2026-10-26) : un administrateur, un booléen. */
describe('POST /tenants/:tenantId/offre/resiliation', () => {
  it('🔴 l’administrateur résilie puis annule ; la fin prévue revient, le payeur est l’utilisateur de la session', async () => {
    const { server, cap } = monter();
    const r = await poster(server, '/tenants/t1/offre/resiliation', admin, { resilier: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ finPrevueLe: '2026-11-12T08:00:00.000Z' });
    expect((await poster(server, '/tenants/t1/offre/resiliation', admin, { resilier: false })).json()).toEqual({ finPrevueLe: null });
    expect(cap.resiliations).toEqual([{ tenantId: 't1', resilier: true, payeur: 'u1' }, { tenantId: 't1', resilier: false, payeur: 'u1' }]);
    await server.close();
  });

  it('🔴 un agent : 403 ; un corps qui n’est pas un booléen, ou qui porte un abonnement ou une date : 400 ; rien ne part', async () => {
    const { server, cap } = monter();
    expect((await poster(server, '/tenants/t1/offre/resiliation', agent, { resilier: true })).statusCode).toBe(403);
    for (const payload of [{}, { resilier: 'oui' }, { resilier: true, abonnement: 'sub_x' }, { resilier: true, finLe: '2026-12-01' }]) {
      expect((await poster(server, '/tenants/t1/offre/resiliation', admin, payload)).statusCode).toBe(400);
    }
    expect(cap.resiliations).toEqual([]);
    await server.close();
  });

  it('le refus garde son statut et son code (sans Pro en cours : 409 aucun_pro)', async () => {
    const { server } = monter({ resiliation: async () => refus(409, 'Cet espace n’a pas de Pro en cours à résilier.', { code: 'aucun_pro' }) });
    const r = await poster(server, '/tenants/t1/offre/resiliation', admin, { resilier: true });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'aucun_pro' });
    await server.close();
  });
});

describe('GET /tenants/:tenantId/offre/factures', () => {
  const lire = (server: ReturnType<typeof buildServer>, jeton: string) =>
    server.inject({ method: 'GET', url: '/tenants/t1/offre/factures', headers: { authorization: `Bearer ${jeton}` } });

  it('🔴 l’administrateur lit les factures de SON espace ; un agent est refusé', async () => {
    const { server, cap } = monter();
    const r = await lire(server, admin);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ factures: [], plusSurStripe: false });
    expect((await lire(server, agent)).statusCode).toBe(403);
    expect(cap.factures).toEqual([{ tenantId: 't1', payeur: 'u1' }]);
    await server.close();
  });
});
