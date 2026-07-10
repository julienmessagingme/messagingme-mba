import { describe, it, expect } from 'vitest';
import { MetaPricingClient, parsePricing } from '../src/meta/pricing';
import type { FetchLike } from '../src/meta/templates';

const RESPONSE = {
  pricing_analytics: {
    data: [
      {
        data_points: [
          { pricing_category: 'MARKETING', pricing_type: 'REGULAR', volume: 10, cost: 1.431 },
          { pricing_category: 'MARKETING', pricing_type: 'REGULAR', volume: 5, cost: 0.7155 },
          { pricing_category: 'UTILITY', pricing_type: 'REGULAR', volume: 4, cost: 0.1256 },
          // FREE : utility en fenêtre 24h — cost 0, ne doit PAS diluer le tarif effectif.
          { pricing_category: 'UTILITY', pricing_type: 'FREE_CUSTOMER_SERVICE', volume: 20, cost: 0 },
        ],
      },
    ],
  },
};

describe('parsePricing', () => {
  it('agrège par catégorie, dérive le tarif effectif sur REGULAR uniquement', () => {
    const p = parsePricing(RESPONSE)!;
    expect(p).not.toBeNull();
    // marketing : 15 msg facturés, cost 2.1465 -> tarif 0.1431
    expect(p.byCategory.marketing?.volume).toBe(15);
    expect(p.byCategory.marketing?.ratePerMessage).toBeCloseTo(0.1431, 4);
    // utility : seules les 4 REGULAR comptent (les 20 FREE exclues) -> tarif 0.0314
    expect(p.byCategory.utility?.volume).toBe(4);
    expect(p.byCategory.utility?.ratePerMessage).toBeCloseTo(0.0314, 4);
    // total = coûts facturés
    expect(p.totalCost).toBeCloseTo(2.2721, 4);
  });

  it('réponse malformée / vide -> null', () => {
    expect(parsePricing(null)).toBeNull();
    expect(parsePricing({})).toBeNull();
    expect(parsePricing({ pricing_analytics: { data: [] } })).toBeNull();
  });

  it('volume nul -> tarif 0 (pas de division par zéro)', () => {
    const p = parsePricing({ pricing_analytics: { data: [{ data_points: [{ pricing_category: 'MARKETING', pricing_type: 'REGULAR', volume: 0, cost: 0 }] }] } })!;
    expect(p.byCategory.marketing?.ratePerMessage).toBe(0);
  });
});

function fakeFetch(res: { ok: boolean; status: number; json: unknown }): FetchLike {
  return async () => ({ ok: res.ok, status: res.status, json: async () => res.json }) as Response;
}
function throwingFetch(): FetchLike {
  return async () => {
    throw new Error('réseau');
  };
}

describe('MetaPricingClient.getPricingAnalytics', () => {
  it('réponse OK -> résumé parsé', async () => {
    const client = new MetaPricingClient('tok', 'v23.0', fakeFetch({ ok: true, status: 200, json: RESPONSE }));
    const p = await client.getPricingAnalytics('waba1', 1000, 2000);
    expect(p?.byCategory.marketing?.ratePerMessage).toBeCloseTo(0.1431, 4);
  });

  it('HTTP non-ok (403 permission) -> null (dashboard survit)', async () => {
    const client = new MetaPricingClient('tok', 'v23.0', fakeFetch({ ok: false, status: 403, json: { error: {} } }));
    expect(await client.getPricingAnalytics('waba1', 1000, 2000)).toBeNull();
  });

  it('exception réseau -> null', async () => {
    const client = new MetaPricingClient('tok', 'v23.0', throwingFetch());
    expect(await client.getPricingAnalytics('waba1', 1000, 2000)).toBeNull();
  });
});
