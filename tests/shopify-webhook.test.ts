import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { ShopifyWebhooksRouteDeps } from '../src/http/shopify-webhooks';
import type { BoutiqueSignee } from '../src/shopify/store.pg';
import type { BoutiqueRecue } from '../src/shopify/traitement';

/**
 * `POST /shopify/webhooks` (plan 2026-10-21, lot 1). 🔴 Rien du corps n'est lu avant la signature, et la signature se
 * vérifie avec le secret de LA boutique désignée par `X-Shopify-Shop-Domain`. Aucun secret réel ici : tiré à chaque
 * exécution.
 */

const SECRET = randomBytes(16).toString('hex');
const DOMAINE = 'b.myshopify.com';
const BOUTIQUE: BoutiqueSignee = { tenantId: 't1', etat: 'connectee', secret: SECRET, pays: 'FR', consentementAffirme: false };

function monter(o: { boutique?: BoutiqueSignee | null; statut?: 200 | 503; maintenant?: () => number } = {}) {
  const lectures: string[] = [];
  const traites: Array<{ b: BoutiqueRecue; sujet: string; corps: unknown }> = [];
  const deps: ShopifyWebhooksRouteDeps = {
    boutiques: { boutiqueParDomaine: async (d) => { lectures.push(d); return o.boutique === undefined ? (d === DOMAINE ? BOUTIQUE : null) : o.boutique; } },
    traiter: async (b, sujet, corps) => { traites.push({ b, sujet, corps }); return { statut: o.statut ?? 200 }; },
    ...(o.maintenant ? { maintenant: o.maintenant } : {}),
  };
  return { srv: buildServer({ queue: new FakeQueue(), shopifyWebhooks: deps }), lectures, traites };
}

const corps = JSON.stringify({ id: 1002, name: '#1002' });
const signer = (c: string, secret = SECRET) => createHmac('sha256', secret).update(Buffer.from(c)).digest('base64');
const poster = (srv: ReturnType<typeof buildServer>, entetes: Record<string, string>, c = corps) =>
  srv.inject({ method: 'POST', url: '/shopify/webhooks', headers: { 'content-type': 'application/json', ...entetes }, payload: c });

describe('POST /shopify/webhooks', () => {
  it('une signature juste : traité avec la boutique relue, le sujet et le corps', async () => {
    const { srv, traites } = monter();
    const r = await poster(srv, { 'x-shopify-shop-domain': DOMAINE, 'x-shopify-hmac-sha256': signer(corps), 'x-shopify-topic': 'orders/paid' });
    expect(r.statusCode).toBe(200);
    expect(traites).toEqual([{ b: { tenantId: 't1', domaine: DOMAINE, etat: 'connectee', pays: 'FR', consentementAffirme: false }, sujet: 'orders/paid', corps: { id: 1002, name: '#1002' } }]);
  });

  it('🔴 domaine absent ou mal formé : 401 sans toucher la base', async () => {
    const { srv, lectures, traites } = monter();
    expect((await poster(srv, { 'x-shopify-hmac-sha256': signer(corps) })).statusCode).toBe(401);
    expect((await poster(srv, { 'x-shopify-shop-domain': 'evil.com', 'x-shopify-hmac-sha256': signer(corps) })).statusCode).toBe(401);
    expect(lectures).toEqual([]);
    expect(traites).toEqual([]);
  });

  it('🔴 signature fausse, absente, ou d’un autre secret : 401, et le corps n’est jamais traité', async () => {
    const { srv, traites } = monter();
    expect((await poster(srv, { 'x-shopify-shop-domain': DOMAINE })).statusCode).toBe(401);
    expect((await poster(srv, { 'x-shopify-shop-domain': DOMAINE, 'x-shopify-hmac-sha256': signer(corps, 'autre') })).statusCode).toBe(401);
    expect((await poster(srv, { 'x-shopify-shop-domain': DOMAINE, 'x-shopify-hmac-sha256': signer('{"id":1}') })).statusCode).toBe(401);
    expect(traites).toEqual([]);
  });

  it('🔴 une boutique inconnue : 401 ; et son absence se garde en cache, un flot forgé ne relit pas la base', async () => {
    const { srv, lectures } = monter();
    for (let i = 0; i < 5; i += 1) {
      expect((await poster(srv, { 'x-shopify-shop-domain': 'inconnue.myshopify.com', 'x-shopify-hmac-sha256': signer(corps) })).statusCode).toBe(401);
    }
    expect(lectures).toEqual(['inconnue.myshopify.com']);
  });

  it('le cache expire : une boutique branchée entre-temps est reconnue', async () => {
    let t = 0;
    let boutique: BoutiqueSignee | null = null;
    const lectures: string[] = [];
    const srv = buildServer({
      queue: new FakeQueue(),
      shopifyWebhooks: {
        boutiques: { boutiqueParDomaine: async (d) => { lectures.push(d); return boutique; } },
        traiter: async () => ({ statut: 200 }),
        maintenant: () => t,
      },
    });
    const h = { 'x-shopify-shop-domain': DOMAINE, 'x-shopify-hmac-sha256': signer(corps), 'x-shopify-topic': 'orders/paid' };
    expect((await poster(srv, h)).statusCode).toBe(401);
    boutique = BOUTIQUE;
    t = 61_000;
    expect((await poster(srv, h)).statusCode).toBe(200);
  });

  it('🔴 un webhook signé par l’ANCIENNE app, après une reconnexion, ne passe pas pendant la minute du cache', async () => {
    let boutique: BoutiqueSignee = BOUTIQUE;
    const traites: string[] = [];
    const srv = buildServer({
      queue: new FakeQueue(),
      shopifyWebhooks: {
        boutiques: { boutiqueParDomaine: async () => boutique },
        traiter: async (_b, sujet) => { traites.push(sujet); return { statut: 200 }; },
      },
    });
    const h = { 'x-shopify-shop-domain': DOMAINE, 'x-shopify-hmac-sha256': signer(corps), 'x-shopify-topic': 'orders/paid' };
    expect((await poster(srv, h)).statusCode).toBe(200);
    boutique = { ...BOUTIQUE, secret: 'nouveau-secret' };
    expect((await poster(srv, { ...h, 'x-shopify-topic': 'app/uninstalled' })).statusCode).toBe(401);
    expect(traites).toEqual(['orders/paid']);
    // Le cache a été vidé : la nouvelle app est reconnue tout de suite.
    expect((await poster(srv, { ...h, 'x-shopify-hmac-sha256': signer(corps, 'nouveau-secret') })).statusCode).toBe(200);
  });

  it('un 503 du traitement est rendu tel quel : Shopify réessaiera', async () => {
    const { srv } = monter({ statut: 503 });
    const r = await poster(srv, { 'x-shopify-shop-domain': DOMAINE, 'x-shopify-hmac-sha256': signer(corps), 'x-shopify-topic': 'orders/paid' });
    expect(r.statusCode).toBe(503);
  });
});
