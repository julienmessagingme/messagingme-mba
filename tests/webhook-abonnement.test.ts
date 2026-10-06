import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { StripeWebhookRouteDeps } from '../src/http/credit-stripe';
import type { AbonnementNumero, IssueEnregistrement, StatutAbonnement } from '../src/stripe/abonnements.pg';

/**
 * LE WEBHOOK STRIPE ET L'ABONNEMENT DU NUMÉRO (lot 3c, livraison B). Quatre événements : la session d'abonnement
 * payée enregistre l'abonnement ET attribue le numéro ; une facture payée le prolonge (ou l'enregistre si elle arrive
 * avant la session) ; un échec de paiement le met en retard ; une suppression le résilie. Rien n'est coupé avant le
 * lot 4 : Julien est prévenu. La recharge du crédit garde son chemin (`tests/http-credit-stripe.test.ts`).
 */
const SECRET_WEBHOOK = randomBytes(24).toString('hex');
const T1 = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const NOW = 1_790_000_000_000;
const FIN = 1_792_600_000;

function monter(o: { connus?: string[]; issue?: IssueEnregistrement; livemode?: boolean } = {}) {
  const cap = {
    enregistres: [] as Array<{ tenantId: string; abonnementId: string; livemode: boolean; periodeFin: Date | null }>,
    statuts: [] as Array<{ abonnementId: string; statut: StatutAbonnement; periodeFin: Date | null }>,
    alertes: [] as string[],
    credits: 0,
  };
  const connus = new Set(o.connus ?? []);
  const deps: StripeWebhookRouteDeps = {
    secret: SECRET_WEBHOOK,
    livemode: o.livemode ?? true,
    paiements: { crediterPaiement: async () => { cap.credits += 1; return 'credite'; } },
    apresCredit: async () => {},
    numero: {
      enregistrer: async (a) => { cap.enregistres.push(a); connus.add(a.abonnementId); return o.issue ?? { etat: 'enregistre', numero: '441235619343' }; },
      majStatut: async (abonnementId, statut, periodeFin): Promise<AbonnementNumero | null> => {
        cap.statuts.push({ abonnementId, statut, periodeFin });
        return connus.has(abonnementId) ? { abonnementId, tenantId: T1, livemode: true, statut, periodeFin } : null;
      },
      alerter: async (texte) => { cap.alertes.push(texte); },
    },
    now: () => NOW,
  };
  return { srv: buildServer({ queue: new FakeQueue(), stripeWebhook: deps }), cap };
}

const evenement = (objet: unknown, type: string, livemode = true) =>
  ({ id: `evt_${randomBytes(4).toString('hex')}`, object: 'event', type, livemode, data: { object: objet } });

function envoyer(srv: ReturnType<typeof buildServer>, corps: unknown) {
  const brut = JSON.stringify(corps);
  const t = Math.floor(NOW / 1000);
  const sig = `t=${t},v1=${createHmac('sha256', SECRET_WEBHOOK).update(`${t}.${brut}`).digest('hex')}`;
  return srv.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, payload: brut });
}

const sessionAbonnement = (over: Record<string, unknown> = {}) => ({
  id: 'cs_live_9', object: 'checkout.session', mode: 'subscription', payment_status: 'paid', subscription: 'sub_1',
  amount_subtotal: 350, amount_total: 420, currency: 'eur', client_reference_id: T1,
  metadata: { tenant_id: T1, produit: 'numero' }, ...over,
});
const facture = (over: Record<string, unknown> = {}) => ({
  id: 'in_9', object: 'invoice',
  parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: { tenant_id: T1, produit: 'numero' } } },
  lines: { object: 'list', data: [{ id: 'il_1', period: { start: FIN - 2_592_000, end: FIN } }] },
  ...over,
});

describe('le webhook Stripe et l’abonnement du numéro', () => {
  it('🔴 la session d’abonnement payée : l’abonnement est enregistré (et le numéro attribué), sans rien créditer', async () => {
    const { srv, cap } = monter();
    const r = await envoyer(srv, evenement(sessionAbonnement(), 'checkout.session.completed'));
    expect(r.statusCode).toBe(200);
    expect(cap.enregistres).toEqual([{ tenantId: T1, abonnementId: 'sub_1', livemode: true, periodeFin: null }]);
    expect(cap.credits).toBe(0);
    expect(cap.alertes).toEqual([]);
  });

  it('🔴 la réserve s’est vidée entre-temps : enregistré sans numéro, et Julien est prévenu', async () => {
    const { srv, cap } = monter({ issue: { etat: 'enregistre', numero: null } });
    await envoyer(srv, evenement(sessionAbonnement(), 'checkout.session.completed'));
    expect(cap.alertes).toHaveLength(1);
    expect(cap.alertes[0]).toMatch(/réserve/);
  });

  it('🔴 un second abonnement pour le même espace : rien n’est écrit, et Julien est prévenu pour l’annuler', async () => {
    const { srv, cap } = monter({ issue: { etat: 'doublon' } });
    await envoyer(srv, evenement(sessionAbonnement(), 'checkout.session.completed'));
    expect(cap.alertes).toHaveLength(1);
    expect(cap.alertes[0]).toMatch(/sub_1/);
  });

  it('une session pas encore payée, ou qui n’est pas la nôtre : rien', async () => {
    const { srv, cap } = monter();
    await envoyer(srv, evenement(sessionAbonnement({ payment_status: 'unpaid' }), 'checkout.session.completed'));
    await envoyer(srv, evenement(sessionAbonnement({ metadata: { autre: 'chose' } }), 'checkout.session.completed'));
    expect(cap.enregistres).toEqual([]);
  });

  it('🔴 une facture payée prolonge un abonnement connu jusqu’à la fin de sa période', async () => {
    const { srv, cap } = monter({ connus: ['sub_1'] });
    expect((await envoyer(srv, evenement(facture(), 'invoice.paid'))).statusCode).toBe(200);
    expect(cap.statuts).toEqual([{ abonnementId: 'sub_1', statut: 'actif', periodeFin: new Date(FIN * 1000) }]);
    expect(cap.enregistres).toEqual([]);
  });

  it('🔴 une facture payée arrivée AVANT la session : l’abonnement est enregistré depuis ses métadonnées', async () => {
    const { srv, cap } = monter();
    await envoyer(srv, evenement(facture(), 'invoice.paid'));
    expect(cap.enregistres).toEqual([{ tenantId: T1, abonnementId: 'sub_1', livemode: true, periodeFin: new Date(FIN * 1000) }]);
    // La session qui arrive ensuite enregistre le même abonnement : même état final, sans doublon.
    await envoyer(srv, evenement(sessionAbonnement(), 'checkout.session.completed'));
    expect(cap.enregistres.map((e) => e.abonnementId)).toEqual(['sub_1', 'sub_1']);
  });

  it('une facture qui n’est pas celle d’un de nos abonnements (une recharge, un autre produit) : rien', async () => {
    const { srv, cap } = monter();
    await envoyer(srv, evenement(facture({ parent: null }), 'invoice.paid'));
    await envoyer(srv, evenement(facture({ parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_2', metadata: {} } } }), 'invoice.paid'));
    expect(cap.enregistres).toEqual([]);
  });

  it('🔴 un renouvellement échoué : en retard, et Julien est prévenu ; un abonnement inconnu ne prévient personne', async () => {
    const connu = monter({ connus: ['sub_1'] });
    await envoyer(connu.srv, evenement(facture(), 'invoice.payment_failed'));
    expect(connu.cap.statuts.map((s) => s.statut)).toEqual(['en_retard']);
    expect(connu.cap.alertes).toHaveLength(1);
    const inconnu = monter();
    await envoyer(inconnu.srv, evenement(facture(), 'invoice.payment_failed'));
    expect(inconnu.cap.alertes).toEqual([]);
  });

  it('🔴 un abonnement supprimé : résilié, et Julien est prévenu', async () => {
    const { srv, cap } = monter({ connus: ['sub_1'] });
    await envoyer(srv, evenement({ id: 'sub_1', object: 'subscription', status: 'canceled', metadata: { tenant_id: T1, produit: 'numero' } }, 'customer.subscription.deleted'));
    expect(cap.statuts).toEqual([{ abonnementId: 'sub_1', statut: 'resilie', periodeFin: null }]);
    expect(cap.alertes).toHaveLength(1);
  });

  it('🔴 un événement d’un autre mode que la clé : rien n’est écrit', async () => {
    const { srv, cap } = monter({ livemode: false });
    await envoyer(srv, evenement(sessionAbonnement(), 'checkout.session.completed'));
    await envoyer(srv, evenement(facture(), 'invoice.paid'));
    expect(cap.enregistres).toEqual([]);
    expect(cap.statuts).toEqual([]);
  });

  it('une facture illisible : 422, Stripe la rejouera', async () => {
    const { srv } = monter();
    expect((await envoyer(srv, evenement({ object: 'invoice' }, 'invoice.paid'))).statusCode).toBe(422);
  });
});
