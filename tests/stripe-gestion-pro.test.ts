import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { finPrevueDe, type ReponseStripe, type TransportStripe } from '../src/stripe/client';
import { changerResiliationPro, facturesDeLEspace, finPrevueChezStripe, tarifDuPro, FACTURES_MONTREES, type DepsGestionPro } from '../src/stripe/gestion-pro';
import type { StripeConfigure } from '../src/stripe/paiement';

/**
 * GÉRER LE PRO DEPUIS LA CONSOLE (2026-10-26) : résilier, annuler la résiliation, lire les factures. Contre un transport
 * simulé : aucun appel ne part chez Stripe, la clé est tirée au hasard (rien que `gitleaks` puisse reconnaître).
 */
const CLE = ['rk', 'test', randomBytes(12).toString('hex')].join('_');
const FIN_PERIODE = Date.parse('2026-11-12T08:00:00Z') / 1000;

class FauxTransport implements TransportStripe {
  readonly appels: Array<{ methode: 'GET' | 'POST'; url: string; corps: URLSearchParams; entetes: Record<string, string> }> = [];
  constructor(private readonly reponses: Array<ReponseStripe | Error>) {}
  private suivante(): ReponseStripe {
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    if (r instanceof Error) throw r;
    return r;
  }
  async post(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    this.appels.push({ methode: 'POST', url, corps: new URLSearchParams(corps), entetes });
    return this.suivante();
  }
  async get(url: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    this.appels.push({ methode: 'GET', url, corps: new URLSearchParams(), entetes });
    return this.suivante();
  }
  async delete(): Promise<ReponseStripe> {
    throw new Error('aucune suppression ici');
  }
}

function monter(o: { reponses?: Array<ReponseStripe | Error>; stripe?: null; payeur?: boolean; pro?: null; client?: null } = {}) {
  const transport = new FauxTransport(o.reponses ?? []);
  const stripe: StripeConfigure = {
    cle: CLE, livemode: false, transport, prix: { refill_5: '', refill_10: '', refill_50: '', refill_100: '' },
    pageCredit: 'https://x', pageClaude: 'https://x',
  };
  const notes: Array<{ abonnementId: string; finPrevueLe: Date | null }> = [];
  const d: DepsGestionPro = {
    stripe: o.stripe === null ? null : stripe,
    payeurAutorise: async () => o.payeur ?? true,
    clients: { clientDe: async (tenant) => (o.client === null ? null : `cus_${tenant}`) },
    proVivant: async () => (o.pro === null ? null : { abonnementId: 'sub_1' }),
    noterFinPrevue: async (abonnementId, finPrevueLe) => { notes.push({ abonnementId, finPrevueLe }); },
    prixSiege: ['price_siege_mois', 'price_siege_an'],
  };
  return { d, transport, notes };
}

const abonnement = (o: { cancel_at?: number | null; cancel_at_period_end?: boolean }) => ({
  status: 200, json: { id: 'sub_1', ...o, items: { data: [{ current_period_end: FIN_PERIODE - 10 }, { current_period_end: FIN_PERIODE }] } },
});

describe('finPrevueDe : le calcul du webhook, partagé avec la console', () => {
  it('🔴 une date posée prime ; sinon la fin de période la plus tardive si la fin est à la fin de période ; sinon aucune', () => {
    expect(finPrevueDe({ cancel_at: 1_800_000_000, cancel_at_period_end: true, items: { data: [{ current_period_end: 5 }] } }))
      .toEqual(new Date(1_800_000_000 * 1000));
    expect(finPrevueDe({ cancel_at: null, cancel_at_period_end: true, items: { data: [{ current_period_end: 5 }, { current_period_end: 9 }] } }))
      .toEqual(new Date(9000));
    expect(finPrevueDe({ cancel_at: null, cancel_at_period_end: false, items: { data: [{ current_period_end: 9 }] } })).toBeNull();
    expect(finPrevueDe({ cancel_at_period_end: true })).toBeNull();
  });
});

describe('changerResiliationPro', () => {
  it('🔴 résilier : la fin de période posée chez Stripe, relue, écrite comme le webhook l’écrirait', async () => {
    const { d, transport, notes } = monter({ reponses: [abonnement({ cancel_at: FIN_PERIODE, cancel_at_period_end: true })] });
    const r = await changerResiliationPro(d, 't1', true, 'u1');
    expect(r).toEqual({ ok: true, valeur: { finPrevueLe: '2026-11-12T08:00:00.000Z' } });
    expect(transport.appels).toHaveLength(1);
    expect(transport.appels[0]!.url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(Object.fromEntries(transport.appels[0]!.corps)).toEqual({ cancel_at_period_end: 'true' });
    expect(notes).toEqual([{ abonnementId: 'sub_1', finPrevueLe: new Date(FIN_PERIODE * 1000) }]);
  });

  it('🔴 une clé d’idempotence PAR DEMANDE : « résilier, annuler, résilier » s’applique trois fois', async () => {
    const { d, transport } = monter({ reponses: [
      abonnement({ cancel_at_period_end: true }), abonnement({ cancel_at: null, cancel_at_period_end: false }), abonnement({ cancel_at_period_end: true }),
    ] });
    for (const resilier of [true, false, true]) expect((await changerResiliationPro(d, 't1', resilier, 'u1')).ok).toBe(true);
    const cles = transport.appels.map((a) => a.entetes['idempotency-key']);
    expect(new Set(cles).size).toBe(3);
    expect(cles.every((c) => typeof c === 'string' && c.startsWith('resiliation-sub_1-'))).toBe(true);
  });

  it('annuler : la fin retirée chez Stripe, plus aucune fin écrite', async () => {
    const { d, transport, notes } = monter({ reponses: [abonnement({ cancel_at: null, cancel_at_period_end: false })] });
    expect(await changerResiliationPro(d, 't1', false, 'u1')).toEqual({ ok: true, valeur: { finPrevueLe: null } });
    expect(Object.fromEntries(transport.appels[0]!.corps)).toEqual({ cancel_at_period_end: 'false' });
    expect(notes).toEqual([{ abonnementId: 'sub_1', finPrevueLe: null }]);
  });

  it('🔴 une fin DATÉE (posée au tableau de bord) ne se retire pas d’ici : 409 fin_datee, un seul appel, rien d’écrit', async () => {
    // La retirer recalcule la période et peut ajouter des prorata à la facture (relecture du 2026-10-26).
    const { d, transport, notes } = monter({ reponses: [abonnement({ cancel_at: 1_900_000_000, cancel_at_period_end: false })] });
    expect(await changerResiliationPro(d, 't1', false, 'u1')).toMatchObject({ ok: false, statut: 409, details: { code: 'fin_datee' } });
    expect(transport.appels.map((a) => Object.fromEntries(a.corps))).toEqual([{ cancel_at_period_end: 'false' }]);
    expect(notes).toEqual([]);
  });

  it('🔴 Stripe a changé mais la base ne s’écrit pas : le client lit quand même la fin, le webhook la réécrira', async () => {
    const { d } = monter({ reponses: [abonnement({ cancel_at: FIN_PERIODE, cancel_at_period_end: true })] });
    const panne = { ...d, noterFinPrevue: async () => { throw new Error('lock_timeout'); } };
    expect(await changerResiliationPro(panne, 't1', true, 'u1')).toEqual({ ok: true, valeur: { finPrevueLe: '2026-11-12T08:00:00.000Z' } });
  });

  it('🔴 une réponse qui ne porte pas le changement demandé est un refus : rien n’est écrit', async () => {
    const { d, notes } = monter({ reponses: [abonnement({ cancel_at: null, cancel_at_period_end: false })] });
    const r = await changerResiliationPro(d, 't1', true, 'u1');
    expect(r).toMatchObject({ ok: false, statut: 422, details: { code: 'resiliation_impossible' } });
    expect(notes).toEqual([]);
  });

  it('🔴 un refus de Stripe : 422 lisible, sans son message (il parle de NOTRE compte), rien n’est écrit', async () => {
    const { d, notes } = monter({ reponses: [{ status: 403, json: { error: { type: 'invalid_request_error', message: 'The provided key rk_test_secret does not have write access' } } }] });
    const r = await changerResiliationPro(d, 't1', true, 'u1');
    expect(r).toMatchObject({ ok: false, statut: 422, details: { code: 'resiliation_impossible' } });
    expect(JSON.stringify(r)).not.toContain('rk_test');
    expect(notes).toEqual([]);
  });

  it('sans Pro vivant : 409 ; Stripe absent ou payeur refusé (mode test) : 503 ; aucun appel', async () => {
    for (const [o, statut] of [[{ pro: null }, 409], [{ stripe: null }, 503], [{ payeur: false }, 503]] as const) {
      const { d, transport } = monter(o);
      expect(await changerResiliationPro(d, 't1', true, 'u1')).toMatchObject({ ok: false, statut });
      expect(transport.appels).toEqual([]);
    }
  });
});

const facture = (o: Record<string, unknown> = {}) => ({
  id: 'in_1', customer: 'cus_t1', number: 'MM-0001', created: 1_790_000_000, status: 'paid', total: 5880, currency: 'eur',
  hosted_invoice_url: 'https://invoice.stripe.com/i/1', invoice_pdf: 'https://pay.stripe.com/invoice/1/pdf',
  parent: { subscription_details: { metadata: { produit: 'pro', tenant_id: 't1' } } },
  lines: { data: [{ description: '1 × Messaging Me Pro' }] }, ...o,
});

describe('facturesDeLEspace', () => {
  it('🔴 les factures du client DE L’ESPACE, les 24 dernières, avec leur objet, leur statut et leurs adresses', async () => {
    const { d, transport } = monter({ reponses: [{ status: 200, json: { has_more: true, data: [
      facture(),
      facture({ id: 'in_2', status: 'open', parent: { subscription_details: { metadata: { produit: 'numero' } } } }),
      facture({ id: 'in_3', status: 'void', parent: null, lines: { data: [{ description: 'Recharge du crédit IA 5 € HT' }] } }),
      facture({ id: 'in_4', status: 'uncollectible', hosted_invoice_url: 'http://pas-https.test', invoice_pdf: null }),
    ] } }] });
    const r = await facturesDeLEspace(d, 't1', 'u1');
    expect(transport.appels[0]!.methode).toBe('GET');
    const url = new URL(transport.appels[0]!.url);
    expect(url.pathname).toBe('/v1/invoices');
    expect(Object.fromEntries(url.searchParams)).toEqual({ customer: 'cus_t1', limit: String(FACTURES_MONTREES) });
    expect(r).toEqual({ ok: true, valeur: { plusSurStripe: true, factures: [
      { id: 'in_1', numero: 'MM-0001', le: new Date(1_790_000_000 * 1000).toISOString(), objet: 'pro', libelle: '1 × Messaging Me Pro',
        totalCentimes: 5880, devise: 'eur', statut: 'payee', urlPage: 'https://invoice.stripe.com/i/1', urlPdf: 'https://pay.stripe.com/invoice/1/pdf' },
      expect.objectContaining({ id: 'in_2', objet: 'numero', statut: 'a_regler' }),
      expect.objectContaining({ id: 'in_3', objet: 'autre', libelle: 'Recharge du crédit IA 5 € HT', statut: 'annulee' }),
      // Une adresse qui n'est pas `https` n'est jamais rendue : l'écran y enverrait un onglet.
      expect.objectContaining({ id: 'in_4', statut: 'impayee', urlPage: null, urlPdf: null }),
    ] } });
  });

  it('🔴 un brouillon, un statut inconnu, une facture illisible ou d’un autre client sont écartés, sans cacher les autres', async () => {
    const { d } = monter({ reponses: [{ status: 200, json: { has_more: false, data: [
      facture({ id: 'in_brouillon', status: 'draft' }), facture({ id: 'in_futur', status: 'statut_de_demain' }),
      facture({ id: 'pas_une_facture' }), facture({ id: 'in_autre', customer: 'cus_autre' }), facture({ id: 'in_bonne' }),
    ] } }] });
    const r = await facturesDeLEspace(d, 't1', 'u1');
    expect(r.ok && r.valeur.factures.map((f) => f.id)).toEqual(['in_bonne']);
  });

  it('un espace sans client Stripe (jamais payé) : une liste vide, sans appel', async () => {
    const { d, transport } = monter({ client: null });
    expect(await facturesDeLEspace(d, 't1', 'u1')).toEqual({ ok: true, valeur: { factures: [], plusSurStripe: false } });
    expect(transport.appels).toEqual([]);
  });

  it('un refus de Stripe : 422 lisible ; Stripe absent ou payeur refusé : 503', async () => {
    const { d } = monter({ reponses: [{ status: 500, json: null }] });
    expect(await facturesDeLEspace(d, 't1', 'u1')).toMatchObject({ ok: false, statut: 422, details: { code: 'factures_impossible' } });
    expect(await facturesDeLEspace(monter({ stripe: null }).d, 't1', 'u1')).toMatchObject({ ok: false, statut: 503 });
    expect(await facturesDeLEspace(monter({ payeur: false }).d, 't1', 'u1')).toMatchObject({ ok: false, statut: 503 });
  });
});

/** L'abonnement tel que Stripe le rend à une lecture : ses lignes et leur prix, sa fin posée ou non, ses remises. */
const lu = (o: { cancel_at?: number | null; cancel_at_period_end?: boolean; discounts?: unknown[]; lignes?: unknown[] } = {}) => ({
  status: 200,
  json: {
    id: 'sub_1', status: 'active', latest_invoice: 'in_9', cancel_at: o.cancel_at ?? null, cancel_at_period_end: o.cancel_at_period_end ?? false,
    discounts: o.discounts ?? [],
    items: { data: o.lignes ?? [
      { id: 'si_pro', quantity: 1, current_period_end: FIN_PERIODE, price: { id: 'price_pro_mois', unit_amount: 3900 } },
      { id: 'si_siege', quantity: 2, current_period_end: FIN_PERIODE, price: { id: 'price_siege_mois', unit_amount: 1200 } },
    ] },
  },
});

describe('finPrevueChezStripe : la fin relue pour le webhook (2026-10-26)', () => {
  it('🔴 rend la fin que Stripe a MAINTENANT : aucune, ou la fin de période posée', async () => {
    expect(await finPrevueChezStripe(monter({ reponses: [lu()] }).d, 'sub_1')).toBeNull();
    expect(await finPrevueChezStripe(monter({ reponses: [lu({ cancel_at_period_end: true })] }).d, 'sub_1')).toEqual(new Date(FIN_PERIODE * 1000));
  });

  it('🔴 une panne passagère lève (le webhook échoue, Stripe rejouera) ; un refus durable rend undefined (la charge sert)', async () => {
    await expect(finPrevueChezStripe(monter({ reponses: [{ status: 503, json: null }] }).d, 'sub_1')).rejects.toThrow();
    await expect(finPrevueChezStripe(monter({ reponses: [new Error('réseau')] }).d, 'sub_1')).rejects.toThrow();
    expect(await finPrevueChezStripe(monter({ reponses: [{ status: 404, json: { error: { type: 'invalid_request_error' } } }] }).d, 'sub_1')).toBeUndefined();
    expect(await finPrevueChezStripe(monter({ stripe: null }).d, 'sub_1')).toBeUndefined();
  });
});

describe('tarifDuPro : le prix de l’abonné, pas la grille (2026-10-26)', () => {
  it('🔴 le Pro et le prix d’un siège, lus sur les lignes de l’abonnement, et la remise', async () => {
    const { d } = monter({ reponses: [lu({ discounts: ['di_1'] })] });
    expect(await tarifDuPro(d, 't1', 'u1')).toEqual({ ok: true, valeur: { proHtCentimes: 3900, siegeHtCentimes: 1200, remise: true } });
  });

  it('sans siège ni remise ; une ligne du Pro sans prix fixe : prix inconnu (la console garde la grille)', async () => {
    const seul = monter({ reponses: [lu({ lignes: [{ id: 'si_pro', quantity: 1, price: { id: 'price_pro_an', unit_amount: 39000 } }] })] });
    expect(await tarifDuPro(seul.d, 't1', 'u1')).toEqual({ ok: true, valeur: { proHtCentimes: 39000, siegeHtCentimes: null, remise: false } });
    const variable = monter({ reponses: [lu({ lignes: [{ id: 'si_pro', quantity: 1, price: { id: 'price_pro_mois', unit_amount: null } }] })] });
    expect(await tarifDuPro(variable.d, 't1', 'u1')).toMatchObject({ ok: true, valeur: { proHtCentimes: null } });
  });

  it('🔴 un siège à un prix qui n’est plus configuré (le tarif a changé) ne gonfle pas le Pro : prix inconnu, la grille sert', async () => {
    const ancien = monter({ reponses: [lu({ lignes: [
      { id: 'si_pro', quantity: 1, price: { id: 'price_pro_mois', unit_amount: 3900 } },
      { id: 'si_siege', quantity: 2, price: { id: 'price_siege_ancien', unit_amount: 1200 } },
    ] })] });
    expect(await tarifDuPro(ancien.d, 't1', 'u1')).toMatchObject({ ok: true, valeur: { proHtCentimes: null } });
  });

  it('sans Pro vivant : 409 ; Stripe absent ou payeur refusé : 503 ; un refus de Stripe : 422, sans son message', async () => {
    expect(await tarifDuPro(monter({ pro: null }).d, 't1', 'u1')).toMatchObject({ ok: false, statut: 409, details: { code: 'aucun_pro' } });
    expect(await tarifDuPro(monter({ stripe: null }).d, 't1', 'u1')).toMatchObject({ ok: false, statut: 503 });
    expect(await tarifDuPro(monter({ payeur: false }).d, 't1', 'u1')).toMatchObject({ ok: false, statut: 503 });
    const refuse = await tarifDuPro(monter({ reponses: [{ status: 403, json: { error: { message: 'The key rk_test_x cannot read subscriptions' } } }] }).d, 't1', 'u1');
    expect(refuse).toMatchObject({ ok: false, statut: 422, details: { code: 'tarif_impossible' } });
    expect(JSON.stringify(refuse)).not.toContain('rk_test');
  });
});
