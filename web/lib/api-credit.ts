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
  /**
   * Le paiement Stripe d'une ligne `achat` (sa session), que la route de facture reçoit. Absent d'une API plus
   * ancienne, ou nul : pas de lien « Facture ».
   */
  paiementId?: string | null;
  /** Ce paiement a une facture chez Stripe : c'est ce qui offre le lien. */
  facture?: boolean;
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
 * L'adresse de la facture d'un achat, hébergée par Stripe (consultation et PDF). Toute réponse en échec remonte, avec
 * le message du serveur (paiement inconnu, pas de facture, Stripe qui refuse). 🔴 Une adresse qui n'est pas https
 * est refusée ici aussi : l'écran va y envoyer un onglet.
 */
export async function ouvrirFacture(tenantId: string, paiementId: string): Promise<string> {
  const r = await request<{ url?: unknown }>(`/tenants/${tenantId}/credit/factures/${encodeURIComponent(paiementId)}`);
  if (typeof r.url !== 'string' || !estPageDePaiement(r.url)) throw new Error('adresse de facture invalide');
  return r.url;
}

/** La ligne offre-t-elle le lien « Facture » ? Un achat, rattaché à son paiement, qui a une facture. */
export function aUneFacture(m: LigneCredit): m is LigneCredit & { paiementId: string } {
  return m.raison === 'achat' && typeof m.paiementId === 'string' && m.paiementId !== '' && m.facture === true;
}

/**
 * LE CRÉDIT EST-IL ARRIVÉ, au retour d'un paiement ? (relecture du 2026-09-29)
 *
 * 🔴 ON CHERCHE LA LIGNE `achat`, PAS UN SOLDE QUI MONTE. L'écran comparait le solde relu à la PREMIÈRE lecture : si
 * le webhook de Stripe était passé avant elle (il est souvent plus rapide que le retour du navigateur), le solde ne
 * « montait » jamais pendant les relectures, et l'écran gardait « le crédit arrive… » alors qu'il était là. L'historique
 * porte une ligne `achat` par paiement crédité : elle est arrivée si elle date d'APRÈS le départ vers Stripe.
 */
const CLE_DEPART_PAIEMENT = 'mba_credit_depart_paiement';
/** L'horloge du navigateur et celle du serveur ne sont pas la même : une marge, en deçà du départ. */
export const MARGE_HORLOGE_MS = 5 * 60_000;
/** Sans départ retenu (autre onglet, stockage bloqué) : un achat de la dernière heure compte. */
export const FENETRE_SANS_DEPART_MS = 60 * 60_000;

/** Retient le moment du départ vers Stripe, pour cet onglet. Jamais bloquant : un stockage refusé n'empêche pas de payer. */
export function retenirDepartPaiement(maintenant: number): void {
  try {
    window.sessionStorage.setItem(CLE_DEPART_PAIEMENT, String(maintenant));
  } catch {
    /* le retour se rabattra sur la fenêtre sans départ */
  }
}

export function lireDepartPaiement(): number | null {
  try {
    const v = Number(window.sessionStorage.getItem(CLE_DEPART_PAIEMENT));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function oublierDepartPaiement(): void {
  try {
    window.sessionStorage.removeItem(CLE_DEPART_PAIEMENT);
  } catch {
    /* rien à oublier */
  }
}

/** À partir de quand une ligne `achat` est celle de CE paiement. */
export function seuilDuRetour(depart: number | null, maintenant: number): number {
  return depart !== null ? depart - MARGE_HORLOGE_MS : maintenant - FENETRE_SANS_DEPART_MS;
}

/** L'historique porte-t-il un achat crédité depuis `seuilMs` ? */
export function achatArriveDepuis(mouvements: readonly LigneCredit[], seuilMs: number): boolean {
  return mouvements.some((m) => m.raison === 'achat' && Date.parse(m.at) >= seuilMs);
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
