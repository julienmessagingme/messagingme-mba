import type { FetchLike } from './templates';

/** Prix agrégé pour une catégorie (sur les lignes facturées REGULAR). */
export interface CategoryPricing {
  category: string; // lowercase : marketing | utility | authentication | service | ...
  cost: number; // charges approximatives (devise du WABA)
  volume: number; // messages facturés
  ratePerMessage: number; // cost / volume (0 si volume nul)
}

export interface PricingSummary {
  /** Clé = catégorie en minuscule. */
  byCategory: Record<string, CategoryPricing>;
  /** Somme des coûts facturés sur la période. */
  totalCost: number;
}

/**
 * Lit `pricing_analytics` (Graph API, niveau WABA) : le coût réel approximatif par catégorie dans la
 * devise du WABA. Source AUTORITATIVE (pas de table de tarifs à maintenir, qui dériverait). On ne
 * retient que les lignes facturées (pricing_type REGULAR) pour dériver un tarif effectif par message ;
 * les FREE_* (utility en fenêtre 24h, entry point) ont un coût nul et ne diluent pas le tarif.
 * `fetchImpl` injectable pour tester sans réseau. Tout échec (permission, réseau) -> null : le
 * dashboard affiche alors le volume seul, jamais un faux prix.
 */
export class MetaPricingClient {
  constructor(
    private readonly token: string,
    private readonly version = 'v23.0',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  /** startTs/endTs en secondes Unix. */
  async getPricingAnalytics(wabaId: string, startTs: number, endTs: number): Promise<PricingSummary | null> {
    const field =
      `pricing_analytics.start(${startTs}).end(${endTs}).granularity(DAILY)` +
      `.metric_types(["COST","VOLUME"]).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`;
    const url = `${this.baseUrl}/${this.version}/${wabaId}?fields=${encodeURIComponent(field)}`;
    try {
      const res = await this.fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${this.token}` } });
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as unknown;
      return parsePricing(json);
    } catch {
      return null;
    }
  }
}

/** Parse la réponse Graph { pricing_analytics: { data: [ { data_points: [...] } ] } }. */
export function parsePricing(json: unknown): PricingSummary | null {
  const points = (json as { pricing_analytics?: { data?: Array<{ data_points?: unknown }> } } | null)
    ?.pricing_analytics?.data?.[0]?.data_points;
  if (!Array.isArray(points)) return null;

  const byCategory: Record<string, CategoryPricing> = {};
  let totalCost = 0;
  for (const raw of points) {
    const p = raw as { pricing_type?: unknown; pricing_category?: unknown; cost?: unknown; volume?: unknown };
    const category = typeof p.pricing_category === 'string' ? p.pricing_category.toLowerCase() : '';
    if (!category) continue;
    // Seul le facturé (REGULAR) dérive un tarif effectif ; les FREE_* ont cost 0.
    if (p.pricing_type !== 'REGULAR') continue;
    const cost = Number(p.cost) || 0;
    const volume = Number(p.volume) || 0;
    const acc = byCategory[category] ?? { category, cost: 0, volume: 0, ratePerMessage: 0 };
    acc.cost += cost;
    acc.volume += volume;
    byCategory[category] = acc;
    totalCost += cost;
  }
  for (const c of Object.values(byCategory)) {
    c.ratePerMessage = c.volume > 0 ? c.cost / c.volume : 0;
  }
  return { byCategory, totalCost };
}
