import { describe, it, expect } from 'vitest';
import type { ReponseStripe, TransportStripe } from '../src/stripe/client';
import { ouvrirAbonnement, ouvrirPortail, programmerFinDuNumero, ABONNEMENT_INDISPONIBLE, PRIX_NUMERO_HT_CENTIMES, type DepsAbonnement } from '../src/stripe/abonnement';

/**
 * OUVRIR L'ABONNEMENT DU NUMÉRO FOURNI, ET SON PORTAIL (lot 3c, livraison B). Le prix configuré est relu chez Stripe
 * AVANT d'ouvrir un paiement : un prix ponctuel, annuel, en dollars ou d'un autre montant laisserait payer le client
 * pour autre chose que ce qu'on lui vend. Rien n'est créé chez Stripe dans ce cas.
 */
const T1 = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';

class FauxStripe implements TransportStripe {
  readonly posts: Array<{ url: string; corps: URLSearchParams }> = [];
  constructor(private readonly prix: unknown, private readonly reponses: ReponseStripe[]) {}
  async post(url: string, corps: string): Promise<ReponseStripe> {
    this.posts.push({ url, corps: new URLSearchParams(corps) });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    return r;
  }
  async get(): Promise<ReponseStripe> {
    return { status: 200, json: this.prix };
  }
}

const PRIX_JUSTE = { id: 'price_numero', unit_amount: 350, currency: 'eur', recurring: { interval: 'month', interval_count: 1 } };
const SESSION = { status: 200, json: { id: 'cs_test_9', url: 'https://checkout.stripe.com/c/pay/cs_test_9' } };

function deps(o: { prix?: unknown; reponses?: ReponseStripe[]; client?: string | null; autorise?: boolean; prixNumero?: string } = {}) {
  const transport = new FauxStripe(o.prix ?? PRIX_JUSTE, o.reponses ?? [{ status: 200, json: { id: 'cus_A' } }, SESSION]);
  const d: DepsAbonnement = {
    stripe: { cle: 'rk_test_fausse', livemode: false, prix: { refill_50: '', refill_100: '' }, transport, pageCredit: 'https://x' },
    prixNumero: o.prixNumero ?? 'price_numero',
    urlConsole: 'https://console.exemple/',
    clients: { clientDe: async () => o.client ?? null, retenirClient: async (_t, _l, c) => c },
    payeurAutorise: async () => o.autorise ?? true,
  };
  return { d, transport };
}

describe('ouvrirAbonnement', () => {
  it('🔴 le prix juste : une session d’abonnement, retour sur la page d’où l’on vient', async () => {
    expect(PRIX_NUMERO_HT_CENTIMES).toBe(350);
    const { d, transport } = deps();
    const r = await ouvrirAbonnement(d, T1, 'brancher', 'u1');
    expect(r).toEqual({ ok: true, valeur: { url: 'https://checkout.stripe.com/c/pay/cs_test_9' } });
    const session = transport.posts.find((p) => p.url.endsWith('/checkout/sessions'))!;
    expect(session.corps.get('mode')).toBe('subscription');
    expect(session.corps.get('success_url')).toBe('https://console.exemple/brancher?abonnement=recu');
    expect(session.corps.get('cancel_url')).toBe('https://console.exemple/brancher?abonnement=abandon');
    const console_ = deps();
    await ouvrirAbonnement(console_.d, T1, 'console', 'u1');
    expect(console_.transport.posts.at(-1)!.corps.get('success_url')).toBe('https://console.exemple/connecter-whatsapp?abonnement=recu');
    // Lot 4 : un réabonnement demandé à Claude revient sur une page publique, sans session de console.
    const claude = deps();
    await ouvrirAbonnement(claude.d, T1, 'claude', 'u1');
    expect(claude.transport.posts.at(-1)!.corps.get('success_url')).toBe('https://console.exemple/paiement-recu?abonnement=recu');
  });

  it('🔴 un prix qui n’est pas 3,50 € HT par mois, en euros : refusé, RIEN créé chez Stripe', async () => {
    for (const prix of [
      { ...PRIX_JUSTE, unit_amount: 420 },
      { ...PRIX_JUSTE, currency: 'usd' },
      { ...PRIX_JUSTE, recurring: null },
      { ...PRIX_JUSTE, recurring: { interval: 'year', interval_count: 1 } },
      { ...PRIX_JUSTE, recurring: { interval: 'month', interval_count: 3 } },
    ]) {
      const { d, transport } = deps({ prix });
      const r = await ouvrirAbonnement(d, T1, 'brancher', 'u1');
      expect(r).toMatchObject({ ok: false, statut: 422, details: { code: 'prix_incoherent' } });
      expect(transport.posts).toEqual([]);
    }
  });

  it('pas configuré, ou pas ouvert à ce payeur : indisponible', async () => {
    expect(await ouvrirAbonnement(deps({ prixNumero: '' }).d, T1, 'brancher', 'u1')).toEqual(ABONNEMENT_INDISPONIBLE);
    expect(await ouvrirAbonnement(deps({ autorise: false }).d, T1, 'brancher', 'u1')).toEqual(ABONNEMENT_INDISPONIBLE);
    expect(await ouvrirAbonnement({ ...deps().d, stripe: null }, T1, 'brancher', 'u1')).toEqual(ABONNEMENT_INDISPONIBLE);
  });

  it('un refus de Stripe devient un 422 lisible, jamais une panne', async () => {
    const { d } = deps({ reponses: [{ status: 200, json: { id: 'cus_A' } }, { status: 400, json: { error: { message: 'Stripe Tax pas actif' } } }] });
    expect(await ouvrirAbonnement(d, T1, 'brancher', 'u1')).toMatchObject({ ok: false, statut: 422, details: { code: 'paiement_impossible' } });
  });
});

describe('ouvrirPortail', () => {
  it('le client de l’espace : la session du portail, retour sur la page', async () => {
    const { d, transport } = deps({ client: 'cus_A', reponses: [{ status: 200, json: { url: 'https://billing.stripe.com/p/session/x' } }] });
    expect(await ouvrirPortail(d, T1, 'console', 'u1')).toEqual({ ok: true, valeur: { url: 'https://billing.stripe.com/p/session/x' } });
    expect(transport.posts[0]!.corps.get('return_url')).toBe('https://console.exemple/connecter-whatsapp');
  });

  it('un espace sans client Stripe n’a rien à gérer : 409', async () => {
    expect(await ouvrirPortail(deps({ client: null }).d, T1, 'console', 'u1')).toMatchObject({ ok: false, statut: 409 });
  });
});

describe('programmerFinDuNumero (« Abandonner » d’un abonné, lot 4, livraison B)', () => {
  it('🔴 POST sur l’abonnement, `cancel_at_period_end=true`, et la réponse doit le dire', async () => {
    const { d, transport } = deps({ reponses: [{ status: 200, json: { id: 'sub_1', cancel_at_period_end: true } }] });
    expect(await programmerFinDuNumero(d, 'sub_1')).toEqual({ ok: true, valeur: true });
    expect(transport.posts[0]!.url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(transport.posts[0]!.corps.get('cancel_at_period_end')).toBe('true');
  });

  it('🔴 un succès qui ne dit pas `cancel_at_period_end: true`, ou un refus (clé sans le droit d’écrire) : un refus rendu, jamais levé', async () => {
    const muet = deps({ reponses: [{ status: 200, json: { id: 'sub_1', cancel_at_period_end: false } }] });
    expect(await programmerFinDuNumero(muet.d, 'sub_1')).toMatchObject({ ok: false, statut: 422 });
    const interdit = deps({ reponses: [{ status: 403, json: { error: { type: 'invalid_request_error', message: 'The provided key does not have the required permissions' } } }] });
    expect(await programmerFinDuNumero(interdit.d, 'sub_1')).toMatchObject({ ok: false, statut: 422 });
  });

  it('Stripe non configuré : indisponible, sans appel', async () => {
    const { d, transport } = deps();
    expect(await programmerFinDuNumero({ ...d, stripe: null }, 'sub_1')).toEqual(ABONNEMENT_INDISPONIBLE);
    expect(transport.posts).toEqual([]);
  });
});
