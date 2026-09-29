import { z } from 'zod';
import { HTTP_TIMEOUT_DEFAUT_MS } from '../meta/http';

/**
 * Le client REST de Stripe, sans SDK : deux appels (créer un client, créer une session Checkout), comme les clients
 * Vercel et Meta du dépôt, avec un transport injectable pour que les tests n'appellent jamais Stripe.
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

/** POST en formulaire. Le seul verbe dont ce module a besoin. */
export interface TransportStripe {
  post(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe>;
}

/** Le transport de production : `fetch`, plafonné comme les autres appels sortants (30 s). */
export class FetchTransportStripe implements TransportStripe {
  async post(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...entetes },
      body: corps,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_DEFAUT_MS),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }
}

/** Stripe a refusé, ou n'a pas répondu. `type` et `code` sont ceux de Stripe quand il les donne. */
export class StripeError extends Error {
  constructor(
    readonly operation: 'client' | 'session',
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

async function appeler<T>(
  transport: TransportStripe,
  operation: 'client' | 'session',
  chemin: string,
  champs: Record<string, string>,
  o: { cle: string; idempotence: string },
  schema: z.ZodType<T>,
): Promise<T> {
  let res: ReponseStripe;
  try {
    res = await transport.post(`${API}${chemin}`, formulaire(champs), {
      authorization: `Bearer ${o.cle}`,
      'stripe-version': VERSION_API_STRIPE,
      'idempotency-key': o.idempotence,
    });
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
 */
export async function creerSessionCheckout(transport: TransportStripe, d: DemandeSession): Promise<{ id: string; url: string }> {
  return appeler(transport, 'session', '/checkout/sessions', {
    mode: 'payment',
    customer: d.customerId,
    'line_items[0][price]': d.prix,
    'line_items[0][quantity]': '1',
    'automatic_tax[enabled]': 'true',
    'tax_id_collection[enabled]': 'true',
    'customer_update[name]': 'auto',
    'customer_update[address]': 'auto',
    billing_address_collection: 'required',
    'invoice_creation[enabled]': 'true',
    'metadata[tenant_id]': d.tenantId,
    'metadata[offre]': d.offre,
    client_reference_id: d.tenantId,
    success_url: d.urlSucces,
    cancel_url: d.urlAbandon,
  }, { cle: d.cle, idempotence: d.idempotence }, sessionSchema);
}

/** Le mode d'une clé, lu sur son préfixe (vérifié au démarrage, `src/config.ts`). */
export function estCleLive(cle: string): boolean {
  return /^(sk|rk)_live_/.test(cle);
}
