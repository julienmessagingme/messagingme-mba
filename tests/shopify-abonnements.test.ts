import { describe, it, expect } from 'vitest';
import { abonnerWebhooks, ADRESSE_WEBHOOKS, SUJETS_ABONNES } from '../src/shopify/abonnements';

/**
 * L'ABONNEMENT DES WEBHOOKS D'UNE BOUTIQUE BRANCHÉE PAR LA CONSOLE (conception 2026-10-22). Shopify est simulé.
 * Mesuré le 2026-10-22 : les six sujets s'abonnent, un sujet déjà abonné est refusé « already been taken ».
 */

const ACCES = { domaine: 'b.myshopify.com', jeton: 'jeton-de-test' };

function shopify(reponse: (sujet: string) => { statut?: number; corps: unknown }) {
  const envois: Array<{ url: string; jeton: string | null; topic: string; uri: string }> = [];
  const appeler = (async (url: string, init: RequestInit) => {
    const corps = JSON.parse(String(init.body)) as { variables: { topic: string; sub: { uri: string } } };
    const entetes = new Headers(init.headers);
    envois.push({ url, jeton: entetes.get('x-shopify-access-token'), topic: corps.variables.topic, uri: corps.variables.sub.uri });
    const r = reponse(corps.variables.topic);
    return new Response(JSON.stringify(r.corps), { status: r.statut ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { appeler, envois };
}
const cree = { data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1' }, userErrors: [] } } };
const deja = { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ message: 'Address for this topic has already been taken' }] } } };

describe('l’abonnement des webhooks par l’API', () => {
  it('abonne les six sujets du connecteur, vers notre adresse, avec le jeton de l’app', async () => {
    const s = shopify(() => ({ corps: cree }));
    expect(await abonnerWebhooks(ACCES, s.appeler)).toEqual({ ok: true, abonnes: [...SUJETS_ABONNES], deja: [] });
    expect(s.envois.map((e) => e.topic)).toEqual(['ORDERS_CREATE', 'ORDERS_PAID', 'FULFILLMENTS_CREATE', 'CHECKOUTS_CREATE', 'CHECKOUTS_UPDATE', 'APP_UNINSTALLED']);
    expect(new Set(s.envois.map((e) => e.uri))).toEqual(new Set([ADRESSE_WEBHOOKS]));
    expect(new Set(s.envois.map((e) => e.jeton))).toEqual(new Set(['jeton-de-test']));
    expect(s.envois[0]!.url).toBe('https://b.myshopify.com/admin/api/2026-10/graphql.json');
  });

  it('🔴 rejoué, un sujet déjà abonné vaut « déjà » (mesuré) : un second branchement est idempotent', async () => {
    const s = shopify((sujet) => ({ corps: sujet === 'ORDERS_PAID' ? deja : cree }));
    const r = await abonnerWebhooks(ACCES, s.appeler);
    expect(r).toEqual({ ok: true, abonnes: SUJETS_ABONNES.filter((x) => x !== 'ORDERS_PAID'), deja: ['ORDERS_PAID'] });
  });

  it('un autre refus de Shopify s’arrête et nomme le sujet ; une panne aussi', async () => {
    const refus = { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ message: 'Access denied' }] } } };
    const r = await abonnerWebhooks(ACCES, shopify((sujet) => ({ corps: sujet === 'CHECKOUTS_CREATE' ? refus : cree })).appeler);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('CHECKOUTS_CREATE');
    expect(await abonnerWebhooks(ACCES, shopify(() => ({ statut: 502, corps: {} })).appeler)).toMatchObject({ ok: false });
    expect(await abonnerWebhooks(ACCES, shopify(() => ({ corps: { errors: [{ message: 'Throttled' }] } })).appeler)).toMatchObject({ ok: false });
  });
});
