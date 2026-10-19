import { describe, it, expect } from 'vitest';
import type { ReponseStripe, TransportStripe } from '../src/stripe/client';
import { changerSieges, siegesChezStripe, type DepsSieges } from '../src/stripe/sieges';

/**
 * LES SIÈGES PAYANTS DU PRO (spec offres v2, livraison 7). L'administrateur confirme un utilisateur de plus : la quantité
 * change chez Stripe D'ABORD, avec le prorata facturé tout de suite, et seulement s'il est payé
 * (`payment_behavior=pending_if_incomplete`). La limite ne suit qu'ensuite, sur ce que Stripe a rendu. Le prix posé chez
 * Stripe est recoupé avant tout appel qui écrit, et la clé d'idempotence protège d'un double clic.
 */
const T1 = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';

class FauxStripe implements TransportStripe {
  readonly posts: Array<{ url: string; corps: URLSearchParams; cle: string }> = [];
  readonly lus: string[] = [];
  constructor(
    private readonly objets: Record<string, unknown>, private readonly reponses: ReponseStripe[],
    /** L'abonnement tel que Stripe le relit après la modification ; absent, celui que la modification a rendu. */
    private readonly apresPost?: unknown,
  ) {}
  async post(url: string, corps: string, entetes: Record<string, string>): Promise<ReponseStripe> {
    this.posts.push({ url, corps: new URLSearchParams(corps), cle: entetes['idempotency-key'] ?? '' });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    const j = r.json as { id?: string; pending_update?: unknown } | null;
    if (r.status === 200 && j?.id === 'sub_pro1' && !j.pending_update) this.objets.sub_pro1 = this.apresPost ?? { ...j, latest_invoice: 'in_prorata' };
    return r;
  }
  async delete(): Promise<ReponseStripe> {
    throw new Error('arrêt d’abonnement non prévu');
  }
  async get(url: string): Promise<ReponseStripe> {
    this.lus.push(url);
    const id = decodeURIComponent((url.split('/').pop() ?? '').split('?')[0]!);
    const o = this.objets[id];
    return o === undefined ? { status: 404, json: { error: { message: 'inconnu' } } } : { status: 200, json: o };
  }
}

const SIEGE_MOIS = { id: 'price_siege_mois', unit_amount: 1500, currency: 'eur', recurring: { interval: 'month', interval_count: 1 } };
const SIEGE_AN = { id: 'price_siege_an', unit_amount: 15000, currency: 'eur', recurring: { interval: 'year', interval_count: 1 } };
const LIGNE_PRO = { id: 'si_pro', quantity: 1, price: { id: 'price_pro_mois' } };

const abonnement = (o: { statut?: string; sieges?: number; prixSiege?: string; autres?: unknown[]; facture?: string } = {}) => ({
  id: 'sub_pro1',
  status: o.statut ?? 'active',
  latest_invoice: o.facture ?? 'in_avant',
  items: {
    data: [
      LIGNE_PRO,
      ...(o.sieges ? [{ id: 'si_siege', quantity: o.sieges, price: { id: o.prixSiege ?? 'price_siege_mois' } }] : []),
      ...(o.autres ?? []),
    ],
  },
});

/** La réponse de Stripe à la modification : appliquée (`pending_update` nul) ou en attente de paiement. */
const change = (sieges: number, o: { enAttente?: boolean; prixSiege?: string } = {}): ReponseStripe => ({
  status: 200,
  json: {
    id: 'sub_pro1',
    status: 'active',
    pending_update: o.enAttente ? { expires_at: 1_900_000_000 } : null,
    latest_invoice: { id: 'in_prorata', status: o.enAttente ? 'open' : 'paid', hosted_invoice_url: 'https://invoice.stripe.com/i/prorata' },
    items: {
      data: [LIGNE_PRO, ...(sieges > 0 ? [{ id: 'si_siege', quantity: sieges, price: { id: o.prixSiege ?? 'price_siege_mois' } }] : [])],
    },
  },
});

function deps(o: {
  sub?: unknown; reponses?: ReponseStripe[]; pro?: { periodicite: 'mois' | 'an' } | null; membres?: number;
  prix?: Record<string, unknown>; prixVides?: boolean; autorise?: boolean; apresPost?: unknown;
} = {}) {
  const transport = new FauxStripe(
    { sub_pro1: o.sub ?? abonnement(), ...(o.prix ?? { price_siege_mois: SIEGE_MOIS, price_siege_an: SIEGE_AN }) },
    o.reponses ?? [],
    o.apresPost,
  );
  const notes: Array<[string, number]> = [];
  const invalides: string[] = [];
  const alertes: string[] = [];
  const d: DepsSieges = {
    stripe: { cle: 'rk_test_fausse', livemode: false, prix: { refill_50: '', refill_100: '' }, transport, pageCredit: 'https://x', pageClaude: 'https://x' },
    prixSiegeMois: o.prixVides ? '' : 'price_siege_mois',
    prixSiegeAn: o.prixVides ? '' : 'price_siege_an',
    payeurAutorise: async () => o.autorise ?? true,
    proVivant: async () => (o.pro === null ? null : { abonnementId: 'sub_pro1', periodicite: o.pro?.periodicite ?? 'mois' }),
    membres: async () => o.membres ?? 3,
    noterSieges: async (a, n) => { notes.push([a, n]); return { tenantId: T1 }; },
    invalider: (t) => { invalides.push(t); },
    alerter: async (t) => { alertes.push(t); },
  };
  return { d, transport, notes, invalides, alertes };
}

describe('🔴 ajouter un utilisateur (un siège)', () => {
  it('le premier siège d’un Pro mensuel : le prix relu, une ligne ajoutée, prorata facturé tout de suite et seulement s’il est payé', async () => {
    const { d, transport, notes, invalides, alertes } = deps({ reponses: [change(1)] });
    expect(await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1')).toEqual({ ok: true, valeur: { sieges: 1 } });
    expect(transport.lus.some((u) => u.endsWith('/prices/price_siege_mois'))).toBe(true);
    expect(transport.posts).toHaveLength(1);
    const p = transport.posts[0]!;
    expect(p.url).toMatch(/\/subscriptions\/sub_pro1$/);
    expect(p.corps.get('items[0][price]')).toBe('price_siege_mois');
    expect(p.corps.get('items[0][quantity]')).toBe('1');
    expect(p.corps.get('proration_behavior')).toBe('always_invoice');
    expect(p.corps.get('payment_behavior')).toBe('pending_if_incomplete');
    // Un double clic rejoue la même clé : Stripe rend la même réponse sans facturer deux fois.
    expect(p.cle).toBe('siege-sub_pro1-0-1-in_avant');
    expect(notes).toEqual([['sub_pro1', 1]]);
    expect(invalides).toEqual([T1]);
    expect(alertes[0]).toMatch(/sub_pro1/);
  });

  it('un Pro annuel reçoit le siège ANNUEL ; un deuxième siège change la quantité de la ligne existante', async () => {
    const { d, transport, notes } = deps({ pro: { periodicite: 'an' }, sub: abonnement({ sieges: 1, prixSiege: 'price_siege_an' }), reponses: [change(2, { prixSiege: 'price_siege_an' })] });
    expect(await changerSieges(d, T1, { depuis: 1, cible: 2 }, 'u1')).toEqual({ ok: true, valeur: { sieges: 2 } });
    expect(transport.lus.some((u) => u.endsWith('/prices/price_siege_an'))).toBe(true);
    const p = transport.posts[0]!;
    expect(p.corps.get('items[0][id]')).toBe('si_siege');
    expect(p.corps.get('items[0][quantity]')).toBe('2');
    expect(p.corps.has('items[0][price]')).toBe(false);
    expect(notes).toEqual([['sub_pro1', 2]]);
  });

  it('🔴 le prorata pas payé (carte refusée, authentification demandée) : rien n’est noté, la facture est rendue à régler', async () => {
    const { d, notes, invalides } = deps({ reponses: [change(0, { enAttente: true })] });
    const r = await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1');
    expect(r).toMatchObject({ ok: false, statut: 402, details: { code: 'paiement_siege_incomplet', url: 'https://invoice.stripe.com/i/prorata' } });
    expect(notes).toEqual([]);
    expect(invalides).toEqual([]);
  });

  it('🔴 un prix de siège qui ne vaut pas 15 € par mois : 422, rien n’est écrit chez Stripe', async () => {
    const { d, transport, notes } = deps({ prix: { price_siege_mois: { ...SIEGE_MOIS, unit_amount: 1900 }, price_siege_an: SIEGE_AN } });
    expect(await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1')).toMatchObject({ ok: false, statut: 422, details: { code: 'prix_incoherent' } });
    expect([transport.posts, notes]).toEqual([[], []]);
  });

  it('la quantité déjà atteinte (un second clic après le premier) : rien d’écrit chez Stripe, la base se recale', async () => {
    const { d, transport, notes } = deps({ sub: abonnement({ sieges: 1 }) });
    expect(await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1')).toEqual({ ok: true, valeur: { sieges: 1 } });
    expect(transport.posts).toEqual([]);
    expect(notes).toEqual([['sub_pro1', 1]]);
  });
});

describe('🔴 l’état de départ, l’idempotence et la relecture (relecture de la livraison 7)', () => {
  it('🔴 un état de départ périmé (deux onglets, deux copies) : 409, rien ne change chez Stripe ; un « Ajouter » ne retire jamais', async () => {
    const { d, transport, notes } = deps({ sub: abonnement({ sieges: 2 }) });
    expect(await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1')).toMatchObject({ ok: false, statut: 409, details: { code: 'sieges_changes' } });
    expect([transport.posts, notes]).toEqual([[], []]);
  });

  it('🔴 la base note ce que Stripe RELIT après la modification, pas la réponse (un rejeu idempotent peut être plus ancien)', async () => {
    const { d, notes } = deps({ reponses: [change(1)], apresPost: abonnement() });
    expect(await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1')).toEqual({ ok: true, valeur: { sieges: 0 } });
    expect(notes).toEqual([['sub_pro1', 0]]);
  });

  it('la même modification déjà en cours chez Stripe (`idempotency_key_in_use`) : 409 à réessayer, pas un refus de paiement', async () => {
    const { d, notes } = deps({ reponses: [{ status: 409, json: { error: { type: 'idempotency_error', code: 'idempotency_key_in_use', message: 'en cours' } } }] });
    expect(await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1')).toMatchObject({ ok: false, statut: 409, details: { code: 'sieges_en_cours' } });
    expect(notes).toEqual([]);
  });
});

describe('les refus avant tout appel qui écrit', () => {
  it('sièges pas en vente (prix pas posés) : 503', async () => {
    const { d, transport } = deps({ prixVides: true });
    expect(await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1')).toMatchObject({ ok: false, statut: 503, details: { code: 'sieges_indisponibles' } });
    expect(transport.lus).toEqual([]);
  });

  it('pas de Pro vivant : 409, les utilisateurs en plus s’ajoutent à un Pro', async () => {
    const { d, transport } = deps({ pro: null });
    expect(await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1')).toMatchObject({ ok: false, statut: 409, details: { code: 'aucun_pro' } });
    expect(transport.lus).toEqual([]);
  });

  it('🔴 un Pro en retard de paiement : 409, la facture du Pro d’abord', async () => {
    const { d, transport } = deps({ sub: abonnement({ statut: 'past_due' }) });
    expect(await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1')).toMatchObject({ ok: false, statut: 409, details: { code: 'pro_en_retard' } });
    expect(transport.posts).toEqual([]);
  });

  it('un siège posé à la main chez Stripe dans l’autre formule, ou sur deux lignes : 409, à régler avec nous', async () => {
    const autre = deps({ sub: abonnement({ sieges: 1, prixSiege: 'price_siege_an' }) });
    expect(await changerSieges(autre.d, T1, { depuis: 1, cible: 2 }, 'u1')).toMatchObject({ ok: false, statut: 409, details: { code: 'sieges_a_regler' } });
    const deux = deps({ sub: abonnement({ sieges: 1, autres: [{ id: 'si_siege2', quantity: 1, price: { id: 'price_siege_mois' } }] }) });
    expect(await changerSieges(deux.d, T1, { depuis: 2, cible: 3 }, 'u1')).toMatchObject({ ok: false, statut: 409, details: { code: 'sieges_a_regler' } });
    expect([...autre.transport.posts, ...deux.transport.posts]).toEqual([]);
  });

  it('un payeur refusé : 503, comme le Pro', async () => {
    const { d, transport } = deps({ autorise: false });
    expect(await changerSieges(d, T1, { depuis: 0, cible: 1 }, 'u1')).toMatchObject({ ok: false, statut: 503 });
    expect(transport.lus).toEqual([]);
  });
});

describe('retirer un utilisateur payé (un siège), sans remboursement', () => {
  it('🔴 refusé tant que les membres actifs ne tiennent pas dans 3 + la cible : personne n’est gelé par un retrait', async () => {
    const { d, transport } = deps({ sub: abonnement({ sieges: 2 }), membres: 5 });
    expect(await changerSieges(d, T1, { depuis: 2, cible: 1 }, 'u1')).toMatchObject({ ok: false, statut: 409, details: { code: 'membres_en_trop' } });
    expect(transport.posts).toEqual([]);
  });

  it('un membre parti : la quantité baisse sans prorata ni paiement ; à zéro, la ligne est supprimée', async () => {
    const un = deps({ sub: abonnement({ sieges: 2 }), membres: 4, reponses: [change(1)] });
    expect(await changerSieges(un.d, T1, { depuis: 2, cible: 1 }, 'u1')).toEqual({ ok: true, valeur: { sieges: 1 } });
    const p = un.transport.posts[0]!;
    expect(p.corps.get('items[0][id]')).toBe('si_siege');
    expect(p.corps.get('items[0][quantity]')).toBe('1');
    expect(p.corps.get('proration_behavior')).toBe('none');
    expect(p.corps.has('payment_behavior')).toBe(false);
    expect(un.notes).toEqual([['sub_pro1', 1]]);

    const zero = deps({ sub: abonnement({ sieges: 1 }), membres: 3, reponses: [change(0)] });
    expect(await changerSieges(zero.d, T1, { depuis: 1, cible: 0 }, 'u1')).toEqual({ ok: true, valeur: { sieges: 0 } });
    expect(zero.transport.posts[0]!.corps.get('items[0][deleted]')).toBe('true');
    expect(zero.transport.posts[0]!.corps.has('items[0][quantity]')).toBe(false);
  });
});

describe('les sièges relus chez Stripe pour le webhook', () => {
  it('🔴 la somme des lignes de siège, quelle que soit leur formule ; la ligne du Pro ne compte pas', async () => {
    const { d } = deps({ sub: abonnement({ sieges: 2, autres: [{ id: 'si_siege2', quantity: 1, price: { id: 'price_siege_an' } }] }) });
    expect(await siegesChezStripe(d, 'sub_pro1')).toBe(3);
  });

  it('🔴 un refus DURABLE de Stripe (4xx, réponse illisible) : journalisé, Julien prévenu, `null` pour ne pas bloquer la mise à jour du Pro', async () => {
    const { d, alertes } = deps({ sub: { id: 'sub_pro1', status: 'active' } });
    expect(await siegesChezStripe(d, 'sub_pro1')).toBeNull();
    expect(alertes[0]).toMatch(/sub_pro1/);
    const inconnu = deps();
    expect(await siegesChezStripe(inconnu.d, 'sub_inconnu')).toBeNull();
  });

  it('une panne passagère (réseau, 5xx, 429) lève : le webhook échoue et Stripe rejouera', async () => {
    const { d } = deps();
    const panne: TransportStripe = {
      post: async () => { throw new Error('non prévu'); }, delete: async () => { throw new Error('non prévu'); },
      get: async () => ({ status: 503, json: { error: { message: 'indisponible' } } }),
    };
    await expect(siegesChezStripe({ ...d, stripe: { ...d.stripe!, transport: panne } }, 'sub_pro1')).rejects.toThrow();
    const reseau: TransportStripe = { ...panne, get: async () => { throw new Error('ECONNRESET'); } };
    await expect(siegesChezStripe({ ...d, stripe: { ...d.stripe!, transport: reseau } }, 'sub_pro1')).rejects.toThrow();
  });

  it('les sièges pas en vente : rien à relire, `null`, aucun appel', async () => {
    const { d, transport } = deps({ prixVides: true });
    expect(await siegesChezStripe(d, 'sub_pro1')).toBeNull();
    expect(transport.lus).toEqual([]);
  });
});
