import { describe, it, expect } from 'vitest';
import type { ReponseStripe, TransportStripe } from '../src/stripe/client';
import { ouvrirPro, ouvrirPortailPro, PRO_INDISPONIBLE, type DepsPro } from '../src/stripe/pro';

/**
 * OUVRIR LE PAIEMENT DU PRO, ET SON PORTAIL (lot 6, livraison B1, tâche 10). Le prix configuré est relu chez Stripe AVANT
 * d'ouvrir un paiement et recoupé avec la grille (`PRIX_PRO_HT_CENTIMES`) : un prix d'un autre montant, d'une autre devise
 * ou d'une autre récurrence laisserait payer le client pour autre chose que ce qu'on lui vend. Rien n'est créé chez Stripe
 * dans ce cas. Un espace déjà Pro est renvoyé au portail : deux Pro vivants ne se paient pas.
 */
const T1 = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';

class FauxStripe implements TransportStripe {
  readonly posts: Array<{ url: string; corps: URLSearchParams }> = [];
  readonly lus: string[] = [];
  constructor(private readonly prix: Record<string, unknown>, private readonly reponses: ReponseStripe[]) {}
  async post(url: string, corps: string): Promise<ReponseStripe> {
    this.posts.push({ url, corps: new URLSearchParams(corps) });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    return r;
  }
  async get(url: string): Promise<ReponseStripe> {
    this.lus.push(url);
    const id = decodeURIComponent(url.split('/').pop() ?? '');
    return { status: 200, json: this.prix[id] };
  }
}

const MOIS = { id: 'price_pro_mois', unit_amount: 4900, currency: 'eur', recurring: { interval: 'month', interval_count: 1 } };
const AN = { id: 'price_pro_an', unit_amount: 49000, currency: 'eur', recurring: { interval: 'year', interval_count: 1 } };
const SESSION = { status: 200, json: { id: 'cs_test_pro', url: 'https://checkout.stripe.com/c/pay/cs_test_pro' } };
const PORTAIL = { status: 200, json: { id: 'bps_1', url: 'https://billing.stripe.com/p/session/pro' } };

function deps(o: { prix?: Record<string, unknown>; reponses?: ReponseStripe[]; client?: string | null; autorise?: boolean; vivant?: boolean; prixVides?: boolean; offre?: 'base' | 'pro' | 'entreprise' } = {}) {
  const transport = new FauxStripe(o.prix ?? { price_pro_mois: MOIS, price_pro_an: AN }, o.reponses ?? [{ status: 200, json: { id: 'cus_A' } }, SESSION]);
  const d: DepsPro = {
    stripe: { cle: 'rk_test_fausse', livemode: false, prix: { refill_50: '', refill_100: '' }, transport, pageCredit: 'https://x' },
    prixProMois: o.prixVides ? '' : 'price_pro_mois',
    prixProAn: o.prixVides ? '' : 'price_pro_an',
    urlConsole: 'https://console.exemple/',
    clients: { clientDe: async () => o.client ?? null, retenirClient: async (_t, _l, c) => c },
    payeurAutorise: async () => o.autorise ?? true,
    proVivant: async () => o.vivant ?? false,
    offreDe: async () => o.offre ?? 'base',
  };
  return { d, transport };
}

describe('ouvrirPro', () => {
  it('🟡 une Entreprise sans Pro : 409, rien n’est créé chez Stripe (le Pro ne lui ajouterait rien)', async () => {
    const { d, transport } = deps({ offre: 'entreprise' });
    expect(await ouvrirPro(d, T1, 'mois', 'u1')).toMatchObject({ ok: false, statut: 409, details: { code: 'deja_entreprise' } });
    expect([transport.posts, transport.lus]).toEqual([[], []]);
  });

  it('une Entreprise qui a encore un Pro vivant garde le portail, pour le résilier', async () => {
    const { d } = deps({ offre: 'entreprise', vivant: true, client: 'cus_A', reponses: [PORTAIL] });
    expect(await ouvrirPro(d, T1, 'an', 'u1')).toEqual({ ok: true, valeur: { url: 'https://billing.stripe.com/p/session/pro', portail: true } });
  });

  it('🔴 le mensuel : le prix du mois relu, une session d’abonnement Pro, retour sur la page de l’offre', async () => {
    const { d, transport } = deps();
    expect(await ouvrirPro(d, T1, 'mois', 'u1')).toEqual({ ok: true, valeur: { url: 'https://checkout.stripe.com/c/pay/cs_test_pro', portail: false } });
    expect(transport.lus.at(-1)).toMatch(/\/prices\/price_pro_mois$/);
    const session = transport.posts.find((p) => p.url.endsWith('/checkout/sessions'))!;
    expect(session.corps.get('line_items[0][price]')).toBe('price_pro_mois');
    expect(session.corps.get('metadata[produit]')).toBe('pro');
    expect(session.corps.get('metadata[periodicite]')).toBe('mois');
    expect(session.corps.get('success_url')).toBe('https://console.exemple/offre?pro=recu');
    expect(session.corps.get('cancel_url')).toBe('https://console.exemple/offre?pro=abandon');
  });

  it('🔴 l’annuel : le prix de l’an relu, sa session', async () => {
    const { d, transport } = deps();
    expect(await ouvrirPro(d, T1, 'an', 'u1')).toMatchObject({ ok: true, valeur: { portail: false } });
    expect(transport.lus.at(-1)).toMatch(/\/prices\/price_pro_an$/);
    expect(transport.posts.find((p) => p.url.endsWith('/checkout/sessions'))!.corps.get('metadata[periodicite]')).toBe('an');
  });

  it('🔴 un prix qui n’est pas celui de la grille : refusé, RIEN créé chez Stripe', async () => {
    for (const [periodicite, prix] of [
      ['mois', { ...MOIS, unit_amount: 3900 }],
      ['mois', { ...MOIS, currency: 'usd' }],
      ['mois', { ...MOIS, recurring: { interval: 'year', interval_count: 1 } }],
      ['an', { ...AN, unit_amount: 4900 }],
      ['an', { ...AN, recurring: null }],
    ] as const) {
      const { d, transport } = deps({ prix: { price_pro_mois: prix, price_pro_an: prix } });
      expect(await ouvrirPro(d, T1, periodicite, 'u1')).toMatchObject({ ok: false, statut: 422, details: { code: 'prix_incoherent' } });
      expect(transport.posts).toEqual([]);
    }
  });

  it('🔴 un espace déjà Pro est renvoyé au portail, sans nouvelle session de paiement', async () => {
    const { d, transport } = deps({ vivant: true, client: 'cus_A', reponses: [PORTAIL] });
    expect(await ouvrirPro(d, T1, 'mois', 'u1')).toEqual({ ok: true, valeur: { url: 'https://billing.stripe.com/p/session/pro', portail: true } });
    expect(transport.posts.map((p) => p.url)).toEqual(['https://api.stripe.com/v1/billing_portal/sessions']);
    expect(transport.posts[0]!.corps.get('return_url')).toBe('https://console.exemple/offre');
  });

  it('prix absents, Stripe non configuré, ou payeur refusé (mode test hors exploitation) : 503, rien chez Stripe', async () => {
    for (const o of [{ prixVides: true }, { autorise: false }]) {
      const { d, transport } = deps(o);
      expect(await ouvrirPro(d, T1, 'mois', 'u1')).toEqual(PRO_INDISPONIBLE);
      expect(transport.posts).toEqual([]);
    }
    const sans = deps();
    expect(await ouvrirPro({ ...sans.d, stripe: null }, T1, 'mois', 'u1')).toEqual(PRO_INDISPONIBLE);
  });
});

describe('ouvrirPortailPro', () => {
  it('le portail du client de l’espace, retour sur la page de l’offre ; sans client Stripe, rien à gérer (409)', async () => {
    const { d, transport } = deps({ client: 'cus_A', reponses: [PORTAIL] });
    expect(await ouvrirPortailPro(d, T1, 'u1')).toEqual({ ok: true, valeur: { url: 'https://billing.stripe.com/p/session/pro' } });
    expect(transport.posts[0]!.corps.get('return_url')).toBe('https://console.exemple/offre');
    const sans = deps({ client: null });
    expect(await ouvrirPortailPro(sans.d, T1, 'u1')).toMatchObject({ ok: false, statut: 409 });
  });

  it('🟡 Stripe pas câblé, ou un payeur non autorisé : le refus du PRO, pas celui du numéro (jaune 10 de la relecture)', async () => {
    const { d } = deps({ autorise: false });
    expect(await ouvrirPortailPro(d, T1, 'u1')).toEqual(PRO_INDISPONIBLE);
    expect(await ouvrirPortailPro({ ...d, stripe: null }, T1, 'u1')).toEqual(PRO_INDISPONIBLE);
  });
});
