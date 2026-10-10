import { describe, expect, it } from 'vitest';
import {
  creerTraitementAbonnements, type DepsTraitementAbonnements, type EvenementStripeVerifie,
} from '../src/stripe/traitement-abonnements';
import { stripeNumeroInerte, stripeProInerte } from './routes-inertes';

const TENANT = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';

function evenement(type: string, objet: unknown): EvenementStripeVerifie {
  return { id: 'evt_1', type, livemode: true, objet };
}

function creer(over: Partial<DepsTraitementAbonnements> = {}) {
  return creerTraitementAbonnements({
    numero: stripeNumeroInerte,
    pro: stripeProInerte,
    now: () => 1_790_000_000_000,
    ...over,
  });
}

describe('le traitement des événements Stripe d’abonnement', () => {
  it('laisse une recharge au chemin de crédit', async () => {
    const traitement = creer();
    const e = evenement('checkout.session.completed', {
      id: 'cs_1', mode: 'payment', payment_status: 'paid', metadata: { offre: 'refill_50', tenant_id: TENANT },
    });

    expect(traitement.concerne(e)).toBe(false);
    await expect(traitement.traiter(e)).resolves.toEqual({ issue: 'non_abonnement' });
  });

  it('reconnaît la marque du Pro avant de refuser sa forme illisible', async () => {
    const traitement = creer();
    const e = evenement('checkout.session.completed', { metadata: { produit: 'pro' } });

    expect(traitement.concerne(e)).toBe(true);
    await expect(traitement.traiter(e)).resolves.toEqual({ issue: 'illisible', domaine: 'pro' });
  });

  it('enregistre directement une session payée du numéro fourni', async () => {
    const enregistres: unknown[] = [];
    const reprises: string[] = [];
    const numero: DepsTraitementAbonnements['numero'] = {
      ...stripeNumeroInerte,
      enregistrer: async (a) => { enregistres.push(a); return { etat: 'enregistre', numero: '33123456789' }; },
      reprendreCampagnes: async (tenantId) => { reprises.push(tenantId); },
    };
    const traitement = creer({ numero });
    const e = evenement('checkout.session.completed', {
      id: 'cs_numero', mode: 'subscription', payment_status: 'paid', subscription: 'sub_numero',
      metadata: { tenant_id: TENANT, produit: 'numero' },
    });

    await expect(traitement.traiter(e)).resolves.toEqual({ issue: 'acquitte' });
    expect(enregistres).toEqual([{
      tenantId: TENANT, abonnementId: 'sub_numero', livemode: true, periodeFin: null,
    }]);
    expect(reprises).toEqual([TENANT]);
  });

  it('laisse remonter une panne inattendue pour que Stripe rejoue', async () => {
    const panne = new Error('connexion perdue');
    const pro: DepsTraitementAbonnements['pro'] = {
      ...stripeProInerte,
      enregistrer: async () => { throw panne; },
    };
    const traitement = creer({ pro });
    const e = evenement('checkout.session.completed', {
      id: 'cs_pro', mode: 'subscription', payment_status: 'paid', subscription: 'sub_pro',
      metadata: { tenant_id: TENANT, produit: 'pro', periodicite: 'mois' },
    });

    await expect(traitement.traiter(e)).rejects.toBe(panne);
  });
});
