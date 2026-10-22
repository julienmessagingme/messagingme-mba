import { describe, it, expect } from 'vitest';
import {
  activerSelonStatut, PIED_STOP, preparerMessage, reglerMessage, relireAttentes, TEXTES_PROPOSES, versCorps,
  type DepsActivation, type DepsPreparation,
} from '../src/shopify/preparation';
import type { CreateTemplateInput } from '../src/meta/templates';
import type { AttenteMessage, MessageBranche, VueBoutique } from '../src/shopify/store.pg';
import type { Emission } from '../src/emails-produit/emission';
import { EVENEMENTS_SHOPIFY } from '../src/shopify/donnees';

/**
 * L'ASSISTANT DES MESSAGES SHOPIFY DE LA CONSOLE (conception 2026-10-22) : un texte devient un modèle chez Meta, puis le
 * message s'active seul à l'approbation.
 *
 * 🔴 Ce qui se joue : une relance de panier (marketing) ne se prépare jamais sans consentement affirmé et ne s'active
 * jamais avant l'approbation ; le message actif n'est jamais touché par une préparation ni par un refus de Meta.
 */

const T = 't1';
const VUE: VueBoutique = {
  domaine: 'b.myshopify.com', nom: 'Essai', pays: 'FR', devise: 'EUR', etat: 'connectee', motifCoupure: null, coupeeLe: null,
  connecteeLe: '2026-10-22T00:00:00.000Z', dernierEvenementLe: null, consentement: null, delaiPanierMinutes: 60, origine: 'console',
};
const AFFIRMEE: VueBoutique = { ...VUE, consentement: { par: 'u1', le: '2026-10-22T00:00:00.000Z' } };

function monter(o: { boutique?: VueBoutique | null; creation?: { ok: true; statut: string; categorie: string } | { ok: false; message: string }; actif?: MessageBranche | null } = {}) {
  const journal = {
    modeles: [] as CreateTemplateInput[], branches: [] as unknown[], attentes: [] as unknown[], retraits: [] as unknown[],
    affirmations: [] as Array<string | null>, retraitsConsentement: 0, delais: [] as number[],
  };
  const deps: DepsPreparation = {
    store: {
      lire: async () => (o.boutique === undefined ? VUE : o.boutique),
      brancher: async (_t, m) => { journal.branches.push(m); },
      poserAttente: async (_t, a) => { journal.attentes.push(a); },
      retirerAttente: async (_t, c) => { journal.retraits.push(c); return null; },
      affirmerConsentement: async (_t, par) => { journal.affirmations.push(par); },
      retirerConsentement: async () => { journal.retraitsConsentement += 1; },
      reglerDelaiPanier: async (_t, m) => { journal.delais.push(m); },
      message: async () => o.actif ?? null,
    },
    creerModele: async (_t, input) => { journal.modeles.push(input); return o.creation ?? { ok: true, statut: 'pending', categorie: input.category.toLowerCase() }; },
    maintenant: () => 1_000_000,
  };
  return { deps, journal };
}

describe('le texte de l’assistant devient un corps de modèle', () => {
  it('chaque repère devient {{1}}, {{2}}... dans l’ordre, et les variables suivent le même ordre', () => {
    expect(versCorps('order_paid', 'Bonjour {{first_name}}, commande {{order_number}} : {{ order_status_url }} merci')).toEqual({
      ok: true, corps: 'Bonjour {{1}}, commande {{2}} : {{3}} merci', variables: ['first_name', 'order_number', 'order_status_url'],
      exemples: ['Camille', '#1002', 'https://ma-boutique.myshopify.com/commandes/1002'],
    });
  });

  it('un repère inconnu, ou d’un autre événement, est refusé et nommé ; un corps qui commence ou finit par une donnée aussi', () => {
    expect(versCorps('order_paid', 'Bonjour {{prenom}} merci')).toMatchObject({ ok: false, message: expect.stringContaining('{{prenom}}') });
    expect(versCorps('order_paid', 'Votre panier {{checkout_url}} merci')).toMatchObject({ ok: false, message: expect.stringContaining('{{checkout_url}}') });
    expect(versCorps('checkout_abandoned', '{{first_name}}, votre panier attend')).toMatchObject({ ok: false });
    expect(versCorps('checkout_abandoned', 'Votre panier : {{checkout_url}}')).toMatchObject({ ok: false });
    expect(versCorps('order_paid', '  ')).toMatchObject({ ok: false });
  });

  it('les textes proposés sont acceptés tels quels, dans les deux langues', () => {
    for (const e of EVENEMENTS_SHOPIFY) for (const l of ['fr', 'en'] as const) expect(versCorps(e, TEXTES_PROPOSES[e][l]).ok, `${e} ${l}`).toBe(true);
  });
});

describe('préparer un message', () => {
  it('🔴 une relance sans consentement affirmé est refusée, et rien n’est créé chez Meta', async () => {
    const { deps, journal } = monter();
    const r = await preparerMessage(deps, T, { evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr' }, 'u1');
    expect(r).toMatchObject({ ok: false, statut: 409 });
    expect(journal.modeles).toEqual([]);
  });

  it('une relance : modèle marketing, pied STOP, consentement affirmé dans l’appel ; en validation, l’attente porte le délai', async () => {
    const { deps, journal } = monter();
    const r = await preparerMessage(deps, T, {
      evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr', delaiMinutes: 15, consentementAffirme: true,
    }, 'u1');
    expect(r).toEqual({ ok: true, valeur: { etat: 'en_validation', modele: `shopify_checkout_abandoned_${(1_000_000).toString(36)}` } });
    expect(journal.affirmations).toEqual(['u1']);
    expect(journal.modeles[0]).toMatchObject({ category: 'MARKETING', language: 'fr', footer: PIED_STOP.fr, example: ['Camille', 'https://ma-boutique.myshopify.com/checkouts/recover'] });
    expect(journal.attentes).toEqual([{ evenement: 'checkout_abandoned', modele: 'shopify_checkout_abandoned_lfls', langue: 'fr', variables: ['first_name', 'checkout_url'], delaiMinutes: 15, par: 'u1' }]);
    // 🔴 Le message actif n'est pas touché : il part jusqu'à l'approbation du nouveau.
    expect(journal.branches).toEqual([]);
  });

  it('un message de commande : modèle de service, sans pied STOP, sans consentement exigé', async () => {
    const { deps, journal } = monter();
    await preparerMessage(deps, T, { evenement: 'order_paid', texte: TEXTES_PROPOSES.order_paid.en, langue: 'en_US' }, 'u1');
    expect(journal.modeles[0]).toMatchObject({ category: 'UTILITY', language: 'en_US' });
    expect(journal.modeles[0]).not.toHaveProperty('footer');
  });

  it('approuvé tout de suite : branché, délai posé, attente retirée', async () => {
    const { deps, journal } = monter({ boutique: AFFIRMEE, creation: { ok: true, statut: 'approved', categorie: 'marketing' } });
    const r = await preparerMessage(deps, T, { evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr', delaiMinutes: 30 }, 'u1');
    expect(r).toMatchObject({ ok: true, valeur: { etat: 'actif' } });
    expect(journal.branches).toMatchObject([{ evenement: 'checkout_abandoned', actif: true, variables: ['first_name', 'checkout_url'] }]);
    expect(journal.delais).toEqual([30]);
    expect(journal.attentes).toEqual([]);
  });

  it('🔴 un message de commande que Meta reclasse en marketing est refusé, sans attente', async () => {
    const { deps, journal } = monter({ creation: { ok: true, statut: 'pending', categorie: 'marketing' } });
    expect(await preparerMessage(deps, T, { evenement: 'order_fulfilled', texte: TEXTES_PROPOSES.order_fulfilled.fr, langue: 'fr' }, 'u1'))
      .toMatchObject({ ok: false, statut: 422 });
    expect(journal.attentes).toEqual([]);
  });

  it('les refus : langue, boutique absente ou coupée, délai hors bornes ou hors relance, refus de Meta', async () => {
    const texte = TEXTES_PROPOSES.order_paid.fr;
    expect(await preparerMessage(monter().deps, T, { evenement: 'order_paid', texte, langue: 'xx' }, null)).toMatchObject({ ok: false, statut: 400 });
    expect(await preparerMessage(monter({ boutique: null }).deps, T, { evenement: 'order_paid', texte, langue: 'fr' }, null)).toMatchObject({ ok: false, statut: 409 });
    expect(await preparerMessage(monter({ boutique: { ...VUE, etat: 'coupee' } }).deps, T, { evenement: 'order_paid', texte, langue: 'fr' }, null)).toMatchObject({ ok: false, statut: 409 });
    expect(await preparerMessage(monter().deps, T, { evenement: 'order_paid', texte, langue: 'fr', delaiMinutes: 60 }, null)).toMatchObject({ ok: false, statut: 400 });
    expect(await preparerMessage(monter({ boutique: AFFIRMEE }).deps, T, { evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr', delaiMinutes: 5 }, null))
      .toMatchObject({ ok: false, statut: 400 });
    expect(await preparerMessage(monter({ creation: { ok: false, message: 'nom déjà pris' } }).deps, T, { evenement: 'order_paid', texte, langue: 'fr' }, null))
      .toMatchObject({ ok: false, statut: 422, message: expect.stringContaining('nom déjà pris') });
  });
});

describe('régler un message sans repasser par Meta', () => {
  it('le délai seulement pour la relance ; retirer l’affirmation arrête une relance active, et le dit', async () => {
    const a = monter({ boutique: AFFIRMEE });
    expect(await reglerMessage(a.deps, T, { evenement: 'checkout_abandoned', delaiMinutes: 120 }, 'u1')).toEqual({ ok: true, valeur: { relanceArretee: false } });
    expect(a.journal.delais).toEqual([120]);
    expect(await reglerMessage(a.deps, T, { evenement: 'order_paid', delaiMinutes: 120 }, 'u1')).toMatchObject({ ok: false, statut: 400 });
    const relance: MessageBranche = { evenement: 'checkout_abandoned', modele: 'm', langue: 'fr', variables: [], actif: true, modifieLe: '' };
    const b = monter({ boutique: AFFIRMEE, actif: relance });
    expect(await reglerMessage(b.deps, T, { evenement: 'order_paid', consentementAffirme: false }, 'u1')).toEqual({ ok: true, valeur: { relanceArretee: true } });
    expect(b.journal.retraitsConsentement).toBe(1);
  });
});

describe('l’activation au statut tranché par Meta', () => {
  const ATTENTE: AttenteMessage = { evenement: 'checkout_abandoned', modele: 'shopify_checkout_abandoned_x', langue: 'fr', variables: ['first_name', 'checkout_url'], delaiMinutes: 15, creeLe: '' };
  function monterActivation(attente: AttenteMessage | null = ATTENTE) {
    const journal = { branches: [] as unknown[], emails: [] as Emission[], delais: [] as number[], retraits: [] as unknown[] };
    let restante = attente;
    const deps: DepsActivation = {
      store: {
        lire: async () => VUE,
        brancher: async (_t, m) => { journal.branches.push(m); },
        retirerAttente: async (_t, c) => {
          journal.retraits.push(c);
          if ('modele' in c) { const a = restante; restante = null; return a !== null && a.modele === c.modele && a.langue === c.langue ? a : null; }
          return null;
        },
        reglerDelaiPanier: async (_t, m) => { journal.delais.push(m); },
      },
      emails: { emettre: async (e) => { journal.emails.push(e); return {}; } },
      pageParametres: 'https://console.test/parametres',
    };
    return { deps, journal };
  }

  it('🔴 APPROVED active le message qui attend CE modèle, avec son délai, et prévient', async () => {
    const { deps, journal } = monterActivation();
    expect(await activerSelonStatut(deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'APPROVED', raison: null })).toBe('active');
    expect(journal.branches).toEqual([{ evenement: 'checkout_abandoned', modele: ATTENTE.modele, langue: 'fr', variables: ['first_name', 'checkout_url'], actif: true, par: null }]);
    expect(journal.delais).toEqual([15]);
    expect(journal.emails).toMatchObject([{ cle: 'shopify_message_actif', a: 'admins', valeurs: { boutique: 'b.myshopify.com', message: 'Relance de panier abandonné', lien_parametres: 'https://console.test/parametres' } }]);
  });

  it('🔴 REJECTED retire l’attente et prévient, sans rien brancher : le message actif reste', async () => {
    const { deps, journal } = monterActivation();
    expect(await activerSelonStatut(deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'REJECTED', raison: 'INVALID_FORMAT' })).toBe('refuse');
    expect(journal.branches).toEqual([]);
    expect(journal.emails).toMatchObject([{ cle: 'shopify_modele_refuse', valeurs: { raison: 'INVALID_FORMAT' } }]);
  });

  it('sans attente pour ce modèle (le dernier geste l’a retirée), un statut en cours ou un autre modèle : rien', async () => {
    const sans = monterActivation(null);
    expect(await activerSelonStatut(sans.deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'APPROVED', raison: null })).toBe('rien');
    expect(sans.journal.branches).toEqual([]);
    const enCours = monterActivation();
    expect(await activerSelonStatut(enCours.deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'PENDING', raison: null })).toBe('rien');
    expect(await activerSelonStatut(enCours.deps, T, { modele: 'promo_noel', langue: 'fr', statut: 'APPROVED', raison: null })).toBe('rien');
    expect(enCours.journal.retraits).toEqual([]);
  });

  it('le filet relit les attentes anciennes chez Meta ; un statut illisible est laissé pour la passe suivante', async () => {
    const { deps, journal } = monterActivation();
    const filet = {
      ...deps,
      store: { ...deps.store, attentesAnciennes: async () => [{ ...ATTENTE, tenantId: T }, { ...ATTENTE, modele: 'shopify_order_paid_y', tenantId: T }] },
      statutModele: async (_t: string, modele: string) => (modele === ATTENTE.modele ? { statut: 'APPROVED', raison: null } : null),
    };
    expect(await relireAttentes(filet, 10, 20)).toBe(1);
    expect(journal.branches).toHaveLength(1);
  });
});
