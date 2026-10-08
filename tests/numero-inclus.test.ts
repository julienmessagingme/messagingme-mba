import { describe, it, expect } from 'vitest';
import { surFinDuPro, surPassageEnPro, type DepsNumeroInclus, type FinDuPro } from '../src/offres/numero-inclus';
import type { ReponseStripe, TransportStripe } from '../src/stripe/client';
import type { AbonnementNumero } from '../src/stripe/abonnements.pg';

/**
 * LE NUMÉRO INCLUS DANS LE PRO (lot 6, livraison B2b, tâche 12). Au passage en Pro, l'abonnement du numéro seul s'arrête
 * avec un avoir au prorata ; à la fin du Pro, il est recréé sur la carte du Pro (résiliation), ou le numéro suit le chemin
 * du lot 4 (impayé, numéro rendu, échec de la création : décisions de Julien du 2026-10-07 et du 2026-10-08). Contre un
 * transport Stripe simulé : aucun appel ne part chez Stripe.
 */
const T = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';

class FauxStripe implements TransportStripe {
  readonly appels: Array<{ methode: 'POST' | 'DELETE'; url: string; corps: URLSearchParams; cle: string }> = [];
  constructor(private readonly reponses: ReponseStripe[]) {}
  private repondre(methode: 'POST' | 'DELETE', url: string, corps: string, entetes: Record<string, string>): ReponseStripe {
    this.appels.push({ methode, url, corps: new URLSearchParams(corps), cle: entetes['idempotency-key'] ?? '' });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    return r;
  }
  async post(url: string, corps: string, entetes: Record<string, string>) { return this.repondre('POST', url, corps, entetes); }
  async delete(url: string, corps: string, entetes: Record<string, string>) { return this.repondre('DELETE', url, corps, entetes); }
  async get(): Promise<ReponseStripe> { throw new Error('lecture non prévue'); }
}

const numeroSeul = (o: Partial<AbonnementNumero> = {}): AbonnementNumero => ({
  abonnementId: 'sub_NUM', tenantId: T, livemode: true, statut: 'actif', periodeFin: null, premierEchecLe: null,
  finPrevueLe: null, finiLe: null, libereLe: null, ...o,
});

function monter(o: { reponses?: ReponseStripe[]; numero?: AbonnementNumero | null; attribue?: boolean; stripe?: boolean; livemode?: boolean } = {}) {
  const transport = new FauxStripe(o.reponses ?? []);
  const journal: string[] = [];
  const alertes: string[] = [];
  const d: DepsNumeroInclus = {
    stripe: o.stripe === false ? null : { cle: 'rk_live_fausse', livemode: o.livemode ?? true, transport },
    prixNumero: 'price_numero',
    numero: {
      deLEspace: async () => (o.numero === undefined ? null : o.numero),
      numeroAttribue: async () => o.attribue ?? true,
      enregistrer: async (a) => { journal.push(`enregistre:${a.abonnementId}:${a.periodeFin?.toISOString() ?? '-'}`); return { etat: 'enregistre', numero: '33100000000' }; },
      oublierAvisDeSuspension: async (t) => { journal.push(`avis-oublies:${t}`); },
      porterLaFinParLePro: async (a) => { journal.push(`porte:${a.abonnementPro}:${a.finiLe.toISOString()}`); return true; },
    },
    reprendreCampagnes: async (t) => { journal.push(`campagnes:${t}`); },
    alerter: async (texte) => { alertes.push(texte); },
  };
  return { d, transport, journal, alertes };
}

describe('au passage en Pro', () => {
  it('🔴 un numéro seul vivant est arrêté chez Stripe avec un avoir ; les avis de suspension et les pauses sont levés (J5, J6)', async () => {
    const m = monter({ numero: numeroSeul(), reponses: [{ status: 200, json: { id: 'sub_NUM', status: 'canceled' } }] });
    await surPassageEnPro(m.d, T);
    expect(m.transport.appels).toMatchObject([{ methode: 'DELETE', url: 'https://api.stripe.com/v1/subscriptions/sub_NUM', cle: 'avoir-sub_NUM' }]);
    expect(Object.fromEntries(m.transport.appels[0]!.corps)).toEqual({ prorate: 'true', invoice_now: 'true' });
    expect(m.journal).toEqual([`avis-oublies:${T}`, `campagnes:${T}`]);
    expect(m.alertes).toEqual([]);
  });

  it('un numéro seul déjà fini, ou aucun : rien n’est demandé à Stripe, mais avis et pauses sont quand même levés', async () => {
    for (const numero of [null, numeroSeul({ statut: 'resilie', finiLe: new Date() })]) {
      const m = monter({ numero });
      await surPassageEnPro(m.d, T);
      expect(m.transport.appels).toEqual([]);
      expect(m.journal).toEqual([`avis-oublies:${T}`, `campagnes:${T}`]);
    }
  });

  it('🔴 Stripe refuse l’arrêt (clé sans le droit d’écrire, par exemple) : Julien est prévenu, rien ne lève', async () => {
    const m = monter({ numero: numeroSeul(), reponses: [{ status: 403, json: { error: { type: 'invalid_request_error', message: 'restricted' } } }] });
    await expect(surPassageEnPro(m.d, T)).resolves.toBeUndefined();
    expect(m.alertes).toHaveLength(1);
    expect(m.alertes[0]).toMatch(/sub_NUM/);
    expect(m.alertes[0]).toMatch(/avoir/);
  });

  it('sans Stripe, ou un numéro seul d’un autre mode que la clé : aucun appel, Julien prévenu', async () => {
    for (const o of [{ stripe: false }, { livemode: false }]) {
      const m = monter({ numero: numeroSeul(), ...o });
      await surPassageEnPro(m.d, T);
      expect(m.transport.appels).toEqual([]);
      expect(m.alertes).toHaveLength(1);
    }
  });
});

const FIN = new Date('2026-11-08T10:00:00Z');
const fin = (o: Partial<FinDuPro> = {}): FinDuPro => ({
  tenantId: T, abonnementPro: 'sub_PRO', livemode: true, raison: 'resiliation', finiLe: FIN, rendreNumero: false,
  // Le Pro finit à sa fin PRÉVUE, donc annoncée (console, Claude, e-mail) : le cas où le numéro seul se recrée.
  finPrevueLe: FIN, customerId: 'cus_A', carte: 'pm_PRO', ...o,
});
const CREE: ReponseStripe = { status: 200, json: { id: 'sub_NEUF', status: 'active', items: { data: [{ current_period_end: 1_800_000_000 }] } } };

describe('à la fin du Pro', () => {
  it('🔴 résilié, numéro gardé : le numéro seul est recréé sur la carte du Pro et enregistré tout de suite', async () => {
    const m = monter({ reponses: [CREE] });
    expect(await surFinDuPro(m.d, fin())).toBe('recree');
    expect(m.transport.appels).toHaveLength(1);
    const corps = Object.fromEntries(m.transport.appels[0]!.corps);
    expect(corps).toMatchObject({ customer: 'cus_A', 'items[0][price]': 'price_numero', default_payment_method: 'pm_PRO', 'metadata[tenant_id]': T });
    // Un rejeu de la fin (Stripe rejoue) retrouve le même abonnement, jamais un second.
    expect(m.transport.appels[0]!.cle).toBe('numero-apres-pro-sub_PRO');
    expect(m.journal).toEqual([`enregistre:sub_NEUF:${new Date(1_800_000_000 * 1000).toISOString()}`]);
  });

  it('🔴 impayé : rien chez Stripe, l’espace reçoit une ligne finie à la fin du Pro, et le lot 4 suspend puis libère', async () => {
    const m = monter();
    expect(await surFinDuPro(m.d, fin({ raison: 'impaye' }))).toBe('porte');
    expect(m.transport.appels).toEqual([]);
    expect(m.journal).toEqual([`porte:sub_PRO:${FIN.toISOString()}`]);
  });

  it('🔴 numéro rendu : rien chez Stripe, le même chemin (gardé 7 jours, puis libéré)', async () => {
    const m = monter();
    expect(await surFinDuPro(m.d, fin({ rendreNumero: true }))).toBe('porte');
    expect(m.transport.appels).toEqual([]);
    expect(m.journal).toEqual([`porte:sub_PRO:${FIN.toISOString()}`]);
  });

  it('🔴 la création échoue (carte refusée) : comme un impayé, et Julien est prévenu', async () => {
    const m = monter({ reponses: [{ status: 402, json: { error: { type: 'card_error', code: 'card_declined', message: 'declined' } } }] });
    expect(await surFinDuPro(m.d, fin())).toBe('porte');
    expect(m.journal).toEqual([`porte:sub_PRO:${FIN.toISOString()}`]);
    expect(m.alertes.join(' ')).toMatch(/card_declined|refus/);
  });

  it('sans carte sur le Pro, ou sans Stripe : comme un impayé, Julien prévenu, aucun appel', async () => {
    for (const o of [{ f: fin({ carte: null }) }, { f: fin(), stripe: false }]) {
      const m = monter({ stripe: o.stripe });
      expect(await surFinDuPro(m.d, o.f)).toBe('porte');
      expect(m.transport.appels).toEqual([]);
      expect(m.alertes).toHaveLength(1);
    }
  });

  it('🔴 R1 : un Pro arrêté TOUT DE SUITE (sans fin prévue, ou bien avant elle) ne recrée rien : rien n’a été annoncé', async () => {
    // Julien qui résilie à la main avant une suppression d'espace (RC8), ou à la demande d'un client : prélever le numéro
    // seul sur la carte d'un client qui part, sans annonce, serait de l'argent pris à tort.
    for (const finPrevueLe of [null, new Date(FIN.getTime() + 10 * 24 * 3_600_000)]) {
      const m = monter({ reponses: [CREE] });
      expect(await surFinDuPro(m.d, fin({ finPrevueLe }))).toBe('porte');
      expect(m.transport.appels).toEqual([]);
      expect(m.journal).toEqual([`porte:sub_PRO:${FIN.toISOString()}`]);
      expect(m.alertes.join(' ')).toMatch(/immédiate/);
    }
  });

  it('une fin à quelques heures de la fin prévue reste la fin prévue : le numéro seul se recrée', async () => {
    const m = monter({ reponses: [CREE] });
    expect(await surFinDuPro(m.d, fin({ finPrevueLe: new Date(FIN.getTime() + 3 * 3_600_000) }))).toBe('recree');
  });

  it('aucun numéro fourni attribué : rien à faire ; un numéro seul déjà vivant : il continue', async () => {
    const sans = monter({ attribue: false });
    expect(await surFinDuPro(sans.d, fin())).toBe('sans_numero');
    const deja = monter({ numero: numeroSeul() });
    expect(await surFinDuPro(deja.d, fin())).toBe('deja_abonne');
    expect([...sans.journal, ...deja.journal, ...sans.transport.appels, ...deja.transport.appels]).toEqual([]);
  });
});
