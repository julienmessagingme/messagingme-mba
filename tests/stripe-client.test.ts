import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  arreterAbonnementNumeroSeul, creerAbonnementNumeroSeul, creerClientStripe, creerSessionAbonnement, creerSessionCheckout, creerSessionPortail, estCleLive, lireFactureStripe, lirePrixStripe, StripeError, VERSION_API_STRIPE, type ReponseStripe, type TransportStripe,
} from '../src/stripe/client';
import { creditDeLOffre, definitionOffre, estOffreRecharge } from '../src/stripe/offres';

/**
 * LE CLIENT REST DE STRIPE, contre un transport simulé : aucun appel ne part chez Stripe, aucune vraie clé n'existe
 * ici (tirée au hasard, préfixe compris, pour que `gitleaks` n'ait rien à reconnaître).
 */
const CLE = ['rk', 'test', randomBytes(12).toString('hex')].join('_');
const TENANT = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';

class FauxTransport implements TransportStripe {
  readonly appels: Array<{ url: string; corps: URLSearchParams; entetes: Record<string, string>; methode?: 'DELETE' }> = [];
  constructor(private readonly reponses: Array<ReponseStripe | Error>) {}
  async delete(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    this.appels.push({ url, corps: new URLSearchParams(corps), entetes, methode: 'DELETE' });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    if (r instanceof Error) throw r;
    return r;
  }
  async post(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    this.appels.push({ url, corps: new URLSearchParams(corps), entetes });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    if (r instanceof Error) throw r;
    return r;
  }
  async get(url: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    this.appels.push({ url, corps: new URLSearchParams(), entetes });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    if (r instanceof Error) throw r;
    return r;
  }
}

const SESSION_OK = { status: 200, json: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' } };

function demande(over: Partial<Parameters<typeof creerSessionCheckout>[1]> = {}) {
  return {
    cle: CLE, tenantId: TENANT, offre: 'refill_50', prix: 'price_refill_50', customerId: 'cus_A',
    urlSucces: 'https://console.exemple/parametres/credit?paiement=recu',
    urlAbandon: 'https://console.exemple/parametres/credit?paiement=abandon',
    idempotence: 'session-cle-1',
    ...over,
  };
}

describe('créer une session Checkout', () => {
  it('🔴 le corps porte la taxe automatique, le numéro de TVA, l’adresse, la facture et NOS métadonnées', async () => {
    const t = new FauxTransport([SESSION_OK]);
    const r = await creerSessionCheckout(t, demande());
    expect(r).toEqual({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });

    const a = t.appels[0]!;
    expect(a.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(Object.fromEntries(a.corps)).toEqual({
      mode: 'payment',
      customer: 'cus_A',
      'line_items[0][price]': 'price_refill_50',
      'line_items[0][quantity]': '1',
      'adaptive_pricing[enabled]': 'false',
      'automatic_tax[enabled]': 'true',
      'tax_id_collection[enabled]': 'true',
      'customer_update[name]': 'auto',
      'customer_update[address]': 'auto',
      billing_address_collection: 'required',
      'invoice_creation[enabled]': 'true',
      allow_promotion_codes: 'true',
      'metadata[tenant_id]': TENANT,
      'metadata[offre]': 'refill_50',
      client_reference_id: TENANT,
      success_url: 'https://console.exemple/parametres/credit?paiement=recu',
      cancel_url: 'https://console.exemple/parametres/credit?paiement=abandon',
    });
  });

  it('🔴 version d’API épinglée, clé en Bearer, clé d’idempotence du geste', async () => {
    const t = new FauxTransport([SESSION_OK]);
    await creerSessionCheckout(t, demande());
    expect(t.appels[0]!.entetes).toEqual({
      authorization: `Bearer ${CLE}`,
      'stripe-version': VERSION_API_STRIPE,
      'idempotency-key': 'session-cle-1',
    });
    expect(VERSION_API_STRIPE).toBe('2025-11-17.clover');
  });

  it('🔴 une erreur de Stripe lève une StripeError avec son type et son code, JAMAIS la clé', async () => {
    const t = new FauxTransport([{ status: 400, json: { error: { type: 'invalid_request_error', code: 'tax_not_active', message: 'Stripe Tax is not active' } } }]);
    const err = await creerSessionCheckout(t, demande()).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(err).toMatchObject({ operation: 'session', status: 400, type: 'invalid_request_error', code: 'tax_not_active' });
    expect(String((err as Error).message)).not.toContain(CLE);
  });

  it('une panne réseau lève aussi, avec un statut nul', async () => {
    const t = new FauxTransport([new Error('ECONNRESET')]);
    await expect(creerSessionCheckout(t, demande())).rejects.toMatchObject({ name: 'StripeError', status: null });
  });

  it('🔴 un 200 au corps illisible échoue au lieu de deviner une adresse', async () => {
    const t = new FauxTransport([{ status: 200, json: { id: 'cs_x' } }]);
    await expect(creerSessionCheckout(t, demande())).rejects.toBeInstanceOf(StripeError);
  });
});

describe('lire un prix', () => {
  it('🔴 un GET sur le prix, clé en Bearer, version épinglée, SANS clé d’idempotence (une lecture ne crée rien)', async () => {
    const t = new FauxTransport([{ status: 200, json: { id: 'price_refill_50', unit_amount: 5_000, currency: 'eur', active: true } }]);
    expect(await lirePrixStripe(t, { cle: CLE, prix: 'price_refill_50' })).toEqual({ montantCentimes: 5_000, devise: 'eur', recurrence: null });
    expect(t.appels[0]!.url).toBe('https://api.stripe.com/v1/prices/price_refill_50');
    expect(t.appels[0]!.entetes).toEqual({ authorization: `Bearer ${CLE}`, 'stripe-version': VERSION_API_STRIPE });
  });

  it('un prix sans montant unitaire se lit `null` ; un corps illisible, ou un refus, lève', async () => {
    const t = new FauxTransport([
      { status: 200, json: { id: 'price_x', unit_amount: null, currency: 'eur' } },
      { status: 200, json: { id: 'pas_un_prix' } },
      { status: 404, json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such price' } } },
    ]);
    expect(await lirePrixStripe(t, { cle: CLE, prix: 'price_x' })).toEqual({ montantCentimes: null, devise: 'eur', recurrence: null });
    await expect(lirePrixStripe(t, { cle: CLE, prix: 'price_x' })).rejects.toBeInstanceOf(StripeError);
    await expect(lirePrixStripe(t, { cle: CLE, prix: 'price_x' })).rejects.toMatchObject({ operation: 'prix', status: 404, code: 'resource_missing' });
  });
});

describe('lire une facture', () => {
  it('🔴 un GET sur la facture, clé en Bearer, version épinglée ; l’adresse de sa page hébergée', async () => {
    const t = new FauxTransport([{ status: 200, json: { id: 'in_1', hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/in_1', status: 'paid' } }]);
    expect(await lireFactureStripe(t, { cle: CLE, facture: 'in_1' })).toEqual({ url: 'https://invoice.stripe.com/i/acct_x/in_1' });
    expect(t.appels[0]!.url).toBe('https://api.stripe.com/v1/invoices/in_1');
    expect(t.appels[0]!.entetes).toEqual({ authorization: `Bearer ${CLE}`, 'stripe-version': VERSION_API_STRIPE });
  });

  it('🔴 sans page hébergée : `null`, jamais une adresse inventée ; une adresse non https est illisible', async () => {
    const t = new FauxTransport([
      { status: 200, json: { id: 'in_1' } },
      { status: 200, json: { id: 'in_1', hosted_invoice_url: null } },
      { status: 200, json: { id: 'in_1', hosted_invoice_url: 'http://invoice.stripe.com/i/in_1' } },
    ]);
    expect(await lireFactureStripe(t, { cle: CLE, facture: 'in_1' })).toEqual({ url: null });
    expect(await lireFactureStripe(t, { cle: CLE, facture: 'in_1' })).toEqual({ url: null });
    await expect(lireFactureStripe(t, { cle: CLE, facture: 'in_1' })).rejects.toMatchObject({ name: 'StripeError', operation: 'facture' });
  });
});

describe('créer le client Stripe d’un espace', () => {
  it('🔴 la clé d’idempotence est `client-<espace>` : deux admins qui cliquent ensemble ont le même client', async () => {
    const t = new FauxTransport([{ status: 200, json: { id: 'cus_A' } }, { status: 200, json: { id: 'cus_A' } }]);
    expect(await creerClientStripe(t, { cle: CLE, tenantId: TENANT })).toBe('cus_A');
    await creerClientStripe(t, { cle: CLE, tenantId: TENANT });
    expect(t.appels.map((a) => a.entetes['idempotency-key'])).toEqual([`client-${TENANT}`, `client-${TENANT}`]);
    // Les mêmes paramètres à chaque fois : Stripe refuse une clé d'idempotence réutilisée avec d'autres.
    expect(t.appels.map((a) => a.corps.toString())).toEqual([t.appels[0]!.corps.toString(), t.appels[0]!.corps.toString()]);
    expect(Object.fromEntries(t.appels[0]!.corps)).toEqual({ 'metadata[tenant_id]': TENANT });
    expect(t.appels[0]!.url).toBe('https://api.stripe.com/v1/customers');
  });
});

describe('les offres et le mode de la clé', () => {
  it('🔴 le crédit se DÉRIVE du prix HT : 50 € HT donnent 50 € de crédit, 100 € en donnent 100', () => {
    expect(definitionOffre('refill_50').htCentimes).toBe(5_000);
    expect(creditDeLOffre('refill_50')).toBe(50_000_000);
    expect(definitionOffre('refill_100').htCentimes).toBe(10_000);
    expect(creditDeLOffre('refill_100')).toBe(100_000_000);
  });

  it('seules nos deux offres existent', () => {
    expect(estOffreRecharge('refill_50')).toBe(true);
    expect(estOffreRecharge('refill_1000')).toBe(false);
    expect(estOffreRecharge(50)).toBe(false);
  });

  it('le mode se lit sur le préfixe de la clé', () => {
    expect(estCleLive(['sk', 'live', 'x'].join('_'))).toBe(true);
    expect(estCleLive(['rk', 'live', 'x'].join('_'))).toBe(true);
    expect(estCleLive(CLE)).toBe(false);
  });
});

describe('l’abonnement du numéro fourni (lot 3c, livraison B)', () => {
  const ABONNEMENT_OK = { status: 200, json: { id: 'cs_test_2', url: 'https://checkout.stripe.com/c/pay/cs_test_2' } };
  const demandeAbonnement = {
    cle: CLE, tenantId: TENANT, prix: 'price_numero', customerId: 'cus_A',
    urlSucces: 'https://console.exemple/brancher?abonnement=recu', urlAbandon: 'https://console.exemple/brancher?abonnement=abandon',
    idempotence: 'abonnement-cle-1', produit: 'numero' as const,
  };

  it('🔴 un prix récurrent se lit avec sa récurrence', async () => {
    const t = new FauxTransport([{ status: 200, json: { id: 'price_numero', unit_amount: 350, currency: 'eur', type: 'recurring', recurring: { interval: 'month', interval_count: 1 } } }]);
    expect(await lirePrixStripe(t, { cle: CLE, prix: 'price_numero' })).toEqual({ montantCentimes: 350, devise: 'eur', recurrence: { intervalle: 'month', nombre: 1 } });
  });

  it('🔴 la session d’abonnement : mode subscription, taxe et TVA, NOS métadonnées sur la session ET l’abonnement, sans facture à part', async () => {
    const t = new FauxTransport([ABONNEMENT_OK]);
    expect(await creerSessionAbonnement(t, demandeAbonnement)).toEqual({ id: 'cs_test_2', url: 'https://checkout.stripe.com/c/pay/cs_test_2' });
    const a = t.appels[0]!;
    expect(a.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(a.entetes['idempotency-key']).toBe('abonnement-cle-1');
    expect(Object.fromEntries(a.corps)).toEqual({
      mode: 'subscription',
      customer: 'cus_A',
      'line_items[0][price]': 'price_numero',
      'line_items[0][quantity]': '1',
      'adaptive_pricing[enabled]': 'false',
      'automatic_tax[enabled]': 'true',
      'tax_id_collection[enabled]': 'true',
      'customer_update[name]': 'auto',
      'customer_update[address]': 'auto',
      billing_address_collection: 'required',
      'metadata[tenant_id]': TENANT,
      'metadata[produit]': 'numero',
      'subscription_data[metadata][tenant_id]': TENANT,
      'subscription_data[metadata][produit]': 'numero',
      client_reference_id: TENANT,
      success_url: 'https://console.exemple/brancher?abonnement=recu',
      cancel_url: 'https://console.exemple/brancher?abonnement=abandon',
    });
    // Une facture est émise par l'abonnement lui-même : `invoice_creation` est refusé par Stripe en mode abonnement.
    expect(a.corps.has('invoice_creation[enabled]')).toBe(false);
    // Le numéro n'a pas de code promo : rien n'a été décidé pour lui.
    expect(a.corps.has('allow_promotion_codes')).toBe(false);
  });

  it('🔴 la session du Pro (lot 6, B1) : produit pro et sa périodicité, sur la session ET l’abonnement, code promo ouvert', async () => {
    const t = new FauxTransport([ABONNEMENT_OK]);
    await creerSessionAbonnement(t, { ...demandeAbonnement, prix: 'price_pro_an', produit: 'pro', periodicite: 'an' });
    const c = Object.fromEntries(t.appels[0]!.corps);
    expect(c).toMatchObject({
      mode: 'subscription', 'line_items[0][price]': 'price_pro_an', 'metadata[produit]': 'pro', 'metadata[periodicite]': 'an',
      'subscription_data[metadata][produit]': 'pro', 'subscription_data[metadata][periodicite]': 'an',
      'subscription_data[metadata][tenant_id]': TENANT, allow_promotion_codes: 'true', 'automatic_tax[enabled]': 'true',
    });
  });

  it('le portail client : une session sur le client de l’espace, avec l’adresse de retour', async () => {
    const t = new FauxTransport([{ status: 200, json: { id: 'bps_1', url: 'https://billing.stripe.com/p/session/x' } }]);
    expect(await creerSessionPortail(t, { cle: CLE, customerId: 'cus_A', urlRetour: 'https://console.exemple/brancher' }))
      .toEqual({ url: 'https://billing.stripe.com/p/session/x' });
    expect(t.appels[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(Object.fromEntries(t.appels[0]!.corps)).toEqual({ customer: 'cus_A', return_url: 'https://console.exemple/brancher' });
    const refus = new FauxTransport([{ status: 403, json: { error: { type: 'invalid_request_error', message: 'restricted key' } } }]);
    await expect(creerSessionPortail(refus, { cle: CLE, customerId: 'cus_A', urlRetour: 'https://x' })).rejects.toMatchObject({ operation: 'portail', status: 403 });
  });
});

describe('le numéro inclus dans le Pro (lot 6, B2b)', () => {
  it('🔴 arrêter le numéro seul au passage en Pro : DELETE, avec l’avoir au prorata facturé tout de suite', async () => {
    const t = new FauxTransport([{ status: 200, json: { id: 'sub_N', status: 'canceled' } }]);
    await arreterAbonnementNumeroSeul(t, { cle: CLE, abonnementId: 'sub_N', avoir: true });
    expect(t.appels[0]!.methode).toBe('DELETE');
    expect(t.appels[0]!.url).toBe('https://api.stripe.com/v1/subscriptions/sub_N');
    // Le crédit du temps non utilisé (prorate) sur une facture finale émise tout de suite (invoice_now) : négative, elle
    // crédite le solde du client, que la facture suivante (le Pro) consomme.
    expect(Object.fromEntries(t.appels[0]!.corps)).toEqual({ prorate: 'true', invoice_now: 'true' });
    expect(t.appels[0]!.entetes['idempotency-key']).toBe('avoir-sub_N');
    expect(t.appels[0]!.entetes['stripe-version']).toBe(VERSION_API_STRIPE);
  });

  it('🔴 J7 : sans avoir (une période impayée), un arrêt nu, sous une autre clé d’idempotence', async () => {
    const t = new FauxTransport([{ status: 200, json: { id: 'sub_N', status: 'canceled' } }]);
    await arreterAbonnementNumeroSeul(t, { cle: CLE, abonnementId: 'sub_N', avoir: false });
    expect(t.appels[0]!.methode).toBe('DELETE');
    // Aucun crédit du temps restant d'une période jamais payée.
    expect(Object.fromEntries(t.appels[0]!.corps)).toEqual({});
    // Une autre clé : un rejeu qui changerait d'avis entre les deux ne se ferait pas refuser pour paramètres différents.
    expect(t.appels[0]!.entetes['idempotency-key']).toBe('arret-sub_N');
  });

  it('un arrêt qui ne rend pas CET abonnement annulé est un refus', async () => {
    await expect(arreterAbonnementNumeroSeul(new FauxTransport([{ status: 200, json: { id: 'sub_AUTRE', status: 'canceled' } }]), { cle: CLE, abonnementId: 'sub_N', avoir: true }))
      .rejects.toBeInstanceOf(StripeError);
    await expect(arreterAbonnementNumeroSeul(new FauxTransport([{ status: 200, json: { id: 'sub_N', status: 'active' } }]), { cle: CLE, abonnementId: 'sub_N', avoir: true }))
      .rejects.toBeInstanceOf(StripeError);
  });

  it('🔴 recréer le numéro seul à la fin du Pro : sur la carte du Pro, hors session, refusé net si le paiement échoue', async () => {
    const t = new FauxTransport([{ status: 200, json: { id: 'sub_M', status: 'active', items: { data: [{ current_period_end: 1_800_000_000 }] } } }]);
    expect(await creerAbonnementNumeroSeul(t, {
      cle: CLE, tenantId: TENANT, customerId: 'cus_A', prix: 'price_numero', carte: 'pm_PRO', idempotence: 'numero-apres-pro-sub_P',
    })).toEqual({ id: 'sub_M', periodeFin: new Date(1_800_000_000 * 1000) });
    expect(t.appels[0]!.url).toBe('https://api.stripe.com/v1/subscriptions');
    expect(Object.fromEntries(t.appels[0]!.corps)).toEqual({
      customer: 'cus_A', 'items[0][price]': 'price_numero', 'items[0][quantity]': '1', default_payment_method: 'pm_PRO',
      // 402 sans rien créer si le paiement échoue : le chemin de l'impayé (décision de Julien), jamais un abonnement incomplet.
      payment_behavior: 'error_if_incomplete', off_session: 'true', 'automatic_tax[enabled]': 'true',
      'metadata[tenant_id]': TENANT, 'metadata[produit]': 'numero',
    });
    expect(t.appels[0]!.entetes['idempotency-key']).toBe('numero-apres-pro-sub_P');
  });

  it('un paiement refusé rend un StripeError 402 ; un abonnement qui n’est pas actif est un refus', async () => {
    const refus = new FauxTransport([{ status: 402, json: { error: { type: 'card_error', code: 'card_declined', message: 'declined' } } }]);
    await expect(creerAbonnementNumeroSeul(refus, { cle: CLE, tenantId: TENANT, customerId: 'cus_A', prix: 'p', carte: 'pm', idempotence: 'i' }))
      .rejects.toMatchObject({ operation: 'abonnement', status: 402, code: 'card_declined' });
    const incomplet = new FauxTransport([{ status: 200, json: { id: 'sub_M', status: 'incomplete', items: { data: [] } } }]);
    await expect(creerAbonnementNumeroSeul(incomplet, { cle: CLE, tenantId: TENANT, customerId: 'cus_A', prix: 'p', carte: 'pm', idempotence: 'i' }))
      .rejects.toBeInstanceOf(StripeError);
  });
});
