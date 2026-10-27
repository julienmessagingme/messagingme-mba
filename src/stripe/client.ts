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

/** POST en formulaire pour créer, GET pour lire un prix, DELETE pour arrêter un abonnement tout de suite (lot 6, B2b). */
export interface TransportStripe {
  post(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe>;
  get(url: string, entetes: Record<string, string>): Promise<ReponseStripe>;
  delete(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe>;
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

  async delete(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    return lireReponse(await fetch(url, {
      method: 'DELETE',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...entetes },
      body: corps,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_DEFAUT_MS),
    }));
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
    readonly operation: 'prix' | 'facture' | 'client' | 'session' | 'abonnement' | 'portail' | 'resiliation' | 'siege',
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
  operation: 'prix' | 'facture' | 'client' | 'session' | 'abonnement' | 'portail' | 'resiliation' | 'siege',
  chemin: string,
  champs: Record<string, string> | null,
  o: { cle: string; idempotence?: string; supprimer?: true },
  schema: z.ZodType<T>,
): Promise<T> {
  // 🔴 La frontière (spec Business, 2026-10-27) : abonnements_numero porte aussi des lignes `ops_…`, la fin du numéro d'une
  // offre posée dans /ops, qui ne sont pas des abonnements Stripe. Aucune ne doit partir ici, même par un chemin oublié.
  if (chemin.startsWith('/subscriptions/') && !chemin.startsWith('/subscriptions/sub_')) {
    throw new StripeError(operation, null, null, 'abonnement_hors_stripe', 'identifiant hors Stripe');
  }
  const entetes: Record<string, string> = { authorization: `Bearer ${o.cle}`, 'stripe-version': VERSION_API_STRIPE };
  const avecCle = { ...entetes, 'idempotency-key': o.idempotence ?? '' };
  let res: ReponseStripe;
  try {
    res = champs === null
      ? await transport.get(`${API}${chemin}`, entetes)
      : o.supprimer
        ? await transport.delete(`${API}${chemin}`, formulaire(champs), avecCle)
        : await transport.post(`${API}${chemin}`, formulaire(champs), avecCle);
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
  /** `exclusive`, `inclusive` ou `unspecified` ; lu tel quel, la recharge exige `exclusive` (`ouvrirPaiement`). */
  tax_behavior: z.string().nullable().optional(),
  /** Absent ou nul pour un prix ponctuel (la recharge). */
  recurring: z.object({ interval: z.string(), interval_count: z.number().int() }).nullable().optional(),
});

export interface PrixStripe {
  /** En centimes, `null` quand le prix n'a pas de montant unitaire fixe. */
  montantCentimes: number | null;
  devise: string;
  /** Le traitement de la taxe (`tax_behavior`) : `exclusive` = la taxe s'ajoute au montant. `null` si Stripe ne le dit pas. */
  taxe: string | null;
  /** La récurrence d'un prix d'abonnement (le numéro fourni), `null` pour un prix ponctuel. */
  recurrence: { intervalle: string; nombre: number } | null;
}

/**
 * Lit un prix chez Stripe (la clé restreinte a les prix en LECTURE). Sert à recouper, AVANT d'ouvrir un paiement, le
 * prix configuré avec ce qu'il est censé vendre : une recharge (`src/stripe/paiement.ts`, qui seule exige aussi la taxe
 * en sus), le Pro, le numéro fourni et les sièges. L'identifiant vient de la
 * configuration serveur, jamais du client : il est quand même encodé dans le chemin.
 */
export async function lirePrixStripe(transport: TransportStripe, o: { cle: string; prix: string }): Promise<PrixStripe> {
  const p = await appeler(transport, 'prix', `/prices/${encodeURIComponent(o.prix)}`, null, { cle: o.cle }, prixSchema);
  return {
    montantCentimes: p.unit_amount,
    devise: p.currency,
    taxe: p.tax_behavior ?? null,
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
  /** Ce qui est vendu (lot 6, B1) : le numéro fourni, ou le Pro. Le webhook route l'abonnement sur cette métadonnée. */
  produit: 'numero' | 'pro';
  /** Le Pro seulement : sa périodicité, recopiée en métadonnée (le webhook la relit à la création). */
  periodicite?: 'mois' | 'an';
  /**
   * Le Pro seulement : l'essai, en jours (spec offres v2). Carte toujours demandée, abonnement annulé s'il n'a aucun moyen
   * de paiement à la fin, et la marque `essai` sur la session ET l'abonnement : le webhook la relit sur chaque événement.
   */
  essaiJours?: number;
}

/**
 * Crée la session Checkout de l'ABONNEMENT d'un numéro fourni (lot 3c, livraison B) et rend son adresse. Même taxe, même
 * TVA, même adresse que la recharge, même adaptive pricing éteint (un abonnement réglé en dollars ne serait pas le
 * nôtre). Les métadonnées `tenant_id` et `produit: numero` sont posées sur la session ET sur l'abonnement
 * (`subscription_data`) : le webhook relit la première à la confirmation, et les factures des renouvellements portent
 * les secondes (`parent.subscription_details.metadata`). ⚠️ Pas de `invoice_creation` : en mode abonnement, Stripe émet
 * la facture lui-même et refuse ce paramètre. Le champ « code promo » est ouvert aux deux produits (le numéro depuis la
 * décision de Julien du 2026-10-13) : un code se crée dans le tableau de bord, donc par nous seuls, et chacun se restreint
 * à son produit chez Stripe (le compte est partagé).
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
    'metadata[produit]': d.produit,
    'subscription_data[metadata][tenant_id]': d.tenantId,
    'subscription_data[metadata][produit]': d.produit,
    allow_promotion_codes: 'true',
    // Le Pro (lot 6, B1) : sa périodicité, que le webhook relit à la création.
    ...(d.produit === 'pro' && d.periodicite
      ? { 'metadata[periodicite]': d.periodicite, 'subscription_data[metadata][periodicite]': d.periodicite }
      : {}),
    ...(d.produit === 'pro' && d.essaiJours
      ? {
        'subscription_data[trial_period_days]': String(d.essaiJours),
        payment_method_collection: 'always',
        'subscription_data[trial_settings][end_behavior][missing_payment_method]': 'cancel',
        'metadata[essai]': String(d.essaiJours),
        'subscription_data[metadata][essai]': String(d.essaiJours),
      }
      : {}),
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

/**
 * LA FIN PROGRAMMÉE D'UN ABONNEMENT, telle que Stripe la dit : `cancel_at` quand il la date, sinon la fin de la période en
 * cours si `cancel_at_period_end`, sinon aucune. La période vit sur les lignes (`current_period_end`) dans la version d'API
 * épinglée, la plus tardive fait foi. 🔴 Un seul calcul pour le webhook (Pro et numéro) et la résiliation de la console :
 * l'état que l'une écrit est celui que l'autre réécrira.
 */
export function finPrevueDe(a: {
  cancel_at?: number | null; cancel_at_period_end?: boolean; items?: { data: Array<{ current_period_end?: number }> };
}): Date | null {
  const fins = (a.items?.data ?? []).map((l) => l.current_period_end).filter((v): v is number => typeof v === 'number');
  const finDePeriode = fins.length > 0 ? Math.max(...fins) : null;
  const fin = a.cancel_at ?? (a.cancel_at_period_end === true ? finDePeriode : null);
  return fin === null ? null : new Date(fin * 1000);
}

const finChangeeSchema = z.object({
  id: z.string().startsWith('sub_'),
  cancel_at: z.number().int().nullable().optional(),
  cancel_at_period_end: z.boolean().optional(),
  items: z.object({ data: z.array(z.object({ current_period_end: z.number().int().optional() })) }).optional(),
});

/**
 * RÉSILIER LE PRO DEPUIS LA CONSOLE, OU ANNULER CETTE RÉSILIATION (2026-10-26) : la fin posée à la fin de la période payée
 * (`cancel_at_period_end`), ou retirée. Rend la fin prévue que Stripe dit APRÈS le changement (`finPrevueDe`), et refuse
 * une réponse qui ne porte pas ce qui a été demandé. 🔴 Une fin DATÉE (`cancel_at` posé au tableau de bord, avant la fin de
 * période) n'est PAS retirée ici : le retirer recalcule la période et peut ajouter des prorata à la facture d'un client payant
 * (relecture du 2026-10-26). La réponse le dit (`finDatee`), l'appelant renvoie vers nous. La clé restreinte doit pouvoir
 * ÉCRIRE les abonnements.
 * 🔴 Une clé d'idempotence PAR DEMANDE, jamais par abonnement (`fin-<abonnement>` est celle du numéro) : « résilier,
 * annuler, résilier » dans les 24 heures rejouerait sinon la première réponse, et la seconde résiliation ne s'appliquerait pas.
 */
export async function changerFinAbonnement(transport: TransportStripe, o: {
  cle: string; abonnementId: string; resilier: boolean; idempotence: string;
}): Promise<{ finPrevueLe: Date | null; finDatee: boolean }> {
  const r = await appeler(transport, 'resiliation', `/subscriptions/${encodeURIComponent(o.abonnementId)}`, {
    cancel_at_period_end: o.resilier ? 'true' : 'false',
  }, { cle: o.cle, idempotence: o.idempotence }, finChangeeSchema);
  if (r.id !== o.abonnementId) throw new StripeError('resiliation', 200, null, null, 'reponse pour un autre abonnement');
  const finPrevueLe = finPrevueDe(r);
  // Retirer n'a pas suffi : une fin datée reste, posée ailleurs que par `cancel_at_period_end`.
  if (!o.resilier && finPrevueLe !== null) return { finPrevueLe, finDatee: true };
  if ((finPrevueLe !== null) !== o.resilier) throw new StripeError('resiliation', 200, null, null, 'reponse sans le changement demande');
  return { finPrevueLe, finDatee: false };
}

/** Ce qu'on lit d'une facture listée. Lue une à une : une facture illisible est écartée, elle ne cache pas les autres. */
const factureListeeSchema = z.object({
  id: z.string().startsWith('in_'),
  customer: z.union([z.string(), z.object({ id: z.string() })]).nullable().optional(),
  number: z.string().nullable().optional(),
  created: z.number().int(),
  status: z.string().nullable().optional(),
  total: z.number().int(),
  currency: z.string(),
  hosted_invoice_url: z.string().nullable().optional(),
  invoice_pdf: z.string().nullable().optional(),
  parent: z.object({
    subscription_details: z.object({ metadata: z.record(z.string(), z.string()).nullable().optional() }).nullable().optional(),
  }).nullable().optional(),
  lines: z.object({ data: z.array(z.object({ description: z.string().nullable().optional() })) }).optional(),
});
const listeFacturesSchema = z.object({ data: z.array(z.unknown()), has_more: z.boolean() });

/** Une facture de l'espace, telle que la liste de la console la montre. Les adresses sont `https` ou `null`. */
export interface FactureStripe {
  id: string;
  numero: string | null;
  creeLe: Date;
  /** `draft`, `open`, `paid`, `uncollectible`, `void`, ou une valeur future. */
  statut: string | null;
  totalCentimes: number;
  devise: string;
  urlPage: string | null;
  urlPdf: string | null;
  /** `produit` des métadonnées de l'abonnement qu'elle facture (`pro`, `numero`), `null` hors abonnement. */
  produit: string | null;
  /** Le libellé de sa première ligne, tel que la facture le porte. */
  libelle: string | null;
}

const https = (u: string | null | undefined): string | null => (typeof u === 'string' && u.startsWith('https://') ? u : null);

/**
 * Les dernières factures d'un client Stripe, les plus récentes d'abord (2026-10-26, « Vos factures » de la console). La clé
 * restreinte doit avoir les factures en LECTURE (comme `lireFactureStripe`). 🔴 L'identifiant du client vient de notre base,
 * jamais du navigateur, et une facture d'un autre client (ce que Stripe ne rend pas) est écartée quand même.
 */
export async function listerFacturesStripe(transport: TransportStripe, o: { cle: string; customerId: string; limite: number }): Promise<{
  factures: FactureStripe[]; ecartees: number; plus: boolean;
}> {
  const q = new URLSearchParams({ customer: o.customerId, limit: String(o.limite) }).toString();
  const r = await appeler(transport, 'facture', `/invoices?${q}`, null, { cle: o.cle }, listeFacturesSchema);
  const factures: FactureStripe[] = [];
  let ecartees = 0;
  for (const brute of r.data) {
    const lu = factureListeeSchema.safeParse(brute);
    const client = lu.success && lu.data.customer ? (typeof lu.data.customer === 'string' ? lu.data.customer : lu.data.customer.id) : null;
    if (!lu.success || client !== o.customerId) {
      ecartees += 1;
      continue;
    }
    const f = lu.data;
    factures.push({
      id: f.id, numero: f.number ?? null, creeLe: new Date(f.created * 1000), statut: f.status ?? null,
      totalCentimes: f.total, devise: f.currency, urlPage: https(f.hosted_invoice_url), urlPdf: https(f.invoice_pdf),
      produit: f.parent?.subscription_details?.metadata?.produit ?? null,
      libelle: f.lines?.data[0]?.description ?? null,
    });
  }
  return { factures, ecartees, plus: r.has_more };
}

const arreteSchema = z.object({ id: z.string().startsWith('sub_'), status: z.literal('canceled') });

/**
 * Arrête TOUT DE SUITE l'abonnement du numéro seul au passage en Pro (lot 6, B2b). Avec `avoir` : `prorate` crédite le
 * temps non utilisé, `invoice_now` l'émet sur une facture finale, négative, qui crédite le solde du client ; la facture
 * suivante (le Pro) le consomme. Sans (J7 de la relecture : une période impayée, rien à rendre) : un arrêt nu. La clé
 * restreinte doit pouvoir ÉCRIRE les abonnements. Rejouable : l'idempotence est l'abonnement, et une clé par choix, pour
 * qu'un rejeu qui changerait d'avis ne soit pas refusé pour des paramètres différents.
 */
export async function arreterAbonnementNumeroSeul(transport: TransportStripe, o: { cle: string; abonnementId: string; avoir: boolean }): Promise<void> {
  const champs: Record<string, string> = o.avoir ? { prorate: 'true', invoice_now: 'true' } : {};
  const r = await appeler(transport, 'resiliation', `/subscriptions/${encodeURIComponent(o.abonnementId)}`, champs, {
    cle: o.cle, idempotence: `${o.avoir ? 'avoir' : 'arret'}-${o.abonnementId}`, supprimer: true,
  }, arreteSchema);
  if (r.id !== o.abonnementId) throw new StripeError('resiliation', 200, null, null, 'reponse pour un autre abonnement');
}

const abonnementCreeSchema = z.object({
  id: z.string().startsWith('sub_'),
  // `error_if_incomplete` : un paiement refusé rend 402 et ne crée rien ; un autre statut que `active` est un refus.
  status: z.literal('active'),
  items: z.object({ data: z.array(z.object({ current_period_end: z.number().int().optional() })) }).optional(),
});

/**
 * Recrée l'abonnement du numéro seul à la fin d'un Pro résilié (lot 6, B2b), 3,50 € HT par mois sur la CARTE DU PRO :
 * Checkout la range sur l'abonnement, pas sur le client (mesuré le 2026-10-08), d'où `carte`. Hors session (le client
 * n'est pas là), taxe comme au Checkout, et nos métadonnées : ses factures suivent ensuite le chemin du numéro. Un
 * paiement refusé lève un `StripeError` 402 sans rien créer : le chemin de l'impayé (décision de Julien).
 */
export async function creerAbonnementNumeroSeul(transport: TransportStripe, o: {
  cle: string; tenantId: string; customerId: string; prix: string; carte: string; idempotence: string;
}): Promise<{ id: string; periodeFin: Date | null }> {
  const r = await appeler(transport, 'abonnement', '/subscriptions', {
    customer: o.customerId,
    'items[0][price]': o.prix,
    'items[0][quantity]': '1',
    default_payment_method: o.carte,
    payment_behavior: 'error_if_incomplete',
    off_session: 'true',
    'automatic_tax[enabled]': 'true',
    'metadata[tenant_id]': o.tenantId,
    'metadata[produit]': 'numero',
  }, { cle: o.cle, idempotence: o.idempotence }, abonnementCreeSchema);
  const fins = (r.items?.data ?? []).map((l) => l.current_period_end).filter((v): v is number => typeof v === 'number');
  return { id: r.id, periodeFin: fins.length > 0 ? new Date(Math.max(...fins) * 1000) : null };
}

/** Une ligne d'un abonnement : son identifiant (`si_`), son prix et sa quantité. */
export interface LigneAbonnement {
  id: string;
  prix: string;
  quantite: number;
  /** Le prix unitaire HT de la ligne, en centimes (`price.unit_amount`), avant toute remise ; `null` s'il n'est pas fixe. */
  montantCentimes: number | null;
}

const ligneSchema = z.object({
  id: z.string().startsWith('si_'),
  quantity: z.number().int().nonnegative().optional(),
  current_period_end: z.number().int().optional(),
  price: z.object({ id: z.string().startsWith('price_'), unit_amount: z.number().int().nullable().optional() }),
});
const versLignes = (data: Array<z.infer<typeof ligneSchema>>): LigneAbonnement[] =>
  data.map((l) => ({ id: l.id, prix: l.price.id, quantite: l.quantity ?? 1, montantCentimes: l.price.unit_amount ?? null }));

const abonnementLuSchema = z.object({
  id: z.string().startsWith('sub_'),
  status: z.string(),
  items: z.object({ data: z.array(ligneSchema) }),
  latest_invoice: z.union([z.string(), z.object({ id: z.string() })]).nullable().optional(),
  cancel_at: z.number().int().nullable().optional(),
  cancel_at_period_end: z.boolean().optional(),
  /** Les remises qui s'appliquent à l'abonnement (un code promo) : des identifiants, ou des objets une fois étendues. */
  discounts: z.array(z.unknown()).nullable().optional(),
});

/**
 * Lit un abonnement chez Stripe (livraison 7) : son statut, ses lignes et leur prix, sa dernière facture, sa fin prévue
 * (`finPrevueDe`) et la présence d'une remise. Les sièges du Pro s'y comptent, et la fin prévue s'y relit, à chaque
 * `customer.subscription.updated` : la charge d'un événement peut arriver dans le désordre, l'abonnement relu est l'état de
 * maintenant. La clé restreinte doit pouvoir LIRE les abonnements.
 */
export async function lireAbonnementStripe(transport: TransportStripe, o: { cle: string; abonnementId: string }): Promise<{
  statut: string; lignes: LigneAbonnement[]; derniereFacture: string | null; finPrevueLe: Date | null; remise: boolean;
}> {
  const a = await appeler(transport, 'siege', `/subscriptions/${encodeURIComponent(o.abonnementId)}`, null, { cle: o.cle }, abonnementLuSchema);
  if (a.id !== o.abonnementId) throw new StripeError('siege', 200, null, null, 'reponse pour un autre abonnement');
  const f = a.latest_invoice;
  return {
    statut: a.status, lignes: versLignes(a.items.data), derniereFacture: f ? (typeof f === 'string' ? f : f.id) : null,
    finPrevueLe: finPrevueDe(a), remise: (a.discounts?.length ?? 0) > 0,
  };
}

const abonnementChangeSchema = abonnementLuSchema.extend({
  /** Non nul : le changement attend le paiement de sa facture (`pending_if_incomplete`), rien n'est encore appliqué. */
  pending_update: z.unknown().nullable().optional(),
  latest_invoice: z.union([
    z.string(),
    z.object({ id: z.string(), hosted_invoice_url: z.string().url().startsWith('https://').nullable().optional() }),
  ]).nullable().optional(),
});

/**
 * Change UNE ligne d'un abonnement (livraison 7, les sièges du Pro) : la quantité d'une ligne existante (`ligne.id`), ou
 * une ligne neuve à un prix (`ligne.prix`) ; une quantité nulle supprime la ligne existante. `facturerMaintenant` : le
 * prorata est facturé sur le coup (`always_invoice`) et le changement n'est APPLIQUÉ que si cette facture est payée
 * (`pending_if_incomplete`) ; sinon, aucun prorata ni paiement (`none`), pour un retrait. `enAttente` dit que Stripe
 * attend le paiement : rien n'a changé, la facture est à régler sur `urlFacture`. La clé restreinte doit pouvoir ÉCRIRE
 * les abonnements.
 */
export async function changerLigneAbonnement(transport: TransportStripe, o: {
  cle: string; abonnementId: string; ligne: { id: string } | { prix: string }; quantite: number; facturerMaintenant: boolean; idempotence: string;
}): Promise<{ enAttente: boolean; lignes: LigneAbonnement[]; urlFacture: string | null }> {
  const ligne: Record<string, string> = 'id' in o.ligne
    ? (o.quantite === 0 ? { 'items[0][id]': o.ligne.id, 'items[0][deleted]': 'true' } : { 'items[0][id]': o.ligne.id, 'items[0][quantity]': String(o.quantite) })
    : { 'items[0][price]': o.ligne.prix, 'items[0][quantity]': String(o.quantite) };
  const a = await appeler(transport, 'siege', `/subscriptions/${encodeURIComponent(o.abonnementId)}`, {
    ...ligne,
    proration_behavior: o.facturerMaintenant ? 'always_invoice' : 'none',
    ...(o.facturerMaintenant ? { payment_behavior: 'pending_if_incomplete' } : {}),
    'expand[0]': 'latest_invoice',
  }, { cle: o.cle, idempotence: o.idempotence }, abonnementChangeSchema);
  if (a.id !== o.abonnementId) throw new StripeError('siege', 200, null, null, 'reponse pour un autre abonnement');
  const f = a.latest_invoice;
  return {
    enAttente: a.pending_update !== null && a.pending_update !== undefined,
    lignes: versLignes(a.items.data),
    urlFacture: f && typeof f !== 'string' ? (f.hosted_invoice_url ?? null) : null,
  };
}

/** Le mode d'une clé, lu sur son préfixe (vérifié au démarrage, `src/config.ts`). */
export function estCleLive(cle: string): boolean {
  return /^(sk|rk)_live_/.test(cle);
}
