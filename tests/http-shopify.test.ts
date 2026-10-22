import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { ShopifyRouteDeps } from '../src/http/shopify';
import type { Connexion, VueBoutique } from '../src/shopify/store.pg';
import { TEXTES_PROPOSES } from '../src/shopify/preparation';

/**
 * LES ROUTES DE PARAMÈTRES > INTÉGRATIONS > SHOPIFY (conception 2026-10-22), montées par le REGISTRE (qui pose l'étape
 * d'espace) : admin seulement, corps stricts, le branchement de la console abonne les webhooks, chaque écriture est
 * journalisée.
 */
const SECRET = 'test-secret';
let admin = '';
let agent = '';
let autreEspace = '';
beforeAll(async () => {
  admin = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agent = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  autreEspace = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const en = (jeton: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` } });
const URL_T1 = '/tenants/t1/integrations/shopify';
const CIBLE = { kind: 'integration', id: 'shopify' };
const VUE: VueBoutique = {
  domaine: 'b.myshopify.com', nom: 'Essai', pays: 'FR', devise: 'EUR', etat: 'connectee', motifCoupure: null, coupeeLe: null,
  connecteeLe: '2026-10-22T00:00:00.000Z', dernierEvenementLe: null, consentement: null, delaiPanierMinutes: 60, origine: 'console',
};

function monter() {
  const trace = { connexions: [] as Connexion[], abonnements: [] as unknown[], modeles: [] as unknown[], delais: [] as number[], audit: [] as Array<{ action: string; cible: unknown; detail: unknown }> };
  let boutique: VueBoutique | null = null;
  const non = async (): Promise<never> => { throw new Error('hors de ce test'); };
  const store = {
    lire: async () => boutique,
    connecter: async (_t: string, c: Connexion) => { trace.connexions.push(c); boutique = { ...VUE, domaine: c.domaine }; return 'ok' as const; },
    couper: non, messages: async () => [], brancher: non, affirmerConsentement: async () => undefined, retirerConsentement: non,
    compteurs: async () => ({}), reglerDelaiPanier: async (_t: string, m: number) => { trace.delais.push(m); },
    compteursPaniers: async () => ({ relances: {}, fermesATemps: 0, enAttente: 0 }), acces: async () => null,
    attentes: async () => [], retirerAttente: async () => null, poserAttente: async () => undefined, message: async () => null,
  };
  const deps: ShopifyRouteDeps = {
    gestion: {
      store,
      verifier: async () => ({ ok: true, nom: 'Essai', pays: 'FR', devise: 'EUR' }),
      lireModele: non,
      chiffrementPret: true,
      jeton: async () => ({ ok: true, jeton: 'jeton' }),
      lireClients: non,
      places: non,
      importer: non,
      abonner: async (a) => { trace.abonnements.push(a); return { ok: true, abonnes: ['ORDERS_PAID'], deja: [] }; },
    },
    preparation: {
      store,
      creerModele: async (_t, input) => { trace.modeles.push(input); return { ok: true, statut: 'pending', categorie: input.category.toLowerCase() }; },
    },
    audit: async (_t, _acteur, action, cible, detail) => { trace.audit.push({ action, cible, detail }); },
  };
  const app = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, shopify: deps });
  return { app, trace, brancher: () => { boutique = VUE; } };
}

describe('le branchement depuis la console', () => {
  it('🔴 origine console : branchée, les webhooks abonnés, le journal nomme la boutique', async () => {
    const { app, trace } = monter();
    const r = await app.inject({ method: 'POST', url: URL_T1, ...en(admin), payload: { boutique: 'b.myshopify.com', clientId: 'cid', secret: 'shpss_x' } });
    expect(r.statusCode).toBe(200);
    expect(trace.connexions).toMatchObject([{ domaine: 'b.myshopify.com', origine: 'console', par: 'u1' }]);
    expect(trace.abonnements).toEqual([{ domaine: 'b.myshopify.com', jeton: 'jeton' }]);
    expect(trace.audit).toEqual([{ action: 'shopify.branchee', cible: CIBLE, detail: { boutique: 'b.myshopify.com', origine: 'console' } }]);
    expect(JSON.stringify(r.json())).not.toContain('shpss_x');
  });

  it('🔴 un agent et l’espace d’un autre client sont refusés, sans rien brancher', async () => {
    const { app, trace } = monter();
    const corps = { boutique: 'b.myshopify.com', clientId: 'cid', secret: 'shpss_x' };
    expect((await app.inject({ method: 'POST', url: URL_T1, ...en(agent), payload: corps })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: URL_T1, ...en(autreEspace), payload: corps })).statusCode).toBe(403);
    expect(trace.connexions).toEqual([]);
  });

  it('un corps hors contrat est refusé (clé inconnue, type)', async () => {
    const { app } = monter();
    expect((await app.inject({ method: 'POST', url: URL_T1, ...en(admin), payload: { boutique: 'b', clientId: 'c', secret: 's', autre: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: URL_T1, ...en(admin), payload: { boutique: 1, clientId: 'c', secret: 's' } })).statusCode).toBe(400);
  });
});

describe('l’assistant et les réglages', () => {
  it('préparer la relance (consentement affirmé dans l’appel) : en validation, journalisé', async () => {
    const { app, trace, brancher } = monter();
    brancher();
    const r = await app.inject({
      method: 'POST', url: `${URL_T1}/messages`, ...en(admin),
      payload: { evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr', delaiMinutes: 60, consentementAffirme: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ etat: 'en_validation' });
    expect(trace.modeles).toHaveLength(1);
    expect(trace.audit).toMatchObject([{ action: 'shopify.message', detail: { evenement: 'checkout_abandoned', etat: 'en_validation', consentementAffirme: true } }]);
  });

  it('un corps d’assistant hors contrat est refusé ; le délai se règle sans Meta', async () => {
    const { app, trace, brancher } = monter();
    brancher();
    expect((await app.inject({ method: 'POST', url: `${URL_T1}/messages`, ...en(admin), payload: { evenement: 'order_paid', texte: 'x', langue: 'fr', bouton: 'STOP' } })).statusCode).toBe(400);
    const r = await app.inject({ method: 'PATCH', url: `${URL_T1}/messages/checkout_abandoned`, ...en(admin), payload: { delaiMinutes: 90 } });
    expect(r.statusCode).toBe(200);
    expect(trace.delais).toEqual([90]);
    expect(trace.modeles).toEqual([]);
  });

  it('l’import exige le nombre choisi, entier', async () => {
    const { app } = monter();
    expect((await app.inject({ method: 'POST', url: `${URL_T1}/clients/import`, ...en(admin), payload: { maximum: '3' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${URL_T1}/clients/import`, ...en(admin), payload: {} })).statusCode).toBe(400);
  });
});
