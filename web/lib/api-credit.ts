import { ApiError, request } from './http';

/**
 * Le crédit IA côté navigateur : son historique, et l'ouverture d'un paiement Stripe.
 *
 * 🔴 LE NAVIGATEUR NE CRÉDITE RIEN. Il demande une session de paiement et y part ; au retour, il relit le solde.
 * Seul le webhook de Stripe, signé, crédite l'espace (`src/http/credit-stripe.ts`).
 */

/** Les deux offres. Le client choisit une offre, jamais un montant : le prix vit chez Stripe, le crédit au serveur. */
export type OffreRecharge = 'refill_50' | 'refill_100';

/** Une ligne de l'historique, telle que le serveur la rend : sans note, la raison dit ce qui s'est passé. */
export interface LigneCredit {
  id: string;
  deltaMicroEur: number;
  /** `achat`, `offert`, `recharge`, `conso` (agents IA, par jour), `traduction` (par jour), ou une valeur future. */
  raison: string;
  /** AAAA-MM-JJ quand la ligne agrège une journée (agents, traductions). */
  jour: string | null;
  at: string;
}

/**
 * L'historique du crédit. Une réponse sans liste rend une liste vide : un corps inattendu (un proxy, une API d'une
 * autre version) ne doit pas faire tomber l'écran entier, qui montre aussi le solde et les boutons de recharge.
 */
export async function getMouvementsCredit(tenantId: string): Promise<LigneCredit[]> {
  const r = await request<{ mouvements?: unknown }>(`/tenants/${tenantId}/agents/mouvements`);
  return Array.isArray(r.mouvements) ? (r.mouvements as LigneCredit[]) : [];
}

/**
 * Ce que rend une demande de paiement :
 *   - `url` : l'adresse de la page de paiement hébergée par Stripe, où la console part ;
 *   - `indisponible` : la recharge n'est pas encore ouverte (Stripe pas configuré, ou la route pas encore
 *     déployée : la console part sur Vercel avant l'API, donc un 404 veut dire la même chose qu'un 503).
 * Toute autre erreur remonte, avec le message du serveur.
 */
export type IssuePaiement = { url: string } | { indisponible: true };

export async function ouvrirPaiement(tenantId: string, offre: OffreRecharge): Promise<IssuePaiement> {
  try {
    const r = await request<{ url: string }>(`/tenants/${tenantId}/credit/paiement`, {
      method: 'POST',
      body: JSON.stringify({ offre }),
    });
    return { url: r.url };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 503)) return { indisponible: true };
    throw err;
  }
}

/**
 * Une adresse où la console accepte de partir : une page https. ⚠️ L'hôte n'est PAS vérifié, délibérément : une
 * page de paiement Stripe peut vivre sous un domaine personnalisé du compte, et la refuser casserait le paiement
 * le jour où Julien en pose un. L'adresse vient de notre serveur, qui l'a lue chez Stripe.
 */
export function estPageDePaiement(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
