import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { StripeWebhookRouteDeps } from '../src/http/credit-stripe';
import type { AbonnementOffre, IssueEnregistrementPro, PeriodiciteOffre, RaisonFinOffre } from '../src/offres/abonnements-offre.pg';
import { stripeNumeroInerte } from './routes-inertes';
import type { FinDuPro } from '../src/offres/numero-inclus';

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
  return {
    abonnementId, tenantId: T1, periodicite: 'mois', livemode: true, statut: 'actif', periodeFin: null, finPrevueLe: null, finiLe: null, finRaison: null,
    rendreNumero: false, suiteAnnonceeLe: null, essaiFinLe: null, sieges: 0, ...over,
  };
}

function monter(o: { connus?: string[]; issue?: IssueEnregistrementPro; panne?: unknown; rendre?: boolean; sieges?: number | null | Error; relue?: Date | null | Error } = {}) {
  const cap = {
    enregistres: [] as Array<{ tenantId: string; abonnementId: string; periodicite: PeriodiciteOffre; livemode: boolean; periodeFin: Date | null; essaiFinLe?: Date | null }>,
    statuts: [] as Array<{ abonnementId: string; statut: string; periodeFin: Date | null; finEchouee: Date | null }>,
    modifs: [] as Array<{ abonnementId: string; finPrevueLe: Date | null; periodicite: PeriodiciteOffre | null; essaiFinLe?: Date | null; sieges?: number }>,
    /** Les abonnements relus chez Stripe pour leurs sièges (livraison 7). */
    relus: [] as string[],
    fins: [] as Array<{ abonnementId: string; raison: RaisonFinOffre; finiLe: Date }>,
    invalides: [] as string[],
    alertes: [] as string[],
    credits: 0,
    /** Les passages en Pro : l'espace, et si l'abonnement du numéro seul s'arrête (pas pendant un essai, spec offres v2). */
    passages: [] as Array<{ tenantId: string; arreter: boolean }>,
    finsDuPro: [] as FinDuPro[],
    /** Les e-mails de paiement refusé demandés (lot 7). */
    paiementsRefuses: [] as Array<{ tenantId: string; offre: string; factureId: string }>,
  };
  const connus = new Set(o.connus ?? []);
  const finis = new Set<string>();
  const deps: StripeWebhookRouteDeps = {
    secret: SECRET_WEBHOOK,
    livemode: true,
    paiements: { crediterPaiement: async () => { cap.credits += 1; return 'credite'; } },
    apresCredit: async () => {},
    paiementRefuse: async (p) => { cap.paiementsRefuses.push({ tenantId: p.tenantId, offre: p.offre, factureId: p.factureId }); },
    numero: stripeNumeroInerte,
    pro: {
      enregistrer: async (a) => { if (o.panne !== undefined) throw o.panne; cap.enregistres.push(a); const neuf = !connus.has(a.abonnementId); connus.add(a.abonnementId); return o.issue ?? { etat: 'enregistre', tenantId: T1, nouveau: neuf }; },
      majStatut: async (abonnementId, statut, periodeFin, finEchouee = null) => {
        cap.statuts.push({ abonnementId, statut, periodeFin, finEchouee });
        return connus.has(abonnementId) ? ligne(abonnementId, { statut }) : null;
      },
      modifier: async (abonnementId, m) => { cap.modifs.push({ abonnementId, ...m }); return connus.has(abonnementId) ? ligne(abonnementId, m.periodicite ? { periodicite: m.periodicite } : {}) : null; },
      finir: async (abonnementId, raison, finiLe) => {
        cap.fins.push({ abonnementId, raison, finiLe });
        if (!connus.has(abonnementId)) return null;
        const premiereFin = !finis.has(abonnementId);
        finis.add(abonnementId);
        return { ...ligne(abonnementId, { statut: 'resilie', finiLe, finRaison: raison, rendreNumero: o.rendre ?? false }), premiereFin };
      },
      invalider: (t) => { cap.invalides.push(t); },
      alerter: async (texte) => { cap.alertes.push(texte); },
      surPassageEnPro: async (t, o) => { cap.passages.push({ tenantId: t, arreter: o.arreterLeNumeroSeul }); },
      surFinDuPro: async (f) => { cap.finsDuPro.push(f); },
      vivant: async () => false,
      siegesChezStripe: async (abonnementId) => {
        cap.relus.push(abonnementId);
        if (o.sieges instanceof Error) throw o.sieges;
        return o.sieges ?? null;
      },
      // Sans `relue`, rien n'est relu chez Stripe (`undefined`) : la charge de l'événement sert, comme avant.
      finPrevueChezStripe: async () => {
        if (o.relue instanceof Error) throw o.relue;
        return o.relue;
      },
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

  it('🔴 un espace supprimé depuis /ops (RC8, 23503) qui paie encore son Pro : 200 et Julien prévenu avec le lien, jamais une boucle de rejeux', async () => {
    for (const [objet, type] of [[sessionPro(), 'checkout.session.completed'], [facturePro(), 'invoice.paid']] as const) {
      const { srv, cap } = monter({ panne: Object.assign(new Error('violation de clé étrangère'), { code: '23503' }) });
      expect((await envoyer(srv, evenement(objet, type))).statusCode, type).toBe(200);
      expect(cap.alertes, type).toEqual([`L'espace supprimé ${T1} paie encore son Pro sub_pro : à résilier chez Stripe. https://dashboard.stripe.com/subscriptions/sub_pro`]);
      expect(cap.invalides, type).toEqual([]);
    }
  });

  it('une autre panne de base à l’enregistrement du Pro remonte toujours (Stripe rejoue)', async () => {
    const { srv, cap } = monter({ panne: Object.assign(new Error('connexion perdue'), { code: '08006' }) });
    expect((await envoyer(srv, evenement(sessionPro(), 'checkout.session.completed'))).statusCode).toBeGreaterThanOrEqual(500);
    expect(cap.alertes).toEqual([]);
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
    // Et les admins de l'espace, par e-mail (lot 7), une fois par facture.
    expect(cap.paiementsRefuses).toEqual([{ tenantId: T1, offre: 'pro', factureId: expect.stringMatching(/^in_/) }]);
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

  it('🔴 un événement en retard ne remet pas une fin retirée depuis : la fin RELUE chez Stripe est écrite, pas celle de la charge', async () => {
    // « Résilier » puis « Annuler la résiliation » dans la console, puis le premier événement rejoué en retard (2026-10-26).
    const { srv, cap } = monter({ connus: ['sub_pro'], relue: null });
    expect((await envoyer(srv, evenement(abonnementPro({ cancel_at_period_end: true }), 'customer.subscription.updated'))).statusCode).toBe(200);
    expect(cap.modifs).toEqual([{ abonnementId: 'sub_pro', finPrevueLe: null, periodicite: 'an' }]);
    // Et dans l'autre sens : la charge ne dit aucune fin, Stripe en a une, c'est la sienne qui compte.
    const autre = monter({ connus: ['sub_pro'], relue: new Date(FIN * 1000) });
    await envoyer(autre.srv, evenement(abonnementPro(), 'customer.subscription.updated'));
    expect(autre.cap.modifs[0]).toMatchObject({ finPrevueLe: new Date(FIN * 1000) });
  });

  it('🔴 une relecture de la fin en panne passagère : le webhook échoue (Stripe rejouera), rien n’est écrit', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'], relue: new Error('stripe : siege impossible (reseau)') });
    expect((await envoyer(srv, evenement(abonnementPro({ cancel_at_period_end: true }), 'customer.subscription.updated'))).statusCode).toBeGreaterThanOrEqual(500);
    expect(cap.modifs).toEqual([]);
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

  it('🟡 un rejeu de la fin ne réalerte pas (Stripe rejoue un événement non acquitté)', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'] });
    const fin = evenement(abonnementPro({ ended_at: FIN, cancellation_details: { reason: 'cancellation_requested' } }), 'customer.subscription.deleted');
    await envoyer(srv, fin);
    await envoyer(srv, fin);
    expect(cap.fins).toHaveLength(2);
    expect(cap.alertes).toHaveLength(1);
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
    // Un doublon n'ouvre aucun passage en Pro : rien n'arrête le numéro seul de l'espace.
    expect(cap.passages).toEqual([]);
  });
});

describe('le numéro inclus dans le Pro (lot 6, B2b)', () => {
  it('🔴 le Pro enregistré déclenche le passage en Pro de son espace, à chaque enregistrement (rejouable, donc rejoué)', async () => {
    const { srv, cap } = monter();
    await envoyer(srv, evenement(sessionPro(), 'checkout.session.completed'));
    await envoyer(srv, evenement(sessionPro(), 'checkout.session.completed'));
    // Une panne au premier passage (5xx, Stripe rejoue) ne doit pas le perdre : le rejeu, non nouveau, le refait.
    // Hors essai, le numéro seul s'arrête dès le passage, comme avant la spec offres v2.
    expect(cap.passages).toEqual([{ tenantId: T1, arreter: true }, { tenantId: T1, arreter: true }]);
  });

  it('🔴 la fin du Pro transmet la raison, la date, le choix de rendre, le client et la carte du Pro', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'], rendre: true });
    await envoyer(srv, evenement(abonnementPro({
      ended_at: FIN, cancellation_details: { reason: 'cancellation_requested' }, customer: 'cus_P', default_payment_method: 'pm_P',
    }), 'customer.subscription.deleted'));
    expect(cap.finsDuPro).toEqual([{
      tenantId: T1, abonnementPro: 'sub_pro', livemode: true, raison: 'resiliation', finiLe: new Date(FIN * 1000),
      // La fin prévue gardée sur la ligne du Pro (R1 de la relecture) : sans elle, une fin immédiate recréerait le numéro.
      finPrevueLe: null, rendreNumero: true, customerId: 'cus_P', carte: 'pm_P',
    }]);
  });

  it('une carte dépliée par Stripe se lit sur son identifiant ; sans carte ni client : null, jamais une valeur inventée', async () => {
    const a = monter({ connus: ['sub_pro'] });
    await envoyer(a.srv, evenement(abonnementPro({ ended_at: FIN, customer: 'cus_P', default_payment_method: { id: 'pm_DEPLIE', object: 'payment_method' } }), 'customer.subscription.deleted'));
    expect(a.cap.finsDuPro[0]).toMatchObject({ customerId: 'cus_P', carte: 'pm_DEPLIE' });
    const b = monter({ connus: ['sub_pro'] });
    await envoyer(b.srv, evenement(abonnementPro({ ended_at: FIN, default_payment_method: null }), 'customer.subscription.deleted'));
    expect(b.cap.finsDuPro[0]).toMatchObject({ customerId: null, carte: null });
  });

  it('la fin d’un Pro inconnu ne déclenche rien', async () => {
    const { srv, cap } = monter();
    await envoyer(srv, evenement(abonnementPro({ ended_at: FIN }), 'customer.subscription.deleted'));
    expect(cap.finsDuPro).toEqual([]);
  });
});

/**
 * L'ESSAI DE 14 JOURS (spec offres v2, livraison 6). Le paiement du Pro marque l'essai (`essai: '14'`) sur la session et
 * sur l'abonnement : chaque événement le porte, quel que soit l'ordre où Stripe les livre. Le Pro est ouvert pendant
 * l'essai ; 🔴 l'abonnement du numéro payé à part ne s'arrête qu'à la PREMIÈRE facture payée non nulle, sinon un essai
 * abandonné ferait perdre son numéro à un client qui le payait.
 */
const META_ESSAI = { ...META, periodicite: 'mois', essai: '14' };
const FIN_ESSAI = 1_791_209_600;

describe('l’essai de 14 jours du Pro', () => {
  it('🔴 la session d’un essai (rien à payer) fait le Pro, sans arrêter le numéro payé à part ; Julien est prévenu de l’essai', async () => {
    const { srv, cap } = monter();
    await envoyer(srv, evenement(sessionPro({ payment_status: 'no_payment_required', amount_total: 0, metadata: META_ESSAI }), 'checkout.session.completed'));
    expect(cap.enregistres).toHaveLength(1);
    expect(cap.passages).toEqual([{ tenantId: T1, arreter: false }]);
    expect(cap.alertes).toEqual([expect.stringMatching(/Nouveau Pro en essai/)]);
  });

  it('🔴 la création de l’abonnement en essai enregistre le Pro avec la fin de l’essai, quel que soit l’ordre des événements', async () => {
    const { srv, cap } = monter();
    await envoyer(srv, evenement(abonnementPro({ status: 'trialing', trial_end: FIN_ESSAI, metadata: META_ESSAI }), 'customer.subscription.created'));
    expect(cap.enregistres).toEqual([expect.objectContaining({ tenantId: T1, abonnementId: 'sub_pro', essaiFinLe: new Date(FIN_ESSAI * 1000) })]);
    expect(cap.passages).toEqual([{ tenantId: T1, arreter: false }]);
  });

  it('🔴 seule la création d’un ESSAI fait le Pro : un abonnement incomplet, ou actif avant encaissement (un prélèvement SEPA en cours), attend sa facture payée', async () => {
    const { srv, cap } = monter();
    for (const status of ['incomplete', 'active']) {
      expect((await envoyer(srv, evenement(abonnementPro({ status, metadata: META }), 'customer.subscription.created'))).statusCode, status).toBe(200);
    }
    expect([cap.enregistres, cap.passages]).toEqual([[], []]);
  });

  it('🔴 la facture à 0 € du début de l’essai n’arrête rien ; la première facture payée NON NULLE arrête le numéro seul', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'] });
    const essai = { type: 'subscription_details', subscription_details: { subscription: 'sub_pro', metadata: META_ESSAI } };
    await envoyer(srv, evenement(facturePro({ amount_paid: 0, parent: essai }), 'invoice.paid'));
    expect(cap.passages).toEqual([]);
    await envoyer(srv, evenement(facturePro({ id: 'in_pro_2', amount_paid: 4900, parent: essai }), 'invoice.paid'));
    expect(cap.passages).toEqual([{ tenantId: T1, arreter: true }]);
  });

  it('🔴 un code promo à 100 % après l’essai : la facture de CYCLE à 0 € payée arrête aussi le numéro seul ; celle de la création, non', async () => {
    // Le rouge 1 de la relecture de la livraison 6 : sans cela, le Pro gratuit laissait le numéro seul prélevé, en silence.
    const { srv, cap } = monter({ connus: ['sub_pro'] });
    const essai = { type: 'subscription_details', subscription_details: { subscription: 'sub_pro', metadata: META_ESSAI } };
    await envoyer(srv, evenement(facturePro({ amount_paid: 0, billing_reason: 'subscription_create', parent: essai }), 'invoice.paid'));
    expect(cap.passages).toEqual([]);
    await envoyer(srv, evenement(facturePro({ id: 'in_pro_cycle', amount_paid: 0, billing_reason: 'subscription_cycle', parent: essai }), 'invoice.paid'));
    expect(cap.passages).toEqual([{ tenantId: T1, arreter: true }]);
  });

  it('la modification de l’abonnement relit la fin de l’essai', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'] });
    await envoyer(srv, evenement(abonnementPro({ status: 'trialing', trial_end: FIN_ESSAI, metadata: META_ESSAI }), 'customer.subscription.updated'));
    expect(cap.modifs).toEqual([expect.objectContaining({ abonnementId: 'sub_pro', essaiFinLe: new Date(FIN_ESSAI * 1000) })]);
  });

  it('hors essai, une facture payée d’un Pro connu n’arrête rien de plus : le numéro seul l’a été au passage', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'] });
    await envoyer(srv, evenement(facturePro({ amount_paid: 4900 }), 'invoice.paid'));
    expect(cap.passages).toEqual([]);
  });

  it('🔴 la création d’un abonnement du NUMÉRO (sans notre marque Pro) ne touche ni au Pro ni au numéro', async () => {
    const { srv, cap } = monter();
    const numero = { id: 'sub_num', object: 'subscription', status: 'active', metadata: { tenant_id: T1, produit: 'numero' } };
    expect((await envoyer(srv, evenement(numero, 'customer.subscription.created'))).statusCode).toBe(200);
    expect([cap.enregistres, cap.passages]).toEqual([[], []]);
  });
});

describe('les sièges payants (spec offres v2, livraison 7)', () => {
  it('🔴 une modification de l’abonnement relit les sièges CHEZ STRIPE, jamais dans la charge de l’événement', async () => {
    // La charge porte 5 sièges : un événement plus ancien, livré en retard. Stripe dit 2, c'est 2 qui est noté.
    const { srv, cap } = monter({ connus: ['sub_pro'], sieges: 2 });
    const charge = abonnementPro({ items: { data: [{ current_period_end: FIN, quantity: 5, price: { id: 'price_siege_an', recurring: { interval: 'year', interval_count: 1 } } }] } });
    expect((await envoyer(srv, evenement(charge, 'customer.subscription.updated'))).statusCode).toBe(200);
    expect(cap.relus).toEqual(['sub_pro']);
    expect(cap.modifs).toEqual([expect.objectContaining({ abonnementId: 'sub_pro', sieges: 2 })]);
    expect(cap.invalides).toEqual([T1]);
  });

  it('Stripe pas câblé pour les sièges : la modification garde ceux déjà notés (aucune clé `sieges`)', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'], sieges: null });
    await envoyer(srv, evenement(abonnementPro(), 'customer.subscription.updated'));
    expect(cap.modifs[0]).not.toHaveProperty('sieges');
  });

  it('Stripe ne répond pas à la relecture : le webhook échoue, Stripe rejouera ; rien n’est écrit', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'], sieges: new Error('stripe : siege impossible (reseau)') });
    expect((await envoyer(srv, evenement(abonnementPro(), 'customer.subscription.updated'))).statusCode).toBeGreaterThanOrEqual(500);
    expect(cap.modifs).toEqual([]);
  });

  it('🔴 le prorata PAYÉ d’un siège sur un abonnement marqué essai n’arrête jamais le numéro payé à part, même non nul', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'] });
    const essai = { type: 'subscription_details', subscription_details: { subscription: 'sub_pro', metadata: { ...META, essai: '14' } } };
    await envoyer(srv, evenement(facturePro({ amount_paid: 1500, billing_reason: 'subscription_update', parent: essai }), 'invoice.paid'));
    expect(cap.passages).toEqual([]);
  });

  it('🔴 un prorata de siège impayé ne met PAS le Pro en retard, et ne prévient personne : le siège n’a juste pas été ajouté', async () => {
    const { srv, cap } = monter({ connus: ['sub_pro'] });
    expect((await envoyer(srv, evenement(facturePro({ billing_reason: 'subscription_update' }), 'invoice.payment_failed'))).statusCode).toBe(200);
    expect([cap.statuts, cap.paiementsRefuses, cap.alertes]).toEqual([[], [], []]);
    // Un renouvellement refusé, lui, le met toujours en retard.
    await envoyer(srv, evenement(facturePro({ id: 'in_cycle', billing_reason: 'subscription_cycle' }), 'invoice.payment_failed'));
    expect(cap.statuts).toEqual([expect.objectContaining({ statut: 'en_retard' })]);
  });
});
