import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError } from './http';
import { estPageDePaiement, getMouvementsCredit, ouvrirPaiement } from './api-credit';

/**
 * 🔴 LA CONSOLE PART AVANT L'API (Vercel publie au push). Tant que la route de paiement n'est pas déployée, le
 * serveur rend 404 ; tant que Stripe n'est pas configuré, 503. Les deux veulent dire « recharge pas encore
 * disponible », jamais une erreur brute. Toute autre réponse en échec remonte avec son message.
 */
describe('ouvrirPaiement : ce qu’une réponse veut dire', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function repondre(status: number, corps: unknown): Array<{ url: string; corps: unknown }> {
    const appels: Array<{ url: string; corps: unknown }> = [];
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      appels.push({ url, corps: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(corps), { status, headers: { 'content-type': 'application/json' } });
    }));
    return appels;
  }

  it('200 : l’adresse de la page de paiement, et le corps ne porte que l’offre', async () => {
    const appels = repondre(200, { url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(await ouvrirPaiement('t1', 'refill_50')).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(appels[0]!.url).toContain('/tenants/t1/credit/paiement');
    expect(appels[0]!.corps).toEqual({ offre: 'refill_50' });
  });

  it('🔴 404 (route pas encore déployée) : pas encore disponible', async () => {
    repondre(404, { message: 'Route not found' });
    expect(await ouvrirPaiement('t1', 'refill_50')).toEqual({ indisponible: true });
  });

  it('🔴 503 (Stripe pas configuré) : pas encore disponible', async () => {
    repondre(503, { error: 'recharge pas encore disponible', code: 'recharge_indisponible' });
    expect(await ouvrirPaiement('t1', 'refill_100')).toEqual({ indisponible: true });
  });

  it('422 : l’erreur remonte, avec le message du serveur', async () => {
    repondre(422, { error: 'Le paiement n’a pas pu être préparé.' });
    const err = await ouvrirPaiement('t1', 'refill_50').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain('pas pu être préparé');
  });
});

describe('getMouvementsCredit', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('🔴 une réponse SANS liste rend une liste vide, pas `undefined` qui ferait tomber l’écran', async () => {
    // Vu en e2e : un corps `{}` laissait `undefined` passer, et la page entière tombait en « Application error »
    // au moment où l'historique arrivait, solde et boutons de recharge compris.
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await getMouvementsCredit('t1')).toEqual([]);
  });
});

describe('estPageDePaiement', () => {
  it('https seulement', () => {
    expect(estPageDePaiement('https://checkout.stripe.com/c/pay/cs_1')).toBe(true);
    expect(estPageDePaiement('http://checkout.stripe.com/c/pay/cs_1')).toBe(false);
    expect(estPageDePaiement('javascript:alert(1)')).toBe(false);
    expect(estPageDePaiement('pas une adresse')).toBe(false);
  });
});
