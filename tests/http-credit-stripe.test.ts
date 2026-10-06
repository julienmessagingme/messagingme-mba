import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import { creerPayeurAutorise, type CreditPaiementRouteDeps, type StripeWebhookRouteDeps } from '../src/http/credit-stripe';
import type { ReponseStripe, TransportStripe } from '../src/stripe/client';
import type { IssuePaiement, PaiementStripe } from '../src/stripe/store.pg';

/**
 * RECHARGER LE CRÉDIT PAR STRIPE : la route qui ouvre un paiement, et le webhook qui crédite.
 *
 * 🔴 CE QUI SE JOUE ICI EST DE L'ARGENT ENCAISSÉ. Un webhook rejoué qui crédite deux fois, une métadonnée qui ne
 * correspond pas au prix payé, un événement forgé : aucun ne lève d'exception, tous donnent du crédit à tort. Aucun
 * appel ne part chez Stripe (transport simulé), aucune vraie clé n'existe ici.
 */
const SECRET_SESSION = 'test-secret';
const SECRET_WEBHOOK = randomBytes(24).toString('hex');
const CLE = ['rk', 'live', randomBytes(12).toString('hex')].join('_');
const T1 = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const NOW = 1_790_000_000_000;

let admin = '';
let membre = '';
beforeAll(async () => {
  admin = await signSession({ userId: 'u1', tenantId: T1, role: 'admin' }, SECRET_SESSION);
  membre = await signSession({ userId: 'u2', tenantId: T1, role: 'agent' }, SECRET_SESSION);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (jeton: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` } });

/** Les prix tels que Stripe les rend : ceux de la configuration valent le HT de leur offre, en euros. */
const PRIX_JUSTES: Record<string, ReponseStripe> = {
  price_50: { status: 200, json: { id: 'price_50', unit_amount: 5_000, currency: 'eur' } },
  price_100: { status: 200, json: { id: 'price_100', unit_amount: 10_000, currency: 'eur' } },
};

class FauxStripe implements TransportStripe {
  readonly appels: Array<{ url: string; corps: URLSearchParams; entetes: Record<string, string> }> = [];
  readonly lectures: string[] = [];
  constructor(private readonly reponses: ReponseStripe[], private readonly prix: Record<string, ReponseStripe> = PRIX_JUSTES) {}
  async post(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    this.appels.push({ url, corps: new URLSearchParams(corps), entetes });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    return r;
  }
  async get(url: string): Promise<ReponseStripe> {
    this.lectures.push(url);
    const r = this.prix[url.slice(url.lastIndexOf('/') + 1)];
    if (!r) throw new Error('lecture non prévue');
    return r;
  }
}

const CLIENT_OK: ReponseStripe = { status: 200, json: { id: 'cus_A' } };
const SESSION_OK: ReponseStripe = { status: 200, json: { id: 'cs_live_1', url: 'https://checkout.stripe.com/c/pay/cs_live_1' } };

function paiement(o: {
  stripe?: CreditPaiementRouteDeps['stripe'] | 'aucun';
  reponses?: ReponseStripe[];
  prix?: Record<string, ReponseStripe>;
  clientConnu?: string;
  payeur?: boolean;
  /** Les paiements connus, par « espace:session » : ce que `stripe_paiements` rendrait POUR CET ESPACE. */
  paiements?: Record<string, { factureId: string | null }>;
} = {}) {
  const transport = new FauxStripe(o.reponses ?? [CLIENT_OK, SESSION_OK], o.prix);
  const retenus: Array<{ tenantId: string; livemode: boolean; customerId: string }> = [];
  const factureDemandee: Array<{ tenantId: string; sessionId: string }> = [];
  let connu = o.clientConnu ?? null;
  const deps: CreditPaiementRouteDeps = {
    stripe: o.stripe === 'aucun' ? null : o.stripe ?? {
      cle: CLE, livemode: true,
      prix: { refill_50: 'price_50', refill_100: 'price_100' },
      transport,
      pageCredit: 'https://console.exemple/parametres/credit',
    },
    clients: {
      clientDe: async () => connu,
      retenirClient: async (tenantId, livemode, customerId) => { retenus.push({ tenantId, livemode, customerId }); connu = customerId; return customerId; },
    },
    payeurAutorise: async () => o.payeur ?? true,
    factures: {
      factureDe: async (tenantId, sessionId) => {
        factureDemandee.push({ tenantId, sessionId });
        return o.paiements?.[`${tenantId}:${sessionId}`] ?? null;
      },
    },
  };
  const srv = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET_SESSION }, creditPaiement: deps });
  return { srv, transport, retenus, factureDemandee };
}

const payer = (srv: ReturnType<typeof buildServer>, corps: unknown, jeton = admin, tenant = T1) =>
  srv.inject({ method: 'POST', url: `/tenants/${tenant}/credit/paiement`, ...h(jeton), payload: JSON.stringify(corps) });

describe('POST /tenants/:tenantId/credit/paiement', () => {
  it('ouvre une session et rend son adresse ; le client Stripe de l’espace est créé puis RETENU', async () => {
    const p = paiement();
    const r = await payer(p.srv, { offre: 'refill_50' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_live_1' });
    expect(p.retenus).toEqual([{ tenantId: T1, livemode: true, customerId: 'cus_A' }]);
    const session = p.transport.appels[1]!;
    expect(session.corps.get('line_items[0][price]')).toBe('price_50');
    expect(session.corps.get('customer')).toBe('cus_A');
    // Le retour se fait sur la page Crédit IA de la console, et ne crédite rien.
    expect(session.corps.get('success_url')).toBe('https://console.exemple/parametres/credit?paiement=recu');
    expect(session.corps.get('cancel_url')).toBe('https://console.exemple/parametres/credit?paiement=abandon');
    await p.srv.close();
  });

  it('un espace qui a déjà son client Stripe le RÉUTILISE : aucune création', async () => {
    const p = paiement({ clientConnu: 'cus_DEJA', reponses: [SESSION_OK] });
    expect((await payer(p.srv, { offre: 'refill_100' })).statusCode).toBe(200);
    expect(p.transport.appels).toHaveLength(1);
    expect(p.transport.appels[0]!.corps.get('customer')).toBe('cus_DEJA');
    expect(p.transport.appels[0]!.corps.get('line_items[0][price]')).toBe('price_100');
    await p.srv.close();
  });

  it('🔴 le corps ne choisit qu’une OFFRE, jamais un montant ni un prix', async () => {
    const p = paiement();
    expect((await payer(p.srv, { offre: 'refill_1000' })).statusCode).toBe(400);
    expect((await payer(p.srv, { montant: 5000 })).statusCode).toBe(400);
    expect((await payer(p.srv, { offre: 'refill_50', prix: 'price_pirate' })).statusCode).toBe(200);
    expect(p.transport.appels.find((a) => a.url.endsWith('/checkout/sessions'))!.corps.get('line_items[0][price]')).toBe('price_50');
    await p.srv.close();
  });

  it('🔴 Stripe pas configuré, ou offre sans prix : 503 « recharge pas encore disponible », rien n’est appelé', async () => {
    const p = paiement({ stripe: 'aucun' });
    const r = await payer(p.srv, { offre: 'refill_50' });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: 'recharge_indisponible' });
    await p.srv.close();

    const transport = new FauxStripe([]);
    const q = paiement({ stripe: { cle: CLE, livemode: true, prix: { refill_50: '', refill_100: 'price_100' }, transport, pageCredit: 'https://x' } });
    expect((await payer(q.srv, { offre: 'refill_50' })).statusCode).toBe(503);
    expect(transport.appels).toHaveLength(0);
    await q.srv.close();
  });

  it('🔴 un compte que la route refuse comme payeur (mode test, pas exploitant) : 503, rien n’est créé chez Stripe', async () => {
    const p = paiement({ payeur: false });
    expect((await payer(p.srv, { offre: 'refill_50' })).statusCode).toBe(503);
    expect(p.transport.appels).toHaveLength(0);
    await p.srv.close();
  });

  it('🔴 une erreur de Stripe rend un 4xx lisible, jamais un 5xx, et son message reste au journal', async () => {
    const p = paiement({ reponses: [CLIENT_OK, { status: 400, json: { error: { type: 'invalid_request_error', message: 'Stripe Tax has not been activated on your account.' } } }] });
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await payer(p.srv, { offre: 'refill_50' });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ code: 'paiement_impossible' });
      expect(r.body).not.toContain('Stripe Tax');
      expect(erreurs.mock.calls.flat().join(' ')).toContain('stripe_paiement_impossible');
    } finally {
      erreurs.mockRestore();
    }
    await p.srv.close();
  });

  it('🔴 la session désactive l’Adaptive Pricing : le client paie en euros, que le webhook sait créditer', async () => {
    const p = paiement();
    expect((await payer(p.srv, { offre: 'refill_50' })).statusCode).toBe(200);
    expect(p.transport.appels.find((a) => a.url.endsWith('/checkout/sessions'))!.corps.get('adaptive_pricing[enabled]')).toBe('false');
    await p.srv.close();
  });

  it('🔴 le prix configuré est relu chez Stripe AVANT tout : celui de L’OFFRE demandée', async () => {
    const p = paiement({ clientConnu: 'cus_DEJA', reponses: [SESSION_OK] });
    expect((await payer(p.srv, { offre: 'refill_100' })).statusCode).toBe(200);
    expect(p.transport.lectures).toEqual(['https://api.stripe.com/v1/prices/price_100']);
    await p.srv.close();
  });

  it('🔴 un prix qui ne vaut pas le HT de l’offre, ou pas en euros : 422 lisible, RIEN n’est créé chez Stripe', async () => {
    // Le défaut relevé le 2026-09-29 : un prix mal configuré laissait payer, puis le webhook refusait de créditer.
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const faux of [
        { ...PRIX_JUSTES, price_50: { status: 200, json: { id: 'price_50', unit_amount: 10_000, currency: 'eur' } } }, // interverti
        { ...PRIX_JUSTES, price_50: { status: 200, json: { id: 'price_50', unit_amount: 5_000, currency: 'usd' } } }, // devise
        { ...PRIX_JUSTES, price_50: { status: 200, json: { id: 'price_50', unit_amount: null, currency: 'eur' } } }, // sans montant
      ]) {
        const p = paiement({ prix: faux });
        const r = await payer(p.srv, { offre: 'refill_50' });
        expect(r.statusCode).toBe(422);
        expect(r.json()).toMatchObject({ code: 'prix_incoherent' });
        expect(p.transport.appels).toHaveLength(0);
        await p.srv.close();
      }
      expect(erreurs.mock.calls.flat().join(' ').match(/stripe_prix_incoherent/g)).toHaveLength(3);
    } finally {
      erreurs.mockRestore();
    }
  });

  it('un prix illisible chez Stripe (archivé, clé sans droit de lecture) : 422 comme toute erreur de Stripe', async () => {
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = paiement({ prix: { price_50: { status: 403, json: { error: { type: 'invalid_request_error', message: 'restricted key' } } } } });
      const r = await payer(p.srv, { offre: 'refill_50' });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ code: 'paiement_impossible' });
      expect(p.transport.appels).toHaveLength(0);
      await p.srv.close();
    } finally {
      erreurs.mockRestore();
    }
  });

  it('🔴 l’espace d’un AUTRE : 403, et rien ne part chez Stripe', async () => {
    const p = paiement();
    const r = await payer(p.srv, { offre: 'refill_50' }, admin, '11111111-1111-4111-8111-111111111111');
    expect(r.statusCode).toBe(403);
    expect(p.transport.appels).toHaveLength(0);
    await p.srv.close();
  });

  it('🔴 un MEMBRE non admin : 403, et rien ne part chez Stripe', async () => {
    const p = paiement();
    expect((await payer(p.srv, { offre: 'refill_50' }, membre)).statusCode).toBe(403);
    expect(p.transport.appels).toHaveLength(0);
    await p.srv.close();
  });
});

/**
 * LA FACTURE D'UN ACHAT (décision de Julien du 2026-09-29) : l'adresse de sa page hébergée chez Stripe, relue par la
 * clé restreinte. 🔴 Le paiement se relit DANS L'ESPACE : un identifiant de session d'un autre espace ne mène à rien.
 */
describe('GET /tenants/:tenantId/credit/factures/:sessionId', () => {
  const FACTURE_OK: ReponseStripe = { status: 200, json: { id: 'in_1', hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/in_1' } };
  const lire = (srv: ReturnType<typeof buildServer>, session: string, jeton = admin, tenant = T1) =>
    srv.inject({ method: 'GET', url: `/tenants/${tenant}/credit/factures/${session}`, ...h(jeton) });

  it('🔴 un achat de l’espace avec facture : l’adresse de la page hébergée, lue chez Stripe par SA facture', async () => {
    const p = paiement({ paiements: { [`${T1}:cs_live_1`]: { factureId: 'in_1' } }, prix: { in_1: FACTURE_OK } });
    const r = await lire(p.srv, 'cs_live_1');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ url: 'https://invoice.stripe.com/i/acct_x/in_1' });
    expect(p.factureDemandee).toEqual([{ tenantId: T1, sessionId: 'cs_live_1' }]);
    expect(p.transport.lectures).toEqual(['https://api.stripe.com/v1/invoices/in_1']);
    await p.srv.close();
  });

  it('🔴 le paiement d’un AUTRE espace : 404, et Stripe n’est pas appelé', async () => {
    // Le paiement existe, mais dans un autre espace : le dépôt, qui filtre sur l'espace, ne le rend pas ici.
    const AUTRE = '11111111-1111-4111-8111-111111111111';
    const p = paiement({ paiements: { [`${AUTRE}:cs_live_9`]: { factureId: 'in_9' } }, prix: { in_9: FACTURE_OK } });
    const r = await lire(p.srv, 'cs_live_9');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: 'paiement_inconnu' });
    expect(p.factureDemandee).toEqual([{ tenantId: T1, sessionId: 'cs_live_9' }]);
    expect(p.transport.lectures).toEqual([]);
    // Et l'URL d'un autre espace est refusée par la garde, avant tout.
    expect((await lire(p.srv, 'cs_live_9', admin, AUTRE)).statusCode).toBe(403);
    await p.srv.close();
  });

  it('🔴 un paiement SANS facture : 404 lisible, sans appeler Stripe', async () => {
    const p = paiement({ paiements: { [`${T1}:cs_live_2`]: { factureId: null } } });
    const r = await lire(p.srv, 'cs_live_2');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: 'sans_facture' });
    expect(r.json<{ error: string }>().error).toMatch(/pas de facture/);
    expect(p.transport.lectures).toEqual([]);
    await p.srv.close();
  });

  it('🔴 une réponse de Stripe SANS `hosted_invoice_url` : 4xx lisible, jamais une adresse inventée', async () => {
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const reponse of [
        { status: 200, json: { id: 'in_1' } },
        { status: 200, json: { id: 'in_1', hosted_invoice_url: null } },
        { status: 200, json: { id: 'in_1', hosted_invoice_url: 'http://invoice.stripe.com/i/in_1' } }, // pas https
      ] satisfies ReponseStripe[]) {
        const p = paiement({ paiements: { [`${T1}:cs_live_1`]: { factureId: 'in_1' } }, prix: { in_1: reponse } });
        const r = await lire(p.srv, 'cs_live_1');
        expect(r.statusCode).toBeGreaterThanOrEqual(400);
        expect(r.statusCode).toBeLessThan(500);
        expect(r.json()).not.toHaveProperty('url');
        await p.srv.close();
      }
    } finally {
      erreurs.mockRestore();
    }
  });

  it('🔴 une erreur de Stripe (clé sans droit de lecture des factures) : 422 lisible, et son message reste au journal', async () => {
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const refus: ReponseStripe = { status: 403, json: { error: { type: 'invalid_request_error', message: 'The provided key does not have the required permissions (rak_invoice_read)' } } };
      const p = paiement({ paiements: { [`${T1}:cs_live_1`]: { factureId: 'in_1' } }, prix: { in_1: refus } });
      const r = await lire(p.srv, 'cs_live_1');
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ code: 'facture_impossible' });
      expect(r.body).not.toContain('rak_invoice_read');
      expect(erreurs.mock.calls.flat().join(' ')).toContain('stripe_facture_impossible');
      await p.srv.close();
    } finally {
      erreurs.mockRestore();
    }
  });

  it('Stripe pas configuré, ou compte refusé en mode test : la même règle que le paiement, rien n’est lu', async () => {
    const p = paiement({ stripe: 'aucun', paiements: { [`${T1}:cs_live_1`]: { factureId: 'in_1' } } });
    expect((await lire(p.srv, 'cs_live_1')).statusCode).toBe(503);
    expect(p.factureDemandee).toEqual([]);
    await p.srv.close();
    const q = paiement({ payeur: false, paiements: { [`${T1}:cs_live_1`]: { factureId: 'in_1' } }, prix: { in_1: FACTURE_OK } });
    expect((await lire(q.srv, 'cs_live_1')).statusCode).toBe(503);
    expect(q.transport.lectures).toEqual([]);
    await q.srv.close();
  });

  it('un MEMBRE non admin : 403 ; un identifiant qui n’est pas une session : 404 sans lecture', async () => {
    const p = paiement({ paiements: { [`${T1}:cs_live_1`]: { factureId: 'in_1' } }, prix: { in_1: FACTURE_OK } });
    expect((await lire(p.srv, 'cs_live_1', membre)).statusCode).toBe(403);
    expect((await lire(p.srv, 'in_1')).statusCode).toBe(404);
    expect(p.factureDemandee).toEqual([]);
    await p.srv.close();
  });
});

/**
 * QUI PEUT PAYER, SELON LE MODE DE LA CLÉ (relecture du 2026-09-29 : cette règle vivait dans le câblage, et
 * l'inverser ne faisait échouer aucun test). En test, une carte de test créditerait de vrais euros de modèle.
 */
describe('creerPayeurAutorise', () => {
  const lu: string[] = [];
  const payeur = (livemode: boolean) => creerPayeurAutorise({
    livemode,
    adresseDe: async (id) => { lu.push(id); return id === 'u-ops' ? 'julien@exemple.fr' : id === 'u-client' ? 'client@exemple.fr' : null; },
    estExploitant: (a) => a === 'julien@exemple.fr',
  });

  it('🔴 en LIVE, tout admin paie, sans même relire son adresse', async () => {
    lu.length = 0;
    expect(await payeur(true)('u-client')).toBe(true);
    expect(lu).toEqual([]);
  });

  it('🔴 en TEST, seul un exploitant paie ; un client, ou un compte introuvable, non', async () => {
    expect(await payeur(false)('u-ops')).toBe(true);
    expect(await payeur(false)('u-client')).toBe(false);
    expect(await payeur(false)('u-inconnu')).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------

/** Un faux dépôt de paiements qui tient l'idempotence comme la clé primaire de `stripe_paiements`. */
function fauxPaiements(o: { espaceInconnu?: boolean } = {}) {
  const sessions = new Set<string>();
  const credits: PaiementStripe[] = [];
  return {
    credits,
    crediterPaiement: async (p: PaiementStripe): Promise<IssuePaiement> => {
      if (o.espaceInconnu) return 'espace_inconnu';
      if (sessions.has(p.sessionId)) return 'deja';
      sessions.add(p.sessionId);
      credits.push(p);
      return 'credite';
    },
  };
}

function webhook(o: { paiements?: ReturnType<typeof fauxPaiements>; apresCredit?: StripeWebhookRouteDeps['apresCredit']; livemode?: boolean } = {}) {
  const paiements = o.paiements ?? fauxPaiements();
  const plafonds: string[] = [];
  const deps: StripeWebhookRouteDeps = {
    secret: SECRET_WEBHOOK,
    livemode: o.livemode ?? true,
    paiements,
    apresCredit: o.apresCredit ?? (async (tenantId) => { plafonds.push(tenantId); }),
    // 🔴 Une recharge ne touche jamais l'abonnement du numéro (lot 3c) : ses dépendances lèvent si on les appelle.
    numero: {
      enregistrer: async () => { throw new Error('une recharge a touché l’abonnement du numéro'); },
      majStatut: async () => { throw new Error('une recharge a touché l’abonnement du numéro'); },
      noterFinPrevue: async () => { throw new Error('une recharge a touché l’abonnement du numéro'); },
      reprendreCampagnes: async () => { throw new Error('une recharge a repris des campagnes'); },
      alerter: async () => { throw new Error('une recharge a prévenu Julien'); },
    },
    now: () => NOW,
  };
  const srv = buildServer({ queue: new FakeQueue(), stripeWebhook: deps });
  return { srv, paiements, plafonds };
}

function session(over: Record<string, unknown> = {}) {
  return {
    id: 'cs_live_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid',
    amount_subtotal: 5_000, amount_total: 6_000, currency: 'eur', client_reference_id: T1,
    metadata: { tenant_id: T1, offre: 'refill_50' }, invoice: 'in_1',
    ...over,
  };
}

function evenement(objet: unknown, type = 'checkout.session.completed') {
  return { id: `evt_${randomBytes(4).toString('hex')}`, object: 'event', type, livemode: true, data: { object: objet } };
}

/** Envoie un corps signé comme Stripe (ou une signature donnée). */
function envoyer(srv: ReturnType<typeof buildServer>, corps: unknown, o: { signature?: string | null; brut?: string } = {}) {
  const brut = o.brut ?? JSON.stringify(corps);
  const t = Math.floor(NOW / 1000);
  const sig = o.signature === undefined
    ? `t=${t},v1=${createHmac('sha256', SECRET_WEBHOOK).update(`${t}.${brut}`).digest('hex')}`
    : o.signature;
  return srv.inject({
    method: 'POST', url: '/webhooks/stripe',
    // L'en-tête exact de Stripe, paramètre de jeu de caractères compris : le parser JSON global doit le reconnaître.
    headers: { 'content-type': 'application/json; charset=utf-8', ...(sig === null ? {} : { 'stripe-signature': sig }) },
    payload: brut,
  });
}

describe('POST /webhooks/stripe', () => {
  it('🔴 un paiement réglé crédite l’offre, UNE fois, puis remonte le plafond de la clé', async () => {
    const w = webhook();
    const r = await envoyer(w.srv, evenement(session()));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ credite: true });
    expect(w.paiements.credits).toEqual([{
      sessionId: 'cs_live_1', tenantId: T1, offre: 'refill_50', creditMicroEur: 50_000_000,
      htCentimes: 5_000, ttcCentimes: 6_000, factureId: 'in_1', livemode: true,
    }]);
    expect(w.plafonds).toEqual([T1]);
    await w.srv.close();
  });

  it('🔴 un événement d’un AUTRE MODE que la clé ne crédite rien, et se trace (dans les deux sens)', async () => {
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Clé live, événement de test : une carte de test ne donne jamais de vrais euros de modèle.
      const w = webhook({ livemode: true });
      const test = { ...evenement(session()), livemode: false };
      const r = await envoyer(w.srv, test);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ credite: false });
      expect(w.paiements.credits).toEqual([]);
      expect(w.plafonds).toEqual([]);
      await w.srv.close();
      // Clé de test, événement réel : il ne se crédite pas sur une instance réglée en test.
      const v = webhook({ livemode: false });
      expect((await envoyer(v.srv, evenement(session()))).json()).toMatchObject({ credite: false });
      expect(v.paiements.credits).toEqual([]);
      await v.srv.close();
      expect(erreurs.mock.calls.flat().join(' ').match(/stripe_mode_incoherent/g)).toHaveLength(2);
      // Et le même mode crédite : la garde ne refuse pas tout.
      const m = webhook({ livemode: false });
      expect((await envoyer(m.srv, { ...evenement(session()), livemode: false })).json()).toMatchObject({ credite: true });
      await m.srv.close();
    } finally {
      erreurs.mockRestore();
    }
  });

  it('🔴 le MÊME événement livré deux fois (et un second événement de la même session) : un seul crédit', async () => {
    // Stripe renvoie couramment un événement ; le paiement différé réussi désigne la même session.
    const w = webhook();
    const ev = evenement(session());
    expect((await envoyer(w.srv, ev)).statusCode).toBe(200);
    const bis = await envoyer(w.srv, ev);
    expect(bis.statusCode).toBe(200);
    expect(bis.json()).toMatchObject({ credite: false });
    expect((await envoyer(w.srv, evenement(session(), 'checkout.session.async_payment_succeeded'))).statusCode).toBe(200);
    expect(w.paiements.credits).toHaveLength(1);
    expect(w.plafonds).toHaveLength(1);
    await w.srv.close();
  });

  it('🔴 une métadonnée qui ne correspond PAS au prix payé ne crédite rien, et se journalise en erreur', async () => {
    const w = webhook();
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // L'offre annonce 100 €, Stripe n'a encaissé que 50 € HT.
      const r = await envoyer(w.srv, evenement(session({ metadata: { tenant_id: T1, offre: 'refill_100' } })));
      expect(r.statusCode).toBe(200);
      // Une autre devise, et une référence qui désigne un autre espace : même refus.
      await envoyer(w.srv, evenement(session({ id: 'cs_2', currency: 'usd' })));
      await envoyer(w.srv, evenement(session({ id: 'cs_3', client_reference_id: '11111111-1111-4111-8111-111111111111' })));
      expect(w.paiements.credits).toEqual([]);
      expect(erreurs.mock.calls.flat().join(' ').match(/stripe_paiement_incoherent/g)).toHaveLength(3);
    } finally {
      erreurs.mockRestore();
    }
    await w.srv.close();
  });

  it('🔴 une session NON PAYÉE ne crédite rien : on attend le paiement différé', async () => {
    const w = webhook();
    expect((await envoyer(w.srv, evenement(session({ payment_status: 'unpaid' })))).statusCode).toBe(200);
    expect(w.paiements.credits).toEqual([]);
    // Le paiement différé arrive : il crédite.
    expect((await envoyer(w.srv, evenement(session(), 'checkout.session.async_payment_succeeded'))).statusCode).toBe(200);
    expect(w.paiements.credits).toHaveLength(1);
    await w.srv.close();
  });

  it('🔴 un code promo à 100 % (aucun paiement requis) crédite le PLEIN de l’offre, une seule fois', async () => {
    // Décision de Julien du 2026-09-29 : le code est un geste commercial, il ne réduit pas le crédit. Stripe garde le
    // prix avant remise dans `amount_subtotal`, c'est lui que le recoupement compare.
    const w = webhook();
    const gratuite = session({ id: 'cs_promo', payment_status: 'no_payment_required', amount_total: 0 });
    expect((await envoyer(w.srv, evenement(gratuite))).statusCode).toBe(200);
    expect((await envoyer(w.srv, evenement(gratuite))).statusCode).toBe(200);
    expect(w.paiements.credits).toHaveLength(1);
    await w.srv.close();
  });

  it('🔴 signature FAUSSE ou ABSENTE : 401, et le corps n’est jamais lu', async () => {
    const w = webhook();
    const espion = vi.spyOn(w.paiements, 'crediterPaiement');
    const fausse = await envoyer(w.srv, evenement(session()), { signature: `t=${Math.floor(NOW / 1000)},v1=${randomBytes(32).toString('hex')}` });
    expect(fausse.statusCode).toBe(401);
    expect((await envoyer(w.srv, evenement(session()), { signature: null })).statusCode).toBe(401);
    // Un corps illisible, mal signé : refusé sur la signature, pas sur le corps.
    expect((await envoyer(w.srv, null, { brut: '{pas du json', signature: 't=1,v1=00' })).statusCode).toBe(401);
    expect(espion).not.toHaveBeenCalled();
    await w.srv.close();
  });

  it('une session SANS nos métadonnées : 200 sans effet (le compte vend peut-être autre chose)', async () => {
    const w = webhook();
    expect((await envoyer(w.srv, evenement(session({ metadata: {} })))).statusCode).toBe(200);
    expect((await envoyer(w.srv, evenement(session({ metadata: null })))).statusCode).toBe(200);
    expect((await envoyer(w.srv, evenement(session({ mode: 'subscription' })))).statusCode).toBe(200);
    expect(w.paiements.credits).toEqual([]);
    await w.srv.close();
  });

  it('tout autre événement : 200 sans effet', async () => {
    const w = webhook();
    expect((await envoyer(w.srv, evenement({ id: 'pi_1' }, 'payment_intent.succeeded'))).statusCode).toBe(200);
    expect(w.paiements.credits).toEqual([]);
    await w.srv.close();
  });

  it('🔴 un événement qui crédite mais qu’on ne sait pas lire : 422, donc rejoué par Stripe', async () => {
    const w = webhook();
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await envoyer(w.srv, evenement({ id: 'cs_x', mode: 'payment' }))).statusCode).toBe(422);
    } finally {
      erreurs.mockRestore();
    }
    expect(w.paiements.credits).toEqual([]);
    await w.srv.close();
  });

  it('un espace inconnu : 200 sans crédit (rejouer n’y changerait rien), et le plafond n’est pas touché', async () => {
    const w = webhook({ paiements: fauxPaiements({ espaceInconnu: true }) });
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await envoyer(w.srv, evenement(session()));
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ credite: false });
    } finally {
      erreurs.mockRestore();
    }
    expect(w.plafonds).toEqual([]);
    await w.srv.close();
  });

  it('🔴 un plafond Vercel qui ne remonte pas ne défait pas le crédit : 200', async () => {
    const w = webhook({ apresCredit: async () => { throw new Error('vercel indisponible'); } });
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await envoyer(w.srv, evenement(session()))).statusCode).toBe(200);
    } finally {
      erreurs.mockRestore();
    }
    expect(w.paiements.credits).toHaveLength(1);
    await w.srv.close();
  });

  it('une panne de base rend 5xx : Stripe rejouera', async () => {
    const w = webhook({ paiements: { credits: [], crediterPaiement: async () => { throw new Error('base indisponible'); } } as unknown as ReturnType<typeof fauxPaiements> });
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await envoyer(w.srv, evenement(session()))).statusCode).toBe(500);
    } finally {
      erreurs.mockRestore();
    }
    await w.srv.close();
  });
});
