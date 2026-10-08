import { describe, it, expect } from 'vitest';
import type { ReponseStripe, TransportStripe } from '../src/stripe/client';
import { ouvrirPaiement, RECHARGE_INDISPONIBLE, type DepsPaiement } from '../src/stripe/paiement';

/**
 * L'OUVERTURE D'UN PAIEMENT, HORS DE LA ROUTE (lot 8a) : ce que l'outil MCP `buy_credit` recevra. La route, elle, est
 * tenue par `tests/http-credit-stripe.test.ts`. Ici, ce que seule la fonction porte : le payeur vient de l'appelant
 * (la personne du jeton, jamais le corps), et le montant rendu est le HT de l'offre, pas un TTC inventé.
 * Aucun appel ne part chez Stripe (transport simulé).
 */
const T1 = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';

class FauxStripe implements TransportStripe {
  constructor(private readonly reponses: ReponseStripe[]) {}
  async post(): Promise<ReponseStripe> {
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    return r;
  }
  /** Aucun arrêt d'abonnement dans ces cas : un appel serait une régression. */
  async delete(): Promise<ReponseStripe> {
    throw new Error('arrêt d’abonnement non prévu');
  }
  async get(url: string): Promise<ReponseStripe> {
    const id = url.slice(url.lastIndexOf('/') + 1);
    return { status: 200, json: { id, unit_amount: id === 'price_100' ? 10_000 : 5_000, currency: 'eur' } };
  }
}

function deps(payeurs: string[], autorise = true): DepsPaiement {
  return {
    stripe: {
      cle: 'rk_test_fausse', livemode: false,
      prix: { refill_50: 'price_50', refill_100: 'price_100' },
      transport: new FauxStripe([
        { status: 200, json: { id: 'cus_A' } },
        { status: 200, json: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' } },
      ]),
      pageCredit: 'https://console.exemple/parametres/credit',
    },
    clients: { clientDe: async () => null, retenirClient: async (_t, _l, c) => c },
    payeurAutorise: async (userId) => { payeurs.push(userId); return autorise; },
  };
}

describe('ouvrirPaiement', () => {
  it('rend l’adresse de la session et le HT de l’offre choisie, et juge le payeur que l’appelant nomme', async () => {
    const payeurs: string[] = [];
    const r = await ouvrirPaiement(deps(payeurs), T1, { offre: 'refill_100' }, 'personne-1');
    expect(r).toEqual({ ok: true, valeur: { url: 'https://checkout.stripe.com/c/pay/cs_test_1', htCentimes: 10_000 } });
    expect(payeurs).toEqual(['personne-1']);
  });

  it('un payeur refusé (mode test, pas un exploitant) : le refus « indisponible », avec son code', async () => {
    const r = await ouvrirPaiement(deps([], false), T1, { offre: 'refill_50' }, 'personne-1');
    expect(r).toEqual(RECHARGE_INDISPONIBLE);
    expect(r).toMatchObject({ statut: 503, details: { code: 'recharge_indisponible' } });
  });

  it('une offre hors de la liste fermée, ou un montant : 400, rien n’est demandé à Stripe', async () => {
    const payeurs: string[] = [];
    expect(await ouvrirPaiement(deps(payeurs), T1, { offre: 'refill_5' }, 'p')).toMatchObject({ ok: false, statut: 400 });
    expect(await ouvrirPaiement(deps(payeurs), T1, { montant: 5 }, 'p')).toMatchObject({ ok: false, statut: 400 });
    expect(payeurs).toEqual([]);
  });
});
