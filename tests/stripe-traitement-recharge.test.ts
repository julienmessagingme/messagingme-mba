import { describe, it, expect, afterEach, vi } from 'vitest';
import { creerTraitementRecharge } from '../src/stripe/traitement-recharge';
import type { IssuePaiement, PaiementStripe } from '../src/stripe/store.pg';

/**
 * La recharge du crédit IA (`src/stripe/traitement-recharge.ts`), sortie de la route du webhook (audit de structure du
 * 2026-10-25, lot C). La route garde la signature, l'enveloppe et le mode : `tests/http-credit-stripe.test.ts`.
 */
afterEach(() => vi.restoreAllMocks());

const ESPACE = '11111111-1111-4111-8111-111111111111';

function monter(o: { issue?: IssuePaiement } = {}) {
  const credits: PaiementStripe[] = [];
  const alertes: string[] = [];
  const plafonds: string[] = [];
  const t = creerTraitementRecharge({
    paiements: { crediterPaiement: async (p) => { credits.push(p); return o.issue ?? 'credite'; } },
    apresCredit: async (tenantId) => { plafonds.push(tenantId); },
    alerter: async (texte) => { alertes.push(texte); },
  });
  return { t, credits, alertes, plafonds };
}

const session = (o: Record<string, unknown> = {}) => ({
  id: 'cs_test_1', mode: 'payment', payment_status: 'paid', amount_subtotal: 1_000, amount_total: 1_200, currency: 'eur',
  client_reference_id: ESPACE, metadata: { tenant_id: ESPACE, offre: 'refill_10' }, invoice: 'in_1', ...o,
});
const evenement = (objet: unknown, type = 'checkout.session.completed') => ({ id: 'evt_1', type, livemode: false, objet });

describe('creerTraitementRecharge', () => {
  it('ne concerne que les deux événements qui créditent', async () => {
    const { t, credits } = monter();
    expect(t.concerne({ type: 'checkout.session.completed' })).toBe(true);
    expect(t.concerne({ type: 'checkout.session.async_payment_succeeded' })).toBe(true);
    expect(t.concerne({ type: 'invoice.paid' })).toBe(false);
    expect(await t.traiter(evenement(session(), 'invoice.paid'))).toEqual({ issue: 'non_recharge' });
    expect(credits).toEqual([]);
  });

  it('🔴 une session créditante illisible : `illisible` (la route demande le rejeu), rien n’est crédité', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { t, credits } = monter();
    expect(await t.traiter(evenement({ id: 'cs_1' }))).toEqual({ issue: 'illisible' });
    expect(credits).toEqual([]);
  });

  it('🔴 une recharge payée au bon montant crédite le crédit de SON offre, puis remonte le plafond', async () => {
    const { t, credits, plafonds } = monter();
    expect(await t.traiter(evenement(session()))).toEqual({ issue: 'acquitte', credite: true });
    expect(credits).toEqual([expect.objectContaining({ sessionId: 'cs_test_1', tenantId: ESPACE, offre: 'refill_10', creditMicroEur: 10_000_000, htCentimes: 1_000, ttcCentimes: 1_200, factureId: 'in_1', livemode: false })]);
    await Promise.resolve();
    expect(plafonds).toEqual([ESPACE]);
  });

  it('🔴 un montant, une devise ou une référence qui ne concordent pas : acquitté, rien n’est crédité', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const autre of [{ amount_subtotal: 500 }, { currency: 'usd' }, { client_reference_id: '22222222-2222-4222-8222-222222222222' }]) {
      const { t, credits } = monter();
      expect(await t.traiter(evenement(session(autre)))).toEqual({ issue: 'acquitte', credite: false });
      expect(credits).toEqual([]);
    }
  });

  it('pas une de nos recharges, ou pas encore réglée : acquitté sans rien dire du crédit', async () => {
    const pasNotre = monter();
    expect(await pasNotre.t.traiter(evenement(session({ metadata: {} })))).toEqual({ issue: 'acquitte' });
    expect(await pasNotre.t.traiter(evenement(session({ mode: 'subscription' })))).toEqual({ issue: 'acquitte' });
    expect(await pasNotre.t.traiter(evenement(session({ payment_status: 'unpaid' })))).toEqual({ issue: 'acquitte' });
    expect(pasNotre.credits).toEqual([]);
    expect(pasNotre.alertes).toEqual([]);
  });

  it('🔴 de l’argent encaissé sans crédit (offre inconnue, espace supprimé) : une alerte, jamais un crédit silencieux', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const inconnue = monter();
    expect(await inconnue.t.traiter(evenement(session({ metadata: { tenant_id: ESPACE, offre: 'refill_1000' } })))).toEqual({ issue: 'acquitte', credite: false });
    expect(inconnue.credits).toEqual([]);
    expect(inconnue.alertes).toHaveLength(1);
    const supprime = monter({ issue: 'espace_inconnu' });
    expect(await supprime.t.traiter(evenement(session()))).toEqual({ issue: 'acquitte', credite: false });
    expect(supprime.alertes[0]).toContain('à rembourser');
    expect(supprime.plafonds).toEqual([]);
  });

  it('un événement rejoué (session déjà créditée) : acquitté, `credite` faux, le plafond n’est pas relancé', async () => {
    const { t, plafonds } = monter({ issue: 'deja' });
    expect(await t.traiter(evenement(session()))).toEqual({ issue: 'acquitte', credite: false });
    await Promise.resolve();
    expect(plafonds).toEqual([]);
  });
});
