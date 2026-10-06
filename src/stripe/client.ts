import { z } from 'zod';
import { HTTP_TIMEOUT_DEFAUT_MS } from '../meta/http';

/**
 * Le client REST de Stripe, sans SDK : quatre appels (lire un prix, lire une facture, créer un client, créer une session
 * Checkout), comme les clients Vercel et Meta du dépôt, avec un transport injectable pour que les tests n'appellent
 * jamais Stripe.
 *
 * Trois règles d'écriture, toutes de Stripe :
 *   - le corps est en `application/x-www-form-urlencoded`, avec les objets imbriqués en crochets
 *     (`metadata[tenant_id]`, `line_items[0][price]`) ;
 *   - la version d'API est ÉPINGLÉE (`Stripe-Version`) sur celle de la destination webhook déclarée par Julien : les
 *     objets que nous créons et ceux que le webhook nous renvoie parlent la même langue, et une montée de version
 *     côté compte ne change rien ici sans qu'on l'ait décidé ;
 *   - chaque création porte un `Idempotency-Key` : un double clic, ou deux admins qui cliquent ensemble, ne créent
 *     pas deux clients pour le même espace.
 *
 * 🔴 La clé secrète n'entre jamais dans un message d'erreur ; le message de Stripe, lui, ne part que dans les
 * journaux, jamais vers le navigateur (`src/http/credit-stripe.ts`).
 */

const API = 'https://api.stripe.com/v1';

/** La version choisie sur la destination webhook de Julien. La changer ici, c'est changer aussi celle-là. */
export const VERSION_API_STRIPE = '2025-11-17.clover';

export interface ReponseStripe {
  status: number;
  json: unknown;
}

/** POST en formulaire pour créer, GET pour lire un prix. */
export interface TransportStripe {
  post(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe>;
  get(url: string, entetes: Record<string, string>): Promise<ReponseStripe>;
}

/** Le transport de production : `fetch`, plafonné comme les autres appels sortants (30 s). */
export class FetchTransportStripe implements TransportStripe {
  async post(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    return lireReponse(await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...entetes },
      body: corps,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_DEFAUT_MS),
    }));
  }

  async get(url: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    return lireReponse(await fetch(url, { method: 'GET', headers: entetes, signal: AbortSignal.timeout(HTTP_TIMEOUT_DEFAUT_MS) }));
  }
}

async function lireReponse(res: Response): Promise<ReponseStripe> {
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Stripe a refusé, ou n'a pas répondu. `type` et `code` sont ceux de Stripe quand il les donne. */
export class StripeError extends Error {
  constructor(
    readonly operation: 'prix' | 'facture' | 'client' | 'session' | 'abonnement' | 'portail' | 'resiliation',
    readonly status: number | null,
    readonly type: string | null,
    readonly code: string | null,
    detail: string,
  ) {
    super(`stripe : ${operation} impossible (${status ?? 'reseau'}) : ${detail}`);
    this.name = 'StripeError';
  }
}

/** Les objets en crochets, à plat. `URLSearchParams` encode les crochets, ce que Stripe relit à l'identique. */
export function formulaire(champs: Record<string, string>): string {
  return new URLSearchParams(champs).toString();
}

const erreurSchema = z.object({
  error: z.object({
    type: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
});

const clientSchema = z.object({ id: z.string().startsWith('cus_') });
/** L'adresse de la page de paiement, où la console enverra l'admin : https seulement. */
const sessionSchema = z.object({ id: z.string().startsWith('cs_'), url: z.string().url().startsWith('https://') });

/**
 * Un appel à Stripe, et sa réponse vérifiée. `champs` absent : une lecture (GET), sans corps ni clé d'idempotence.
 */
async function appeler<T>(
  transport: TransportStripe,
  operation: 'prix' | 'facture' | 'client' | 'session' | 'abonnement' | 'portail' | 'resiliation',
  chemin: string,
  champs: Record<string, string> | null,
  o: { cle: string; idempotence?: string },
  schema: z.ZodType<T>,
): Promise<T> {
  const entetes: Record<string, string> = { authorization: `Bearer ${o.cle}`, 'stripe-version': VERSION_API_STRIPE };
  let res: ReponseStripe;
  try {
    res = champs === null
      ? await transport.get(`${API}${chemin}`, entetes)
      : await transport.post(`${API}${chemin}`, formulaire(champs), { ...entetes, 'idempotency-key': o.idempotence ?? '' });
  } catch (err) {
    throw new StripeError(operation, null, null, null, err instanceof Error ? err.name : 'appel impossible');
  }
  if (res.status < 200 || res.status >= 300) {
    const e = erreurSchema.safeParse(res.json);
    const d = e.success ? e.data.error : null;
    throw new StripeError(operation, res.status, d?.type ?? null, d?.code ?? null, d?.message ?? 'reponse en echec');
  }
  // `safeParse` : une réponse de Stripe est une entrée externe. Un 200 illisible échoue au lieu de deviner.
  const lu = schema.safeParse(res.json);
  if (!lu.success) throw new StripeError(operation, res.status, null, null, 'reponse illisible');
  return lu.data;
}

/** Ce qu'on lit d'un prix, et rien de plus. `unit_amount` est nul sur un prix à paliers ou « au choix du client ». */
const prixSchema = z.object({
  id: z.string().startsWith('price_'),
  unit_amount: z.number().int().nullable(),
  currency: z.string(),
  /** Absent ou nul pour un prix ponctuel (la recharge). */
  recurring: z.object({ interval: z.string(), interval_count: z.number().int() }).nullable().optional(),
});

export interface PrixStripe {
  /** En centimes, `null` quand le prix n'a pas de montant unitaire fixe. */
  montantCentimes: number | null;
  devise: string;
  /** La récurrence d'un prix d'abonnement (le numéro fourni), `null` pour un prix ponctuel. */
  recurrence: { intervalle: string; nombre: number } | null;
}

/**
 * Lit un prix chez Stripe (la clé restreinte a les prix en LECTURE). Sert à recouper, AVANT d'ouvrir un paiement, le
 * prix configuré avec l'offre qu'il est censé vendre (`src/http/credit-stripe.ts`). L'identifiant vient de la
 * configuration serveur, jamais du client : il est quand même encodé dans le chemin.
 */
export async function lirePrixStripe(transport: TransportStripe, o: { cle: string; prix: string }): Promise<PrixStripe> {
  const p = await appeler(transport, 'prix', `/prices/${encodeURIComponent(o.prix)}`, null, { cle: o.cle }, prixSchema);
  return {
    montantCentimes: p.unit_amount,
    devise: p.currency,
    recurrence: p.recurring ? { intervalle: p.recurring.interval, nombre: p.recurring.interval_count } : null,
  };
}

/**
 * Ce qu'on lit d'une facture : sa page hébergée par Stripe (consultation et PDF), https seulement. Nulle ou absente
 * tant que la facture est un brouillon, ce que rend `url: null` plutôt qu'un échec : l'appelant le dit au client.
 */
const factureSchema = z.object({
  id: z.string().startsWith('in_'),
  hosted_invoice_url: z.string().url().startsWith('https://').nullable().optional(),
});

/**
 * Lit une facture chez Stripe (la clé restreinte doit avoir les factures en LECTURE). L'identifiant vient de notre
 * base (`stripe_paiements.facture_id`, écrit par le webhook), jamais du client : il est quand même encodé.
 */
export async function lireFactureStripe(transport: TransportStripe, o: { cle: string; facture: string }): Promise<{ url: string | null }> {
  const f = await appeler(transport, 'facture', `/invoices/${encodeURIComponent(o.facture)}`, null, { cle: o.cle }, factureSchema);
  return { url: f.hosted_invoice_url ?? null };
}

/**
 * Crée le client Stripe d'un espace. 🔴 La clé d'idempotence est `client-<espace>` : deux créations simultanées pour
 * le même espace rendent le MÊME client (Stripe garde la réponse vingt-quatre heures). Les paramètres restent donc
 * les mêmes d'un appel à l'autre (l'identifiant de l'espace seul) : Stripe refuse une clé réutilisée avec d'autres
 * paramètres. Le nom et l'adresse de facturation arrivent à la première session (`customer_update`).
 */
export async function creerClientStripe(transport: TransportStripe, o: { cle: string; tenantId: string }): Promise<string> {
  const c = await appeler(transport, 'client', '/customers', { 'metadata[tenant_id]': o.tenantId }, {
    cle: o.cle, idempotence: `client-${o.tenantId}`,
  }, clientSchema);
  return c.id;
}

export interface DemandeSession {
  cle: string;
  tenantId: string;
  offre: string;
  prix: string;
  customerId: string;
  urlSucces: string;
  urlAbandon: string;
  /** Une clé par geste : elle protège d'un rejeu du même appel, pas de deux paiements voulus. */
  idempotence: string;
}

/**
 * Crée la session Checkout d'une recharge et rend son adresse. La taxe est calculée par Stripe Tax, le numéro de TVA
 * et l'adresse de facturation sont demandés au client et recopiés sur son client Stripe, et Stripe émet la facture.
 * Les métadonnées (`tenant_id`, `offre`) et `client_reference_id` sont ce que le webhook relira : sans elles, une
 * session n'est pas une recharge.
 *
 * 🔴 L'ADAPTIVE PRICING EST ÉTEINT (relecture du 2026-09-29). Allumé sur le compte, il présente le paiement dans la
 * devise du client : la session serait réglée en dollars ou en francs suisses, et le webhook, qui exige l'euro au
 * montant HT de l'offre, refuserait de créditer un paiement bel et bien encaissé.
 *
 * Le champ « code promo » est ouvert à tous (décision de Julien du 2026-09-29) : un code se crée dans le tableau de
 * bord Stripe, donc par nous seuls, et il donne le crédit PLEIN de l'offre (voir le recoupement du webhook).
 */
export async function creerSessionCheckout(transport: TransportStripe, d: DemandeSession): Promise<{ id: string; url: string }> {
  return appeler(transport, 'session', '/checkout/sessions', {
    mode: 'payment',
    customer: d.customerId,
    'line_items[0][price]': d.prix,
    'line_items[0][quantity]': '1',
    'adaptive_pricing[enabled]': 'false',
    'automatic_tax[enabled]': 'true',
    'tax_id_collection[enabled]': 'true',
    'customer_update[name]': 'auto',
    'customer_update[address]': 'auto',
    billing_address_collection: 'required',
    'invoice_creation[enabled]': 'true',
    allow_promotion_codes: 'true',
    'metadata[tenant_id]': d.tenantId,
    'metadata[offre]': d.offre,
    client_reference_id: d.tenantId,
    success_url: d.urlSucces,
    cancel_url: d.urlAbandon,
  }, { cle: d.cle, idempotence: d.idempotence }, sessionSchema);
}

export interface DemandeAbonnement {
  cle: string;
  tenantId: string;
  prix: string;
  customerId: string;
  urlSucces: string;
  urlAbandon: string;
  /** Une clé par geste : elle protège d'un rejeu du même appel, pas de deux paiements voulus. */
  idempotence: string;
}

/**
 * Crée la session Checkout de l'ABONNEMENT d'un numéro fourni (lot 3c, livraison B) et rend son adresse. Même taxe, même
 * TVA, même adresse que la recharge, même adaptive pricing éteint (un abonnement réglé en dollars ne serait pas le
 * nôtre). Les métadonnées `tenant_id` et `produit: numero` sont posées sur la session ET sur l'abonnement
 * (`subscription_data`) : le webhook relit la première à la confirmation, et les factures des renouvellements portent
 * les secondes (`parent.subscription_details.metadata`). ⚠️ Pas de `invoice_creation` : en mode abonnement, Stripe émet
 * la facture lui-même et refuse ce paramètre. Pas de code promo : rien n'a été décidé pour le numéro.
 */
export async function creerSessionAbonnement(transport: TransportStripe, d: DemandeAbonnement): Promise<{ id: string; url: string }> {
  return appeler(transport, 'abonnement', '/checkout/sessions', {
    mode: 'subscription',
    customer: d.customerId,
    'line_items[0][price]': d.prix,
    'line_items[0][quantity]': '1',
    'adaptive_pricing[enabled]': 'false',
    'automatic_tax[enabled]': 'true',
    'tax_id_collection[enabled]': 'true',
    'customer_update[name]': 'auto',
    'customer_update[address]': 'auto',
    billing_address_collection: 'required',
    'metadata[tenant_id]': d.tenantId,
    'metadata[produit]': 'numero',
    'subscription_data[metadata][tenant_id]': d.tenantId,
    'subscription_data[metadata][produit]': 'numero',
    client_reference_id: d.tenantId,
    success_url: d.urlSucces,
    cancel_url: d.urlAbandon,
  }, { cle: d.cle, idempotence: d.idempotence }, sessionSchema);
}

const portailSchema = z.object({ url: z.string().url().startsWith('https://') });

/**
 * Une session du portail client de Stripe (carte, factures, résiliation) pour le client de l'espace. La clé restreinte
 * doit pouvoir créer une session du portail, et le portail doit être activé dans le tableau de bord de Stripe.
 */
export async function creerSessionPortail(transport: TransportStripe, o: { cle: string; customerId: string; urlRetour: string }): Promise<{ url: string }> {
  const r = await appeler(transport, 'portail', '/billing_portal/sessions', { customer: o.customerId, return_url: o.urlRetour }, {
    cle: o.cle, idempotence: `portail-${o.customerId}-${Date.now()}`,
  }, portailSchema);
  return { url: r.url };
}

const finProgrammeeSchema = z.object({ id: z.string().startsWith('sub_'), cancel_at_period_end: z.literal(true) });

/**
 * Programme la fin d'un abonnement à la fin de la période payée (`cancel_at_period_end=true`, lot 4, livraison B :
 * « Abandonner » d'un abonné). La clé restreinte doit pouvoir ÉCRIRE les abonnements. La réponse doit dire
 * `cancel_at_period_end: true` : un succès qui ne le dit pas est un refus. Rejouable : l'idempotence est l'abonnement.
 */
export async function programmerFinAbonnement(transport: TransportStripe, o: { cle: string; abonnementId: string }): Promise<void> {
  const r = await appeler(transport, 'resiliation', `/subscriptions/${encodeURIComponent(o.abonnementId)}`, { cancel_at_period_end: 'true' }, {
    cle: o.cle, idempotence: `fin-${o.abonnementId}`,
  }, finProgrammeeSchema);
  if (r.id !== o.abonnementId) throw new StripeError('resiliation', 200, null, null, 'reponse pour un autre abonnement');
}

/** Le mode d'une clé, lu sur son préfixe (vérifié au démarrage, `src/config.ts`). */
export function estCleLive(cle: string): boolean {
  return /^(sk|rk)_live_/.test(cle);
}
