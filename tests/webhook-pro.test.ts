import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { StripeWebhookRouteDeps } from '../src/http/credit-stripe';
import type { AbonnementOffre, IssueEnregistrementPro, PeriodiciteOffre, RaisonFinOffre } from '../src/offres/abonnements-offre.pg';
import { stripeNumeroInerte } from './routes-inertes';

/**
 * LE WEBHOOK STRIPE ET LE PRO (lot 6, livraison B1, tâche 11). Les objets marqués `produit: pro` écrivent
 * `abonnements_offre` ; chaque écriture vide le cache de l'offre de la copie qui reçoit (vigilance 3 : l'espace qui vient
 * de payer est en Pro tout de suite ici, en moins de 30 s ailleurs). Un objet sans notre métadonnée est ignoré, un objet
 * illisible rend 422 (Stripe rejoue). Le numéro n'est jamais touché par un événement du Pro.
 */
const SECRET_WEBHOOK = randomBytes(24).toString('hex');
const T1 = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const NOW = 1_790_000_000_000;
const FIN = 1_792_600_000;

function ligne(abonnementId: string, over: Partial<AbonnementOffre> = {}): AbonnementOffre {
  return { abonnementId, tenantId: T1, periodicite: 'mois', livemode: true, statut: 'actif', periodeFin: null, finPrevueLe: null, finiLe: null, finRaison: null, ...over };
}

function monter(o: { connus?: string[]; issue?: IssueEnregistrementPro } = {}) {
  const cap = {
    enregistres: [] as Array<{ tenantId: string; abonnementId: string; periodicite: PeriodiciteOffre; livemode: boolean; periodeFin: Date | null }>,
    statuts: [] as Array<{ abonnementId: string; statut: string; periodeFin: Date | null; finEchouee: Date | null }>,
    modifs: [] as Array<{ abonnementId: string; finPrevueLe: Date | null; periodicite: PeriodiciteOffre | null }>,
    fins: [] as Array<{ abonnementId: string; raison: RaisonFinOffre; finiLe: Date }>,
    invalides: [] as string[],
    alertes: [] as string[],
    credits: 0,
  };
  const connus = new Set(o.connus ?? []);
  const deps: StripeWebhookRouteDeps = {
    secret: SECRET_WEBHOOK,
    livemode: true,
    paiements: { crediterPaiement: async () => { cap.credits += 1; return 'credite'; } },
    apresCredit: async () => {},
    numero: stripeNumeroInerte,
    pro: {
      enregistrer: async (a) => { cap.enregistres.push(a); const neuf = !connus.has(a.abonnementId); connus.add(a.abonnementId); return o.issue ?? { etat: 'enregistre', tenantId: T1, nouveau: neuf }; },
      majStatut: async (abonnementId, statut, periodeFin, finEchouee = null) => {
        cap.statuts.push({ abonnementId, statut, periodeFin, finEchouee });
        return connus.has(abonnementId) ? ligne(abonnementId, { statut }) : null;
      },
      modifier: async (abonnementId, m) => { cap.modifs.push({ abonnementId, ...m }); return connus.has(abonnementId) ? ligne(abonnementId, m.periodicite ? { periodicite: m.periodicite } : {}) : null; },
      finir: async (abonnementId, raison, finiLe) => { cap.fins.push({ abonnementId, raison, finiLe }); return connus.has(abonnementId) ? ligne(abonnementId, { statut: 'resilie', finiLe, finRaison: raison }) : null; },
      invalider: (t) => { cap.invalides.push(t); },
      alerter: async (texte) => { cap.alertes.push(texte); },
    },
    now: () => NOW,
  };
  return { srv: buildServer({ queue: new FakeQueue(), stripeWebhook: deps }), cap };
}

const evenement = (objet: unknown, type: string) => ({ id: `evt_${randomBytes(4).toString('hex')}`, object: 'event', type, livemode: true, data: { object: objet } });

function envoyer(srv: ReturnType<typeof buildServer>, corps: unknown) {
  const brut = JSON.stringify(corps);
  const t = Math.floor(NOW / 1000);
  const sig = `t=${t},v1=${createHmac('sha256', SECRET_WEBHOOK).update(`${t}.${brut}`).digest('hex')}`;
  return srv.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, payload: brut });
}

const META = { tenant_id: T1, produit: 'pro', periodicite: 'an' };
const sessionPro = (over: Record<string, unknown> = {}) => ({
  id: 'cs_live_pro', object: 'checkout.session', mode: 'subscription', payment_status: 'paid', subscription: 'sub_pro',
  amount_subtotal: 49000, amount_total: 58800, currency: 'eur', client_reference_id: T1, metadata: META, ...over,
});
const facturePro = (over: Record<string, unknown> = {}) => ({
  id: 'in_pro', object: 'invoice',
  parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_pro', metadata: META } },
  lines: { object: 'list', data: [{ id: 'il_1', period: { start: FIN - 31_536_000, end: FIN } }] },
  ...over,
});
const abonnementPro = (over: Record<string, unknown> = {}) => ({
  id: 'sub_pro', object: 'subscription', metadata: META,
  items: { data: [{ current_period_end: FIN, price: { recurring: { interval: 'year', interval_count: 1 } } }] }, ...over,
});

describe('le webhook Stripe et le Pro', () => {
  it('🔴 la session payée : l’espace passe en Pro, sa périodicité lue, le cache vidé, Julien prévenu, rien crédité', async () => {
    const { srv, cap } = monter();
    expect((await envoyer(srv, evenement(sessionPro(), 'checkout.session.completed'))).statusCode).toBe(200);
    expect(cap.enregistres).toEqual([{ tenantId: T1, abonnementId: 'sub_pro', periodicite: 'an', livemode: true, periodeFin: null }]);
    expect(cap.invalides).toEqual([T1]);
    expect(cap.alertes).toHaveLength(1);
    expect(cap.credits).toBe(0);
  });

  it('🔴 un code promo à 100 % (« no_payment_required ») fait aussi le Pro : c’est l’essai réel', async () => {
    const { srv, cap } = monter();
    await envoyer(srv, evenement(sessionPro({ payment_status: 'no_payment_required', amount_total: 0 }), 'checkout.session.completed'));
    expect(cap.enregistres).toHaveLength(1);
  });

  it('une session pas encore payée n’écrit rien ; rejouée, la session ne réalerte pas', async () => {
    const { srv, cap } = monter();
    await envoyer(srv, evenement(sessionPro({ payment_status: 'unpaid' }), 'checkout.session.completed'));
    expect(cap.enregistres).toEqual([]);
    await envoyer(srv, evenement(sessionPro(), 'checkout.session.completed'));
    await envoyer(srv, evenement(sessionPro(), 'checkout.session.completed'));
    expect(cap.alertes).toHaveLength(1);
  });

  it('🔴 la facture payée avant la session : le Pro s’enregistre depuis ses métadonnées, avec la fin de période', async () => {
    const { srv, cap } = monter();
    await envoyer(srv, evenement(facturePro(), 'invoice.paid'));
    expect(cap.statuts).toEqual([{ abonnementId: 'sub_pro', statut: 'actif', periodeFin: new Date(FIN * 1000), finEchouee: null }]);
    expect(cap.enregistres).toEqual([{ tenantId: T1, abonnementId: 'sub_pro', periodicite: 'an', livemode: true, periodeFin: new Date(FIN * 1000) }]);
    expect(cap.invalides).toEqual([T1]);
  });

  it('un renouvellement payé d’un Pro connu : la période avance, le cache est vidé', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'] });
    await envoyer(srv, evenement(facturePro(), 'invoice.paid'));
    expect(cap.enregistres).toEqual([]);
    expect(cap.invalides).toEqual([T1]);
  });

  it('🔴 un échec : en retard avec la fin de la période facturée (un rejeu après paiement se refuse au magasin), Julien prévenu', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'] });
    await envoyer(srv, evenement(facturePro(), 'invoice.payment_failed'));
    expect(cap.statuts).toEqual([{ abonnementId: 'sub_pro', statut: 'en_retard', periodeFin: null, finEchouee: new Date(FIN * 1000) }]);
    expect(cap.alertes).toHaveLength(1);
  });

  it('🔴 la résiliation programmée et la périodicité changée au portail : notées, sans rien finir', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'] });
    await envoyer(srv, evenement(abonnementPro({ cancel_at_period_end: true }), 'customer.subscription.updated'));
    await envoyer(srv, evenement(abonnementPro({ cancel_at_period_end: false, items: { data: [{ current_period_end: FIN, price: { recurring: { interval: 'month', interval_count: 1 } } }] } }), 'customer.subscription.updated'));
    expect(cap.modifs).toEqual([
      { abonnementId: 'sub_pro', finPrevueLe: new Date(FIN * 1000), periodicite: 'an' },
      { abonnementId: 'sub_pro', finPrevueLe: null, periodicite: 'mois' },
    ]);
    expect(cap.fins).toEqual([]);
  });

  it('🔴 la fin : résiliation ou impayé selon la raison de Stripe, datée de sa fin, le cache vidé, Julien prévenu', async () => {
    const r1 = monter({ connus: ['sub_pro'] });
    await envoyer(r1.srv, evenement(abonnementPro({ ended_at: FIN, cancellation_details: { reason: 'cancellation_requested' } }), 'customer.subscription.deleted'));
    expect(r1.cap.fins).toEqual([{ abonnementId: 'sub_pro', raison: 'resiliation', finiLe: new Date(FIN * 1000) }]);
    expect(r1.cap.invalides).toEqual([T1]);
    expect(r1.cap.alertes).toHaveLength(1);
    const r2 = monter({ connus: ['sub_pro'] });
    await envoyer(r2.srv, evenement(abonnementPro({ ended_at: FIN, cancellation_details: { reason: 'payment_failed' } }), 'customer.subscription.deleted'));
    expect(r2.cap.fins).toEqual([{ abonnementId: 'sub_pro', raison: 'impaye', finiLe: new Date(FIN * 1000) }]);
    const r3 = monter({ connus: ['sub_pro'] });
    await envoyer(r3.srv, evenement(abonnementPro({ cancellation_details: null }), 'customer.subscription.deleted'));
    expect(r3.cap.fins).toEqual([{ abonnementId: 'sub_pro', raison: 'resiliation', finiLe: new Date(NOW) }]);
  });

  it('🔴 un abonnement sans notre métadonnée n’est pas le Pro : il va au chemin du numéro, jamais au Pro', async () => {
    const { srv, cap } = monter({ connus: ['sub_autre'] });
    await envoyer(srv, evenement(abonnementPro({ id: 'sub_autre', metadata: {} }), 'customer.subscription.updated'));
    await envoyer(srv, evenement(facturePro({ parent: { subscription_details: { subscription: 'sub_autre', metadata: { produit: 'autre' } } } }), 'invoice.paid'));
    expect([cap.enregistres, cap.modifs, cap.fins, cap.invalides]).toEqual([[], [], [], []]);
  });

  it('un Pro illisible (métadonnées pro mais forme fausse) : 422, Stripe rejoue', async () => {
    const { srv } = monter();
    const r = await envoyer(srv, evenement(sessionPro({ subscription: 42 }), 'checkout.session.completed'));
    expect(r.statusCode).toBe(422);
  });

  it('un doublon (l’espace a déjà un Pro vivant) : rien d’écrit, Julien prévenu pour annuler chez Stripe', async () => {
    const { srv, cap } = monter({ issue: { etat: 'doublon' } });
    await envoyer(srv, evenement(sessionPro(), 'checkout.session.completed'));
    expect(cap.invalides).toEqual([]);
    expect(cap.alertes.join(' ')).toMatch(/double/i);
  });
});
