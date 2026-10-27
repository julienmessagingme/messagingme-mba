import { describe, it, expect } from 'vitest';
import type { ReponseStripe, TransportStripe } from '../src/stripe/client';
import { ouvrirPro, ouvrirPortailPro, PRO_INDISPONIBLE, type DepsPro } from '../src/stripe/pro';
import type { Offre } from '../src/offres/offres';

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
  /** Aucun arrêt d'abonnement dans ces cas : un appel serait une régression. */
  async delete(): Promise<ReponseStripe> {
    throw new Error('arrêt d’abonnement non prévu');
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

function deps(o: { prix?: Record<string, unknown>; reponses?: ReponseStripe[]; client?: string | null; autorise?: boolean; vivant?: boolean; prixVides?: boolean; offre?: Offre; dejaEu?: boolean; filiere?: 'api' | 'application' | null } = {}) {
  const transport = new FauxStripe(o.prix ?? { price_pro_mois: MOIS, price_pro_an: AN }, o.reponses ?? [{ status: 200, json: { id: 'cus_A' } }, SESSION]);
  const d: DepsPro = {
    stripe: { cle: 'rk_test_fausse', livemode: false, prix: { refill_5: '', refill_10: '', refill_50: '', refill_100: '' }, transport, pageCredit: 'https://x', pageClaude: 'https://x' },
    prixProMois: o.prixVides ? '' : 'price_pro_mois',
    prixProAn: o.prixVides ? '' : 'price_pro_an',
    urlConsole: 'https://console.exemple/',
    clients: { clientDe: async () => o.client ?? null, retenirClient: async (_t, _l, c) => c },
    payeurAutorise: async () => o.autorise ?? true,
    proVivant: async () => o.vivant ?? false,
    offreDe: async () => o.offre ?? 'base',
    // Par défaut, l'espace a déjà eu un Pro : pas d'essai (les cas de l'essai le disent).
    dejaEuUnPro: async () => o.dejaEu ?? true,
    // Par défaut, la filière API (2026-10-22) : la filière application a son cas.
    filiereDe: async () => (o.filiere === undefined ? 'api' : o.filiere),
  };
  return { d, transport };
}

describe('ouvrirPro', () => {
  it('🔴 filière application : le Pro est refusé avec la phrase des contraintes, rien n’est créé chez Stripe', async () => {
    const { d, transport } = deps({ filiere: 'application' });
    const r = await ouvrirPro(d, T1, 'mois', 'u1', 'claude');
    expect(r).toMatchObject({ ok: false, statut: 409, details: { code: 'filiere_application' } });
    expect(r.ok ? '' : r.erreur).toMatch(/API WhatsApp/);
    // La coexistence (plan 2026-10-24, tâche 4) : le même numéro passe au Pro, l'application gardée.
    expect(r.ok ? '' : r.erreur).toMatch(/Pour le Pro, passez ce même numéro sur l’API officielle de WhatsApp : choisissez « Garder mon application WhatsApp Business » sur l’Accueil de la console, ou demandez-le à Claude\.$/);
    // 🔴 Sans le mot de Meta (Julien, 2026-10-25) : le client ne le comprend pas.
    expect(r.ok ? '' : r.erreur).not.toMatch(/coexistence/i);
    expect(r.ok ? '' : r.erreur).not.toMatch(/pour l’instant/);
    expect([transport.posts, transport.lus]).toEqual([[], []]);
  });

  it('🟡 une Entreprise sans Pro : 409, rien n’est créé chez Stripe (le Pro ne lui ajouterait rien)', async () => {
    const { d, transport } = deps({ offre: 'entreprise' });
    expect(await ouvrirPro(d, T1, 'mois', 'u1', 'offre')).toMatchObject({ ok: false, statut: 409, details: { code: 'deja_entreprise' } });
    expect([transport.posts, transport.lus]).toEqual([[], []]);
  });

  it('🔴 un Business sans Pro : 409, rien n’est créé chez Stripe (Julien le facture déjà, un Pro le ferait payer deux fois)', async () => {
    const { d, transport } = deps({ offre: 'business' });
    expect(await ouvrirPro(d, T1, 'mois', 'u1', 'offre')).toMatchObject({ ok: false, statut: 409, details: { code: 'deja_business' } });
    expect([transport.posts, transport.lus]).toEqual([[], []]);
  });

  it('une Entreprise qui a encore un Pro vivant garde le portail, pour le résilier', async () => {
    const { d } = deps({ offre: 'entreprise', vivant: true, client: 'cus_A', reponses: [PORTAIL] });
    expect(await ouvrirPro(d, T1, 'an', 'u1', 'offre')).toEqual({ ok: true, valeur: { url: 'https://billing.stripe.com/p/session/pro', portail: true } });
  });

  it('🔴 le mensuel : le prix du mois relu, une session d’abonnement Pro, retour sur la page de l’offre', async () => {
    const { d, transport } = deps();
    expect(await ouvrirPro(d, T1, 'mois', 'u1', 'offre')).toEqual({ ok: true, valeur: { url: 'https://checkout.stripe.com/c/pay/cs_test_pro', portail: false } });
    expect(transport.lus.at(-1)).toMatch(/\/prices\/price_pro_mois$/);
    const session = transport.posts.find((p) => p.url.endsWith('/checkout/sessions'))!;
    expect(session.corps.get('line_items[0][price]')).toBe('price_pro_mois');
    expect(session.corps.get('metadata[produit]')).toBe('pro');
    expect(session.corps.get('metadata[periodicite]')).toBe('mois');
    expect(session.corps.get('success_url')).toBe('https://console.exemple/offre?pro=recu');
    expect(session.corps.get('cancel_url')).toBe('https://console.exemple/offre?pro=abandon');
  });

  it('🔴 ouvert depuis Claude (subscribe_pro) : retour sur la page publique « paiement reçu » (spec offres v2)', async () => {
    // La personne de Claude Code n'a pas de session de console : la page de l'offre lui demanderait de se connecter.
    const { d, transport } = deps();
    expect(await ouvrirPro(d, T1, 'mois', 'u1', 'claude')).toMatchObject({ ok: true, valeur: { portail: false } });
    const session = transport.posts.find((p) => p.url.endsWith('/checkout/sessions'))!;
    expect(session.corps.get('success_url')).toBe('https://console.exemple/paiement-recu?produit=pro');
    expect(session.corps.get('cancel_url')).toBe('https://console.exemple/paiement-recu?produit=pro&abonnement=abandon');
  });

  it('🔴 l’annuel : le prix de l’an relu, sa session', async () => {
    const { d, transport } = deps();
    expect(await ouvrirPro(d, T1, 'an', 'u1', 'offre')).toMatchObject({ ok: true, valeur: { portail: false } });
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
      expect(await ouvrirPro(d, T1, periodicite, 'u1', 'offre')).toMatchObject({ ok: false, statut: 422, details: { code: 'prix_incoherent' } });
      expect(transport.posts).toEqual([]);
    }
  });

  it('🔴 un espace déjà Pro est renvoyé au portail, sans nouvelle session de paiement', async () => {
    const { d, transport } = deps({ vivant: true, client: 'cus_A', reponses: [PORTAIL] });
    expect(await ouvrirPro(d, T1, 'mois', 'u1', 'offre')).toEqual({ ok: true, valeur: { url: 'https://billing.stripe.com/p/session/pro', portail: true } });
    expect(transport.posts.map((p) => p.url)).toEqual(['https://api.stripe.com/v1/billing_portal/sessions']);
    expect(transport.posts[0]!.corps.get('return_url')).toBe('https://console.exemple/offre');
  });

  it('prix absents, Stripe non configuré, ou payeur refusé (mode test hors exploitation) : 503, rien chez Stripe', async () => {
    for (const o of [{ prixVides: true }, { autorise: false }]) {
      const { d, transport } = deps(o);
      expect(await ouvrirPro(d, T1, 'mois', 'u1', 'offre')).toEqual(PRO_INDISPONIBLE);
      expect(transport.posts).toEqual([]);
    }
    const sans = deps();
    expect(await ouvrirPro({ ...sans.d, stripe: null }, T1, 'mois', 'u1', 'offre')).toEqual(PRO_INDISPONIBLE);
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

/** L'ESSAI DE 14 JOURS (spec offres v2, livraison 6) : une fois par espace, carte toujours demandée. */
describe('l’essai de 14 jours du Pro', () => {
  it('🔴 un espace qui n’a jamais eu de Pro : 14 jours, carte demandée, annulé sans moyen de paiement, et l’essai marqué pour le webhook', async () => {
    const { d, transport } = deps({ dejaEu: false });
    expect(await ouvrirPro(d, T1, 'mois', 'u1', 'offre')).toEqual({
      ok: true, valeur: { url: 'https://checkout.stripe.com/c/pay/cs_test_pro', portail: false, essaiJours: 14 },
    });
    const corps = Object.fromEntries(transport.posts.find((p) => p.url.endsWith('/checkout/sessions'))!.corps);
    expect(corps).toMatchObject({
      'subscription_data[trial_period_days]': '14',
      payment_method_collection: 'always',
      'subscription_data[trial_settings][end_behavior][missing_payment_method]': 'cancel',
      'metadata[essai]': '14',
      'subscription_data[metadata][essai]': '14',
    });
  });

  it('🔴 jamais un second essai : un espace qui a déjà eu un Pro paie dès le départ, sans marque d’essai', async () => {
    const { d, transport } = deps({ dejaEu: true });
    expect(await ouvrirPro(d, T1, 'an', 'u1', 'offre')).toEqual({ ok: true, valeur: { url: 'https://checkout.stripe.com/c/pay/cs_test_pro', portail: false } });
    const corps = Object.fromEntries(transport.posts.find((p) => p.url.endsWith('/checkout/sessions'))!.corps);
    expect(Object.keys(corps).filter((k) => /trial|essai/.test(k))).toEqual([]);
  });
});
