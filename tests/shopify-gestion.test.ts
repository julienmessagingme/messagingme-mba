import { describe, it, expect } from 'vitest';
import { brancherMessage, connecterShopify, couperShopify, etatShopify, type DepsGestionShopify } from '../src/shopify/gestion';
import type { LectureModele } from '../src/api/modele-envoi';
import type { MessageBranche, VueBoutique } from '../src/shopify/store.pg';
import { OUTILS } from '../src/mcp/outils';

/**
 * LA GESTION DU CONNECTEUR SHOPIFY (plan 2026-10-21, lot 1), porte unique des outils MCP et de la console. Chaque refus
 * dit le geste qui le règle ; aucun secret n'est gardé sans que Shopify ait accepté la connexion.
 */

const T = 't1';
const VUE: VueBoutique = {
  domaine: 'b.myshopify.com', nom: 'Essai', pays: 'FR', devise: 'EUR', etat: 'connectee', motifCoupure: null, coupeeLe: null,
  connecteeLe: '2026-10-21T00:00:00.000Z', dernierEvenementLe: null, consentement: null, delaiPanierMinutes: 60,
};

function monter(o: { boutique?: VueBoutique | null; modele?: LectureModele; ailleurs?: boolean; verif?: Awaited<ReturnType<DepsGestionShopify['verifier']>> } = {}) {
  let boutique: VueBoutique | null = o.boutique === undefined ? VUE : o.boutique;
  const journal = { connexions: [] as unknown[], branches: [] as unknown[], consentements: [] as Array<string | null>, retraits: 0, coupes: 0, verifs: 0, delais: [] as number[] };
  const messages: MessageBranche[] = [];
  const deps: DepsGestionShopify = {
    store: {
      lire: async () => boutique,
      connecter: async (_t, c) => { journal.connexions.push(c); if (o.ailleurs) return 'boutique_ailleurs'; boutique = { ...VUE, domaine: c.domaine }; return 'ok'; },
      couper: async () => { journal.coupes += 1; const deja = boutique?.etat === 'coupee'; if (boutique) boutique = { ...boutique, etat: 'coupee' }; return !deja; },
      messages: async () => messages,
      brancher: async (_t, m) => { journal.branches.push(m); },
      affirmerConsentement: async (_t, par) => { journal.consentements.push(par); },
      retirerConsentement: async () => { journal.retraits += 1; },
      compteurs: async () => ({ envoye: 3 }),
      reglerDelaiPanier: async (_t, m) => { journal.delais.push(m); },
      compteursPaniers: async () => ({ relances: { envoye: 1 }, fermesATemps: 2, enAttente: 3 }),
    },
    verifier: async () => { journal.verifs += 1; return o.verif ?? { ok: true, nom: 'Essai', pays: 'FR', devise: 'EUR' }; },
    lireModele: async () => o.modele ?? { statut: 'approuve', categorie: 'utility', variables: 2 },
    chiffrementPret: true,
  };
  return { deps, journal };
}

describe('connecter une boutique', () => {
  it('vérifie chez Shopify, puis garde la boutique ; le domaine se normalise', async () => {
    const { deps, journal } = monter({ boutique: null });
    const r = await connecterShopify(deps, T, { boutique: 'B.myshopify.com', clientId: 'cid', secret: 'shpss_x' }, 'u1');
    expect(r.ok).toBe(true);
    expect(journal.connexions).toEqual([{ domaine: 'b.myshopify.com', clientId: 'cid', secretClair: 'shpss_x', nom: 'Essai', pays: 'FR', devise: 'EUR', par: 'u1' }]);
  });

  it('🔴 un refus de Shopify ne garde rien ; une saisie mal formée ne va même pas chez Shopify', async () => {
    const refusee = monter({ verif: { ok: false, code: 'app_non_installee', message: 'cliquez Installer' } });
    expect(await connecterShopify(refusee.deps, T, { boutique: 'b.myshopify.com', clientId: 'cid', secret: 's' }, null)).toEqual({ ok: false, statut: 422, message: 'cliquez Installer' });
    expect(refusee.journal.connexions).toEqual([]);
    const passagere = monter({ verif: { ok: false, code: 'passager', message: 'réessayez' } });
    expect(await connecterShopify(passagere.deps, T, { boutique: 'b.myshopify.com', clientId: 'cid', secret: 's' }, null)).toMatchObject({ ok: false, statut: 503 });
    const malFormee = monter();
    for (const s of [{ boutique: 'evil.com', clientId: 'cid', secret: 's' }, { boutique: 'b', clientId: 'c id', secret: 's' }, { boutique: 'b', clientId: 'cid', secret: '' }]) {
      expect(await connecterShopify(malFormee.deps, T, s, null)).toMatchObject({ ok: false, statut: 400 });
    }
    expect(malFormee.journal.verifs).toBe(0);
  });

  it('une boutique tenue par un autre espace : 409, avec la phrase', async () => {
    const { deps } = monter({ ailleurs: true });
    expect(await connecterShopify(deps, T, { boutique: 'b.myshopify.com', clientId: 'cid', secret: 's' }, null)).toMatchObject({ ok: false, statut: 409 });
  });
});

describe('brancher un message', () => {
  const branchement = { evenement: 'order_paid', modele: 'commande_payee', langue: 'fr', variables: ['first_name', 'order_number'], actif: true, consentementAffirme: undefined };

  it('un modèle utility approuvé, autant de variables que lui : branché, et le consentement noté s’il est affirmé', async () => {
    const { deps, journal } = monter();
    expect((await brancherMessage(deps, T, { ...branchement, consentementAffirme: true }, 'u1')).ok).toBe(true);
    expect(journal.branches).toEqual([{ evenement: 'order_paid', modele: 'commande_payee', langue: 'fr', variables: ['first_name', 'order_number'], actif: true, par: 'u1' }]);
    expect(journal.consentements).toEqual(['u1']);
  });

  it('🔴 customers_consented : vrai affirme, FAUX RETIRE l’affirmation, absent ne change rien', async () => {
    const vrai = monter();
    await brancherMessage(vrai.deps, T, { ...branchement, consentementAffirme: true }, 'u1');
    expect([vrai.journal.consentements, vrai.journal.retraits]).toEqual([['u1'], 0]);
    const faux = monter();
    expect((await brancherMessage(faux.deps, T, { ...branchement, consentementAffirme: false }, 'u1')).ok).toBe(true);
    expect([faux.journal.consentements, faux.journal.retraits]).toEqual([[], 1]);
    const absent = monter();
    await brancherMessage(absent.deps, T, branchement, 'u1');
    expect([absent.journal.consentements, absent.journal.retraits]).toEqual([[], 0]);
  });

  it('🔴 refusé : modèle marketing, non approuvé, ou dont le nombre de variables diffère', async () => {
    for (const modele of [
      { statut: 'approuve', categorie: 'marketing', variables: 2 }, { statut: 'absent' }, { statut: 'approuve', categorie: 'utility', variables: 3 },
    ] as LectureModele[]) {
      const { deps, journal } = monter({ modele });
      expect(await brancherMessage(deps, T, branchement, null)).toMatchObject({ ok: false, statut: 422 });
      expect(journal.branches).toEqual([]);
    }
  });

  it('🔴 refusé : une donnée que l’événement ne porte pas, une boutique absente ou coupée', async () => {
    const { deps } = monter();
    expect(await brancherMessage(deps, T, { ...branchement, variables: ['tracking_url'] }, null)).toMatchObject({ ok: false, statut: 400 });
    expect(await brancherMessage(monter({ boutique: null }).deps, T, branchement, null)).toMatchObject({ ok: false, statut: 409 });
    expect(await brancherMessage(monter({ boutique: { ...VUE, etat: 'coupee' } }).deps, T, branchement, null)).toMatchObject({ ok: false, statut: 409 });
  });

  it('éteindre un message ne relit pas le modèle chez Meta', async () => {
    const { deps, journal } = monter({ modele: { statut: 'absent' } });
    expect((await brancherMessage(deps, T, { ...branchement, actif: false }, null)).ok).toBe(true);
    expect(journal.branches).toHaveLength(1);
  });
});

describe('la relance de panier (lot 2)', () => {
  const panier = { evenement: 'checkout_abandoned', modele: 'relance', langue: 'fr', variables: ['first_name', 'checkout_url'], actif: true, consentementAffirme: undefined };
  const marketing: LectureModele = { statut: 'approuve', categorie: 'marketing', variables: 2 };

  it('🔴 elle ne s’active pas sans consentement affirmé, ni dans l’appel ni avant', async () => {
    const { deps, journal } = monter({ modele: marketing });
    expect(await brancherMessage(deps, T, panier, null)).toMatchObject({ ok: false, statut: 409 });
    expect(journal.branches).toEqual([]);
    // Affirmé dans l’appel : branchée, consentement noté.
    expect((await brancherMessage(deps, T, { ...panier, consentementAffirme: true }, 'u1')).ok).toBe(true);
    expect(journal.consentements).toEqual(['u1']);
  });

  it('affirmé avant : branchée sans le redire ; retiré dans le même appel : refusée', async () => {
    const avant = monter({ modele: marketing, boutique: { ...VUE, consentement: { par: 'u1', le: '2026-10-21T00:00:00.000Z' } } });
    expect((await brancherMessage(avant.deps, T, panier, null)).ok).toBe(true);
    expect(await brancherMessage(avant.deps, T, { ...panier, consentementAffirme: false }, null)).toMatchObject({ ok: false, statut: 409 });
  });

  it('un modèle marketing est admis pour le panier, et le délai se règle dans ses bornes', async () => {
    const { deps, journal } = monter({ modele: marketing });
    expect((await brancherMessage(deps, T, { ...panier, consentementAffirme: true, delaiMinutes: 30 }, null)).ok).toBe(true);
    expect(journal.delais).toEqual([30]);
    for (const delaiMinutes of [14, 4321, 30.5, '60']) {
      expect(await brancherMessage(deps, T, { ...panier, consentementAffirme: true, delaiMinutes }, null)).toMatchObject({ ok: false, statut: 400 });
    }
    const commande = { evenement: 'order_paid', modele: 'commande_payee', langue: 'fr', variables: [], actif: true, consentementAffirme: undefined };
    expect(await brancherMessage(deps, T, { ...commande, delaiMinutes: 30 }, null)).toMatchObject({ ok: false, statut: 400 });
  });

  it('éteindre la relance n’exige rien', async () => {
    const { deps } = monter({ modele: marketing });
    expect((await brancherMessage(deps, T, { ...panier, actif: false }, null)).ok).toBe(true);
  });
});

describe('l’état et la coupure', () => {
  it('l’état porte les chiffres des 30 jours et la page des apps de la boutique', async () => {
    const e = await etatShopify(monter().deps, T);
    expect(e.compteurs).toEqual({ envoye: 3 });
    expect(e.pageApps).toBe('https://admin.shopify.com/store/b/settings/apps');
    expect(await etatShopify(monter({ boutique: null }).deps, T)).toEqual({ boutique: null, messages: [], compteurs: {}, paniers: { relances: {}, fermesATemps: 0, enAttente: 0 }, pageApps: null });
  });

  it('couper est idempotent et rend la page d’où désinstaller l’app', async () => {
    const { deps } = monter();
    expect(await couperShopify(deps, T)).toEqual({ ok: true, valeur: { dejaCoupee: false, pageApps: 'https://admin.shopify.com/store/b/settings/apps' } });
    expect(await couperShopify(deps, T)).toMatchObject({ ok: true, valeur: { dejaCoupee: true } });
  });
});

describe('les outils MCP du connecteur', () => {
  it('🔴 les quatre exigent une personne nommée et sont ouverts à toutes les offres', () => {
    for (const nom of ['connect_shopify', 'set_shopify_message', 'get_shopify_state', 'disconnect_shopify']) {
      const o = OUTILS.find((x) => x.nom === nom);
      expect(o, nom).toBeDefined();
      expect(o!.exigePersonne, nom).toBe(true);
      expect(o!.fonction, nom).toBeNull();
    }
  });

  it('le schéma annoncé porte les bornes que la gestion applique (événements du lot, données permises)', () => {
    const o = OUTILS.find((x) => x.nom === 'set_shopify_message')!;
    expect(o.entree.properties.event!.enum).toEqual(['order_paid', 'order_fulfilled', 'checkout_abandoned']);
    expect(o.entree.properties.variables!.maxItems).toBe(10);
    expect(o.entree.properties.variables!.items!.enum).toContain('checkout_url');
    expect([o.entree.properties.delay_minutes!.minimum, o.entree.properties.delay_minutes!.maximum]).toEqual([15, 4320]);
  });
});
