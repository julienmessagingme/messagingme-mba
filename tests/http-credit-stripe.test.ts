import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { CreditPaiementRouteDeps, StripeWebhookRouteDeps } from '../src/http/credit-stripe';
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

class FauxStripe implements TransportStripe {
  readonly appels: Array<{ url: string; corps: URLSearchParams; entetes: Record<string, string> }> = [];
  constructor(private readonly reponses: ReponseStripe[]) {}
  async post(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    this.appels.push({ url, corps: new URLSearchParams(corps), entetes });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    return r;
  }
}

const CLIENT_OK: ReponseStripe = { status: 200, json: { id: 'cus_A' } };
const SESSION_OK: ReponseStripe = { status: 200, json: { id: 'cs_live_1', url: 'https://checkout.stripe.com/c/pay/cs_live_1' } };

function paiement(o: {
  stripe?: CreditPaiementRouteDeps['stripe'] | 'aucun';
  reponses?: ReponseStripe[];
  clientConnu?: string;
  payeur?: boolean;
} = {}) {
  const transport = new FauxStripe(o.reponses ?? [CLIENT_OK, SESSION_OK]);
  const retenus: Array<{ tenantId: string; livemode: boolean; customerId: string }> = [];
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
  };
  const srv = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET_SESSION }, creditPaiement: deps });
  return { srv, transport, retenus };
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

function webhook(o: { paiements?: ReturnType<typeof fauxPaiements>; apresCredit?: StripeWebhookRouteDeps['apresCredit'] } = {}) {
  const paiements = o.paiements ?? fauxPaiements();
  const plafonds: Array<{ tenantId: string; credit: number }> = [];
  const deps: StripeWebhookRouteDeps = {
    secret: SECRET_WEBHOOK,
    paiements,
    apresCredit: o.apresCredit ?? (async (tenantId, credit) => { plafonds.push({ tenantId, credit }); }),
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
    expect(w.plafonds).toEqual([{ tenantId: T1, credit: 50_000_000 }]);
    await w.srv.close();
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
