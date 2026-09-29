import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError } from './http';
import {
  aUneFacture, achatArriveDepuis, estPageDePaiement, FENETRE_SANS_DEPART_MS, getMouvementsCredit, lireDepartPaiement,
  MARGE_HORLOGE_MS, oublierDepartPaiement, ouvrirFacture, ouvrirPaiement, retenirDepartPaiement, seuilDuRetour,
  type LigneCredit,
} from './api-credit';

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

/**
 * LE CRÉDIT EST-IL ARRIVÉ ? (relecture du 2026-09-29) Le webhook de Stripe passe souvent AVANT la première lecture du
 * retour : comparer le solde à lui-même laissait « le crédit arrive… » à l'écran pour toujours. On cherche la ligne
 * `achat` de CE paiement, postérieure au départ vers Stripe.
 */
describe('achatArriveDepuis et seuilDuRetour', () => {
  const DEPART = Date.parse('2026-09-29T10:00:00.000Z');
  const ligne = (raison: string, at: string): LigneCredit => ({ id: at, deltaMicroEur: 50_000_000, raison, jour: null, at });

  it('🔴 un achat POSTÉRIEUR au départ est arrivé, même si le solde ne bouge plus entre deux lectures', () => {
    const seuil = seuilDuRetour(DEPART, DEPART + 30_000);
    expect(achatArriveDepuis([ligne('achat', '2026-09-29T10:00:20.000Z')], seuil)).toBe(true);
  });

  it('🔴 un achat ANCIEN (le précédent), ou une autre raison, ne compte pas', () => {
    const seuil = seuilDuRetour(DEPART, DEPART + 30_000);
    expect(achatArriveDepuis([ligne('achat', '2026-09-28T10:00:00.000Z')], seuil)).toBe(false);
    expect(achatArriveDepuis([ligne('offert', '2026-09-29T10:00:20.000Z'), ligne('recharge', '2026-09-29T10:00:30.000Z')], seuil)).toBe(false);
    expect(achatArriveDepuis([ligne('achat', 'pas une date')], seuil)).toBe(false);
  });

  it('une horloge de navigateur en avance de quelques minutes ne cache pas l’achat', () => {
    const seuil = seuilDuRetour(DEPART, DEPART);
    expect(achatArriveDepuis([ligne('achat', new Date(DEPART - MARGE_HORLOGE_MS + 1_000).toISOString())], seuil)).toBe(true);
  });

  it('sans départ retenu, un achat de la dernière heure compte, pas au-delà', () => {
    const maintenant = DEPART;
    const seuil = seuilDuRetour(null, maintenant);
    expect(achatArriveDepuis([ligne('achat', new Date(maintenant - FENETRE_SANS_DEPART_MS + 60_000).toISOString())], seuil)).toBe(true);
    expect(achatArriveDepuis([ligne('achat', new Date(maintenant - FENETRE_SANS_DEPART_MS - 60_000).toISOString())], seuil)).toBe(false);
  });
});

describe('le départ vers Stripe, retenu par onglet', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fait l’aller-retour, puis s’oublie', () => {
    const memoire = new Map<string, string>();
    vi.stubGlobal('window', { sessionStorage: {
      getItem: (k: string) => memoire.get(k) ?? null,
      setItem: (k: string, v: string) => { memoire.set(k, v); },
      removeItem: (k: string) => { memoire.delete(k); },
    } });
    retenirDepartPaiement(1_790_000_000_000);
    expect(lireDepartPaiement()).toBe(1_790_000_000_000);
    oublierDepartPaiement();
    expect(lireDepartPaiement()).toBeNull();
  });

  it('🔴 un stockage bloqué ne lève jamais : le paiement part quand même, et le retour se rabat sur la fenêtre', () => {
    vi.stubGlobal('window', { sessionStorage: {
      getItem: () => { throw new Error('bloqué'); }, setItem: () => { throw new Error('plein'); }, removeItem: () => { throw new Error('bloqué'); },
    } });
    expect(() => retenirDepartPaiement(1)).not.toThrow();
    expect(lireDepartPaiement()).toBeNull();
    expect(() => oublierDepartPaiement()).not.toThrow();
  });
});

/**
 * LA FACTURE D'UN ACHAT (décision de Julien du 2026-09-29) : l'adresse que la console donne à un onglet.
 */
describe('ouvrirFacture et aUneFacture', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function repondre(status: number, corps: unknown): string[] {
    const appels: string[] = [];
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      appels.push(url);
      return new Response(JSON.stringify(corps), { status, headers: { 'content-type': 'application/json' } });
    }));
    return appels;
  }

  it('rend l’adresse de la facture, pour CE paiement', async () => {
    const appels = repondre(200, { url: 'https://invoice.stripe.com/i/acct_x/in_1' });
    expect(await ouvrirFacture('t1', 'cs_live_1')).toBe('https://invoice.stripe.com/i/acct_x/in_1');
    expect(appels[0]).toContain('/tenants/t1/credit/factures/cs_live_1');
  });

  it('🔴 une adresse qui n’est pas https n’est jamais donnée à un onglet', async () => {
    repondre(200, { url: 'javascript:alert(1)' });
    await expect(ouvrirFacture('t1', 'cs_live_1')).rejects.toThrow();
  });

  it('un refus remonte avec le message du serveur (pas de facture, paiement inconnu)', async () => {
    repondre(404, { error: 'Ce paiement n’a pas de facture chez Stripe.', code: 'sans_facture' });
    const err = await ouvrirFacture('t1', 'cs_live_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain('pas de facture');
  });

  it('🔴 le lien n’est offert que sur un ACHAT rattaché à son paiement, et qui a une facture', () => {
    const base: LigneCredit = { id: 'a', deltaMicroEur: 1, raison: 'achat', jour: null, at: '2026-09-29T10:00:00Z' };
    expect(aUneFacture({ ...base, paiementId: 'cs_1', facture: true })).toBe(true);
    expect(aUneFacture({ ...base, paiementId: 'cs_1', facture: false })).toBe(false);
    expect(aUneFacture({ ...base, paiementId: null, facture: true })).toBe(false);
    expect(aUneFacture(base)).toBe(false); // API plus ancienne : ni l'un ni l'autre
    expect(aUneFacture({ ...base, raison: 'recharge', paiementId: 'cs_1', facture: true })).toBe(false);
  });
});
