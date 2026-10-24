import { describe, it, expect } from 'vitest';
import {
  apercuImportClients, brancherMessage, CLIENTS_LUS_MAX, connecterShopify, couperShopify, etatShopify, IMPORT_MAX, importerClients,
  type DepsGestionShopify,
} from '../src/shopify/gestion';
import type { ClientAbonne, LectureClients } from '../src/shopify/clients';
import type { IssueJeton } from '../src/shopify/connexion';
import type { ImportInput } from '../src/crm/import';
import { LimiteOffreError } from '../src/offres/refus';
import type { LectureModele } from '../src/api/modele-envoi';
import type { AccesBoutique, AttenteMessage, MessageBranche, VueBoutique } from '../src/shopify/store.pg';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import type { Filiere } from '../src/application/comptes';
import { TEXTE_SHOPIFY_MAX, validerTexteShopify } from '../src/shopify/preparation';
import { MESSAGE_OPERATIONS_LOURDES } from '../src/auth/plafond-partage';

/**
 * LA GESTION DU CONNECTEUR SHOPIFY (plan 2026-10-21, lot 1), porte unique des outils MCP et de la console. Chaque refus
 * dit le geste qui le règle ; aucun secret n'est gardé sans que Shopify ait accepté la connexion.
 */

const T = 't1';
const VUE: VueBoutique = {
  domaine: 'b.myshopify.com', nom: 'Essai', pays: 'FR', devise: 'EUR', etat: 'connectee', motifCoupure: null, coupeeLe: null,
  connecteeLe: '2026-10-21T00:00:00.000Z', dernierEvenementLe: null, consentement: null, delaiPanierMinutes: 60, origine: 'claude_code',
};

function monter(o: {
  boutique?: VueBoutique | null; modele?: LectureModele; ailleurs?: boolean; verif?: Awaited<ReturnType<DepsGestionShopify['verifier']>>;
  jeton?: Awaited<ReturnType<DepsGestionShopify['jeton']>>; abonnement?: Awaited<ReturnType<DepsGestionShopify['abonner']>>;
  acces?: Awaited<ReturnType<DepsGestionShopify['store']['acces']>>;
  actifs?: MessageBranche[]; attenteRetiree?: AttenteMessage; filiere?: Filiere | null;
} = {}) {
  let boutique: VueBoutique | null = o.boutique === undefined ? VUE : o.boutique;
  const journal = { connexions: [] as unknown[], branches: [] as unknown[], consentements: [] as Array<string | null>, retraits: 0, coupes: 0, verifs: 0, delais: [] as number[], attentesRetirees: [] as unknown[], abonnements: [] as unknown[], lecturesModele: 0 };
  const messages: MessageBranche[] = [...(o.actifs ?? [])];
  let attenteRetiree = o.attenteRetiree ?? null;
  const programmes: string[] = [];
  const deps: DepsGestionShopify = {
    store: {
      lire: async () => boutique,
      connecter: async (_t, c) => { journal.connexions.push(c); if (o.ailleurs) return 'boutique_ailleurs'; boutique = { ...VUE, domaine: c.domaine }; return 'ok'; },
      couper: async () => { journal.coupes += 1; const deja = boutique?.etat === 'coupee'; if (boutique) boutique = { ...boutique, etat: 'coupee' }; return !deja; },
      messages: async () => messages,
      // Comme le vrai store : brancher REMPLACE le message de l'événement.
      brancher: async (_t, m) => {
        journal.branches.push(m);
        const i = messages.findIndex((x) => x.evenement === m.evenement);
        const ligne: MessageBranche = { evenement: m.evenement, modele: m.modele, texte: m.texte, langue: m.langue, variables: m.variables, actif: m.actif, modifieLe: '' };
        if (i >= 0) messages[i] = ligne; else messages.push(ligne);
      },
      affirmerConsentement: async (_t, par) => { journal.consentements.push(par); },
      retirerConsentement: async () => { journal.retraits += 1; },
      compteurs: async () => ({ envoye: 3 }),
      reglerDelaiPanier: async (_t, m) => { journal.delais.push(m); },
      compteursPaniers: async () => ({ relances: { envoye: 1 }, fermesATemps: 2, enAttente: 3 }),
      acces: async () => o.acces ?? null,
      attentes: async () => [],
      retirerAttente: async (_t, cible) => { journal.attentesRetirees.push(cible); const a = attenteRetiree; attenteRetiree = null; return a; },
    },
    verifier: async () => { journal.verifs += 1; return o.verif ?? { ok: true, nom: 'Essai', pays: 'FR', devise: 'EUR' }; },
    lireModele: async () => { journal.lecturesModele += 1; return o.modele ?? { statut: 'approuve', categorie: 'utility', variables: 2 }; },
    chiffrementPret: true,
    jeton: async () => o.jeton ?? { ok: true, jeton: 'jeton-de-test' },
    lireClients: async () => { throw new Error('lireClients : hors de ce test'); },
    places: async () => { throw new Error('places : hors de ce test'); },
    importer: async () => { throw new Error('importer : hors de ce test'); },
    abonner: async (acces) => { journal.abonnements.push(acces); return o.abonnement ?? { ok: true, abonnes: ['ORDERS_PAID'], deja: [] }; },
    programmerOubli: async (job) => { programmes.push(job.modele); },
    // La filière API par défaut : tous les tests d'avant le texte simple (plan 2026-10-23) restent ceux de l'API.
    filiere: async () => (o.filiere === undefined ? 'api' : o.filiere),
  };
  return { deps, journal, programmes };
}

describe('connecter une boutique', () => {
  it('vérifie chez Shopify, puis garde la boutique ; le domaine se normalise', async () => {
    const { deps, journal } = monter({ boutique: null });
    const r = await connecterShopify(deps, T, { boutique: 'B.myshopify.com', clientId: 'cid', secret: 'shpss_x' }, 'u1', 'claude_code');
    expect(r.ok).toBe(true);
    expect(journal.connexions).toEqual([{ domaine: 'b.myshopify.com', clientId: 'cid', secretClair: 'shpss_x', nom: 'Essai', pays: 'FR', devise: 'EUR', par: 'u1', origine: 'claude_code' }]);
    // Claude Code : les webhooks sont dans l'app de la CLI, rien ne s'abonne par l'API.
    expect(journal.abonnements).toEqual([]);
  });

  it('🔴 un refus de Shopify ne garde rien ; une saisie mal formée ne va même pas chez Shopify', async () => {
    const refusee = monter({ verif: { ok: false, code: 'app_non_installee', message: 'cliquez Installer' } });
    expect(await connecterShopify(refusee.deps, T, { boutique: 'b.myshopify.com', clientId: 'cid', secret: 's' }, null, 'claude_code')).toEqual({ ok: false, statut: 422, message: 'cliquez Installer' });
    expect(refusee.journal.connexions).toEqual([]);
    const passagere = monter({ verif: { ok: false, code: 'passager', message: 'réessayez' } });
    expect(await connecterShopify(passagere.deps, T, { boutique: 'b.myshopify.com', clientId: 'cid', secret: 's' }, null, 'claude_code')).toMatchObject({ ok: false, statut: 503 });
    const malFormee = monter();
    for (const s of [{ boutique: 'evil.com', clientId: 'cid', secret: 's' }, { boutique: 'b', clientId: 'c id', secret: 's' }, { boutique: 'b', clientId: 'cid', secret: '' }]) {
      expect(await connecterShopify(malFormee.deps, T, s, null, 'claude_code')).toMatchObject({ ok: false, statut: 400 });
    }
    expect(malFormee.journal.verifs).toBe(0);
  });

  it('une boutique tenue par un autre espace : 409, avec la phrase', async () => {
    const { deps } = monter({ ailleurs: true });
    expect(await connecterShopify(deps, T, { boutique: 'b.myshopify.com', clientId: 'cid', secret: 's' }, null, 'claude_code')).toMatchObject({ ok: false, statut: 409 });
  });
});

describe('brancher une boutique depuis la console (conception 2026-10-22)', () => {
  it('🔴 origine console : les six webhooks s’abonnent par l’API avec le jeton de l’app, et l’origine est gardée', async () => {
    const { deps, journal } = monter({ boutique: null });
    const r = await connecterShopify(deps, T, { boutique: 'b.myshopify.com', clientId: ' cid ', secret: 'shpss_x\n' }, 'u1', 'console');
    expect(r.ok).toBe(true);
    // Les clés collées depuis la page de Shopify sont nettoyées avant la vérification.
    expect(journal.connexions).toMatchObject([{ clientId: 'cid', secretClair: 'shpss_x', origine: 'console' }]);
    expect(journal.abonnements).toEqual([{ domaine: 'b.myshopify.com', jeton: 'jeton-de-test' }]);
  });

  it('🔴 la boutique de Claude Code rebranchée depuis la console avec les clés de SON app reste claude_code, sans abonnement', async () => {
    const cli = { domaine: 'b.myshopify.com', clientId: 'cid', secret: 'shpss_x', pays: 'FR', etat: 'coupee' as const, origine: 'claude_code' as const };
    const meme = monter({ boutique: null, acces: cli });
    expect((await connecterShopify(meme.deps, T, { boutique: 'b.myshopify.com', clientId: 'cid', secret: 'shpss_x' }, 'u1', 'console')).ok).toBe(true);
    expect(meme.journal.connexions).toMatchObject([{ origine: 'claude_code' }]);
    expect(meme.journal.abonnements).toEqual([]);
    // Une AUTRE app (créée à la main) fait d'elle une boutique de la console, abonnée par l'API.
    const autre = monter({ boutique: null, acces: cli });
    expect((await connecterShopify(autre.deps, T, { boutique: 'b.myshopify.com', clientId: 'cid-console', secret: 'shpss_y' }, 'u1', 'console')).ok).toBe(true);
    expect(autre.journal.connexions).toMatchObject([{ origine: 'console' }]);
    expect(autre.journal.abonnements).toHaveLength(1);
  });

  it('un abonnement qui échoue rend 503 et le dit : la boutique reste branchée, un nouvel essai est idempotent', async () => {
    const { deps, journal } = monter({ boutique: null, abonnement: { ok: false, message: 'Shopify refuse (ORDERS_PAID).' } });
    const r = await connecterShopify(deps, T, { boutique: 'b.myshopify.com', clientId: 'cid', secret: 'shpss_x' }, 'u1', 'console');
    expect(r).toMatchObject({ ok: false, statut: 503, message: expect.stringContaining('ORDERS_PAID') });
    expect(journal.connexions).toHaveLength(1);
    const sansJeton = monter({ boutique: null, jeton: { ok: false, code: 'app_non_installee', message: 'Installez l’app.' } });
    expect(await connecterShopify(sansJeton.deps, T, { boutique: 'b.myshopify.com', clientId: 'cid', secret: 'shpss_x' }, 'u1', 'console'))
      .toMatchObject({ ok: false, statut: 422, message: 'Installez l’app.' });
    expect(sansJeton.journal.abonnements).toEqual([]);
  });
});

describe('brancher un message', () => {
  const branchement = { evenement: 'order_paid', modele: 'commande_payee', texte: undefined, langue: 'fr', variables: ['first_name', 'order_number'], actif: true, consentementAffirme: undefined };

  it('un modèle utility approuvé, autant de variables que lui : branché, et le consentement noté s’il est affirmé', async () => {
    const { deps, journal } = monter();
    expect((await brancherMessage(deps, T, { ...branchement, consentementAffirme: true }, 'u1')).ok).toBe(true);
    expect(journal.branches).toEqual([{ evenement: 'order_paid', modele: 'commande_payee', texte: null, langue: 'fr', variables: ['first_name', 'order_number'], actif: true, par: 'u1' }]);
    expect(journal.consentements).toEqual(['u1']);
    // Le dernier geste gagne : un message préparé par la console pour cet événement ne le remplacera pas.
    expect(journal.attentesRetirees).toEqual([{ evenement: 'order_paid' }]);
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

describe('le ménage des modèles remplacés (2026-10-23)', () => {
  // Des noms de l'assistant : son horodatage en base 36, après sa mise en service.
  const ASSISTANT = `shopify_order_paid_${Date.UTC(2026, 9, 22, 9).toString(36)}`;
  const attente: AttenteMessage = { evenement: 'order_paid', modele: `shopify_order_paid_${Date.UTC(2026, 9, 22, 10).toString(36)}`, langue: 'fr', variables: ['first_name'], delaiMinutes: null, creeLe: '' };
  const branchement = { evenement: 'order_paid', modele: 'commande_payee', texte: undefined, langue: 'fr', variables: ['first_name', 'order_number'], actif: true, consentementAffirme: undefined };
  const actif = (modele: string): MessageBranche => ({ evenement: 'order_paid', modele, texte: null, langue: 'fr', variables: ['first_name', 'order_number'], actif: true, modifieLe: '' });

  it('🔴 Claude Code branche par-dessus un message de l’assistant : l’oubli de l’ancien modèle et de l’attente retirée est programmé', async () => {
    const { deps, programmes } = monter({ actifs: [actif(ASSISTANT)], attenteRetiree: attente });
    expect((await brancherMessage(deps, T, branchement, null)).ok).toBe(true);
    expect(programmes.sort()).toEqual([ASSISTANT, attente.modele].sort());
  });

  it('🔴 un modèle nommé par le marchand ou par Claude Code n’est jamais visé, ni celui qu’on rebranche', async () => {
    const nomme = monter({ actifs: [actif('commande_payee_v1')] });
    await brancherMessage(nomme.deps, T, branchement, null);
    expect(nomme.programmes).toEqual([]);
    // Le même modèle de l'assistant, rebranché : c'est la garde (`modele === garde`), pas le nom, qui le protège.
    const meme = monter({ actifs: [actif(ASSISTANT)] });
    await brancherMessage(meme.deps, T, { ...branchement, modele: ASSISTANT }, null);
    expect(meme.programmes).toEqual([]);
  });
});

describe('la relance de panier (lot 2)', () => {
  const panier = { evenement: 'checkout_abandoned', modele: 'relance', texte: undefined, langue: 'fr', variables: ['first_name', 'checkout_url'], actif: true, consentementAffirme: undefined };
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
    const commande = { evenement: 'order_paid', modele: 'commande_payee', texte: undefined, langue: 'fr', variables: [], actif: true, consentementAffirme: undefined };
    expect(await brancherMessage(deps, T, { ...commande, delaiMinutes: 30 }, null)).toMatchObject({ ok: false, statut: 400 });
  });

  it('éteindre la relance n’exige rien', async () => {
    const { deps } = monter({ modele: marketing });
    expect((await brancherMessage(deps, T, { ...panier, actif: false }, null)).ok).toBe(true);
  });
});

/**
 * LE TEXTE SIMPLE D'UN NUMÉRO RELIÉ PAR QR CODE (plan 2026-10-23, tâche 5) : pas de modèle chez Meta, donc rien à lire
 * ni à attendre, mais l'accord du marchand pour les TROIS messages. Sur l'API, le texte est refusé et tout le reste ne
 * change pas (les tests ci-dessus, en filière API par défaut).
 */
describe('le texte simple d’un numéro relié par QR code', () => {
  const texte = (over: Partial<Record<string, unknown>> = {}) => ({
    evenement: 'order_paid', modele: undefined, texte: '  Bonjour {{first_name}}, votre commande {{order_number}} est payée, merci {{first_name}}.  ',
    langue: 'fr', variables: undefined, actif: undefined, consentementAffirme: true, ...over,
  });

  it('🔴 accepté et actif tout de suite : sans lecture de modèle chez Meta, sans oubli, les données tirées du texte', async () => {
    const assistant = `shopify_order_paid_${Date.UTC(2026, 9, 22, 9).toString(36)}`;
    const { deps, journal, programmes } = monter({
      filiere: 'application',
      actifs: [{ evenement: 'order_paid', modele: assistant, texte: null, langue: 'fr', variables: [], actif: true, modifieLe: '' }],
    });
    const r = await brancherMessage(deps, T, texte(), 'u1');
    expect(r.ok).toBe(true);
    expect(journal.branches).toEqual([{
      evenement: 'order_paid', modele: null, texte: 'Bonjour {{first_name}}, votre commande {{order_number}} est payée, merci {{first_name}}.',
      langue: 'fr', variables: ['first_name', 'order_number'], actif: true, par: 'u1',
    }]);
    expect(journal.lecturesModele).toBe(0);
    expect(programmes).toEqual([]);
    expect(journal.consentements).toEqual(['u1']);
    // Le dernier geste gagne : une préparation de la console encore en attente ne le remplacera pas par un modèle.
    expect(journal.attentesRetirees).toEqual([{ evenement: 'order_paid' }]);
    expect(r.ok && r.valeur).toMatchObject([{ evenement: 'order_paid', modele: null, texte: expect.stringContaining('{{order_number}}') }]);
  });

  it('🔴 refusé : un modèle, des variables à part, une donnée que l’événement ne porte pas, un repère inconnu, un texte vide ou trop long', async () => {
    for (const [over, motif] of [
      [{ modele: 'commande_payee' }, 'template'],
      [{ variables: ['first_name'] }, 'variables'],
      [{ texte: 'Suivi : {{tracking_url}}' }, '{{tracking_url}}'],
      [{ texte: 'Bonjour {{1}}, merci' }, '{{1}}'],
      [{ texte: 'Bonjour {{ First_Name }}, merci' }, '{{ First_Name }}'],
      [{ texte: '   ' }, 'text'],
      [{ texte: undefined }, 'text'],
      [{ texte: 'x'.repeat(TEXTE_SHOPIFY_MAX + 1) }, 'text'],
    ] as const) {
      const { deps, journal } = monter({ filiere: 'application' });
      const r = await brancherMessage(deps, T, texte(over), 'u1');
      expect(r, motif).toMatchObject({ ok: false, statut: 400 });
      expect((r as { message: string }).message, motif).toContain(motif);
      expect(journal.branches, motif).toEqual([]);
    }
  });

  it('🔴 l’accord du marchand est exigé pour la confirmation et l’expédition aussi, pas seulement la relance', async () => {
    for (const [evenement, corps] of [
      ['order_paid', 'Merci pour la commande {{order_number}}.'],
      ['order_fulfilled', 'Votre colis part avec {{carrier}} : {{tracking_url}}'],
      ['checkout_abandoned', 'Votre panier vous attend : {{checkout_url}}'],
    ] as const) {
      const sans = monter({ filiere: 'application' });
      expect(await brancherMessage(sans.deps, T, texte({ evenement, texte: corps, consentementAffirme: undefined }), null), evenement)
        .toMatchObject({ ok: false, statut: 409, message: expect.stringContaining('customers_consented') });
      expect(sans.journal.branches, evenement).toEqual([]);
      // Retiré dans le même appel : refusé aussi.
      const retire = monter({ filiere: 'application', boutique: { ...VUE, consentement: { par: 'u1', le: '2026-10-21T00:00:00.000Z' } } });
      expect(await brancherMessage(retire.deps, T, texte({ evenement, texte: corps, consentementAffirme: false }), null), evenement)
        .toMatchObject({ ok: false, statut: 409 });
      // Affirmé avant : branché sans le redire.
      const avant = monter({ filiere: 'application', boutique: { ...VUE, consentement: { par: 'u1', le: '2026-10-21T00:00:00.000Z' } } });
      expect((await brancherMessage(avant.deps, T, texte({ evenement, texte: corps, consentementAffirme: undefined }), null)).ok, evenement).toBe(true);
    }
    // Éteindre n'exige rien.
    const eteint = monter({ filiere: 'application' });
    expect((await brancherMessage(eteint.deps, T, texte({ actif: false, consentementAffirme: undefined }), null)).ok).toBe(true);
  });

  it('🔴 sur l’API (ou sans numéro), un texte est refusé, avec la phrase qui dit pourquoi, même à côté d’un modèle', async () => {
    for (const filiere of ['api', null] as const) {
      const { deps, journal } = monter({ filiere });
      for (const b of [texte(), texte({ modele: 'commande_payee', variables: ['first_name', 'order_number'] })]) {
        const r = await brancherMessage(deps, T, b, null);
        expect(r, String(filiere)).toMatchObject({ ok: false, statut: 400, message: expect.stringContaining('numéro relié par QR code') });
      }
      expect(journal.branches).toEqual([]);
      expect(journal.lecturesModele).toBe(0);
    }
  });

  it('la validation garde ses bornes exactes, et rend les données citées une fois, dans l’ordre', () => {
    expect(validerTexteShopify('order_paid', 'x'.repeat(TEXTE_SHOPIFY_MAX))).toMatchObject({ ok: true });
    expect(validerTexteShopify('order_paid', 'x'.repeat(TEXTE_SHOPIFY_MAX + 1))).toMatchObject({ ok: false });
    expect(validerTexteShopify('order_paid', 'x')).toEqual({ ok: true, texte: 'x', variables: [] });
    // Sans les règles propres à Meta : une donnée au début et à la fin est permise.
    expect(validerTexteShopify('checkout_abandoned', '{{first_name}}, {{checkout_url}} {{first_name}}'))
      .toEqual({ ok: true, texte: '{{first_name}}, {{checkout_url}} {{first_name}}', variables: ['first_name', 'checkout_url'] });
  });
});

describe('l’état et la coupure', () => {
  it('l’état porte les chiffres des 30 jours et la page des apps de la boutique', async () => {
    const e = await etatShopify(monter().deps, T);
    expect(e.compteurs).toEqual({ envoye: 3 });
    expect(e.pageApps).toBe('https://admin.shopify.com/store/b/settings/apps');
    expect(await etatShopify(monter({ boutique: null }).deps, T)).toEqual({ boutique: null, messages: [], compteurs: {}, paniers: { relances: {}, fermesATemps: 0, enAttente: 0 }, pageApps: null, attentes: [] });
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
    // Le texte d'un numéro relié par QR code (plan 2026-10-23) : la borne annoncée est celle que la validation applique, et
    // ni le modèle ni le texte ne sont requis (l'un ou l'autre, selon la filière).
    expect([o.entree.properties.text!.minLength, o.entree.properties.text!.maxLength]).toEqual([1, TEXTE_SHOPIFY_MAX]);
    expect(validerTexteShopify('order_paid', 'x'.repeat(o.entree.properties.text!.maxLength!))).toMatchObject({ ok: true });
    expect(validerTexteShopify('order_paid', 'x'.repeat(o.entree.properties.text!.maxLength! + 1))).toMatchObject({ ok: false });
    expect(o.entree.required).toEqual(['event', 'language']);
  });

  it('🔴 les deux outils rendent le texte à côté du modèle', async () => {
    const { deps } = monter({ filiere: 'application' });
    const mcp = { shopify: deps } as unknown as DepsMcp;
    const regle = await OUTILS.find((x) => x.nom === 'set_shopify_message')!.executer(mcp, T, {
      event: 'order_paid', text: 'Merci pour {{order_number}}.', language: 'fr', customers_consented: true,
    }, { userId: 'u1' } as never);
    expect(regle).toMatchObject({ messages: [{ event: 'order_paid', template: null, text: 'Merci pour {{order_number}}.', variables: ['order_number'], active: true }] });
    const etat = await OUTILS.find((x) => x.nom === 'get_shopify_state')!.executer(mcp, T, {}, { userId: 'u1' } as never);
    expect(etat).toMatchObject({ messages: [{ event: 'order_paid', template: null, text: 'Merci pour {{order_number}}.' }] });
  });
});

describe('l’import des clients abonnés (lot 3)', () => {
  const ABONNES: ClientAbonne[] = [
    { telephone: '+33600000001', nom: 'Le plus récent' },
    { telephone: '+33600000002', nom: 'Déjà là' },
    { telephone: '+33600000003', nom: null },
    { telephone: '+33600000004', nom: 'Le plus ancien' },
  ];
  function monterImport(o: {
    acces?: AccesBoutique | null; jeton?: IssueJeton; lecture?: LectureClients; limite?: number | null; comptees?: number;
    importerLeve?: Error;
  } = {}) {
    const journal = { imports: [] as ImportInput[], lectures: [] as unknown[] };
    const { deps } = monter();
    const d: DepsGestionShopify = {
      ...deps,
      store: {
        ...deps.store,
        acces: async () => (o.acces === undefined
          ? { domaine: 'b.myshopify.com', clientId: 'cid', secret: 'shpss_x', pays: 'FR', etat: 'connectee', origine: 'claude_code' } : o.acces),
      },
      jeton: async () => o.jeton ?? { ok: true, jeton: 'jeton' },
      lireClients: async (acces, plafond) => { journal.lectures.push({ acces, plafond }); return o.lecture ?? { ok: true, abonnes: ABONNES, sansTelephone: 2, complet: true }; },
      places: async (_t, numeros) => ({
        limite: o.limite === undefined ? 100 : o.limite, comptees: o.comptees ?? 90,
        presents: new Set(numeros.filter((n) => n === '+33600000002')),
      }),
      importer: async (input) => {
        journal.imports.push(input);
        if (o.importerLeve) throw o.importerLeve;
        return { created: input.rows.length, updated: 0, skipped: 0, errors: [] };
      },
    };
    return { deps: d, journal };
  }

  it('compte sans rien écrire : abonnés, déjà là, nouveaux, places libres, importables ; le jeton sert à la lecture', async () => {
    const { deps, journal } = monterImport();
    expect(await apercuImportClients(deps, T)).toEqual({ ok: true, valeur: {
      abonnes: 4, sansTelephone: 2, dejaDansLEspace: 1, nouveaux: 3, placesLibres: 10, importables: 3, complet: true,
    } });
    expect(journal.imports).toEqual([]);
    expect(journal.lectures).toEqual([{ acces: { domaine: 'b.myshopify.com', jeton: 'jeton', pays: 'FR' }, plafond: CLIENTS_LUS_MAX }]);
    // Sans limite (Entreprise), et une offre pleine.
    expect(await apercuImportClients(monterImport({ limite: null }).deps, T)).toMatchObject({ ok: true, valeur: { placesLibres: null, importables: 3 } });
    expect(await apercuImportClients(monterImport({ comptees: 120 }).deps, T)).toMatchObject({ ok: true, valeur: { placesLibres: 0, importables: 0 } });
  });

  it('🔴 importe les nouveaux les plus récents, au nombre choisi, SANS consentement, autorité import, étiquette Shopify', async () => {
    const { deps, journal } = monterImport();
    expect(await importerClients(deps, T, 2)).toEqual({ ok: true, valeur: {
      importes: 2, retablis: 0, restent: 1, placesLibres: 8, etiquette: 'Shopify', complet: true,
    } });
    expect(journal.imports).toEqual([{
      rows: [{ phone: '+33600000001', name: 'Le plus récent' }, { phone: '+33600000003', name: '' }],
      mapping: { columns: { phone: { target: 'phone' }, name: { target: 'name' } } },
      tenantId: T, optIn: false, tags: ['Shopify'], autorite: 'import',
    }]);
  });

  it('🔴 au-delà des places libres : refusé, rien n’est écrit ; le marchand gère sa limite', async () => {
    const { deps, journal } = monterImport({ comptees: 99 });
    const r = await importerClients(deps, T, 2);
    expect(r).toMatchObject({ ok: false, statut: 402 });
    expect((r as { message: string }).message).toContain('1 place de contacts');
    expect(journal.imports).toEqual([]);
    // Ce qui serait ÉCRIT compte, pas le nombre demandé : 100 demandés pour 1 nouveau et 1 place, ça passe.
    const un = monterImport({ comptees: 99, lecture: { ok: true, abonnes: [ABONNES[0]!], sansTelephone: 0, complet: true } });
    expect(await importerClients(un.deps, T, 100)).toMatchObject({ ok: true, valeur: { importes: 1, placesLibres: 0 } });
    // Deux écritures à la dernière place : le refus de l'import est rendu, pas une panne.
    const course = monterImport({ importerLeve: new LimiteOffreError(T, 'contacts', 100) });
    expect(await importerClients(course.deps, T, 1)).toMatchObject({ ok: false, statut: 402 });
  });

  it('le nombre choisi est un entier de 1 à la borne d’un appel ; rien à importer ne lance rien', async () => {
    for (const m of [0, IMPORT_MAX + 1, 1.5, '3', undefined]) {
      expect(await importerClients(monterImport().deps, T, m), String(m)).toMatchObject({ ok: false, statut: 400 });
    }
    const vide = monterImport({ lecture: { ok: true, abonnes: [], sansTelephone: 0, complet: true } });
    expect(await importerClients(vide.deps, T, 5)).toMatchObject({ ok: true, valeur: { importes: 0, restent: 0 } });
    expect(vide.journal.imports).toEqual([]);
  });

  it('sans boutique, boutique coupée, jeton refusé, accès aux clients refusé : chaque refus dit le geste', async () => {
    expect(await apercuImportClients(monterImport({ acces: null }).deps, T)).toMatchObject({ ok: false, statut: 409 });
    const coupee = monterImport({ acces: { domaine: 'b.myshopify.com', clientId: 'cid', secret: 's', pays: 'FR', etat: 'coupee', origine: 'claude_code' } });
    expect(await importerClients(coupee.deps, T, 1)).toMatchObject({ ok: false, statut: 409, message: expect.stringContaining('coupée') });
    expect(coupee.journal.lectures).toEqual([]);
    const jeton = monterImport({ jeton: { ok: false, code: 'app_non_installee', message: 'Installez l’app.' } });
    expect(await apercuImportClients(jeton.deps, T)).toEqual({ ok: false, statut: 409, message: 'Installez l’app.' });
    const acces = monterImport({ lecture: { ok: false, code: 'acces_refuse', message: 'Données protégées.' } });
    expect(await apercuImportClients(acces.deps, T)).toEqual({ ok: false, statut: 409, message: 'Données protégées.' });
    const panne = monterImport({ lecture: { ok: false, code: 'passager', message: 'Réessayez.' } });
    expect(await apercuImportClients(panne.deps, T)).toMatchObject({ ok: false, statut: 503 });
  });

  it('🔴 les deux outils consomment le plafond des opérations coûteuses AVANT de lire chez Shopify', async () => {
    for (const [nom, args] of [['preview_shopify_customers', {}], ['import_shopify_customers', { max_contacts: 1 }]] as const) {
      const { deps, journal } = monterImport();
      const refusant = { couteux: { consommer: async () => ({ accepte: false, attenteMs: 2000 }) }, shopify: deps } as unknown as DepsMcp;
      await expect(OUTILS.find((x) => x.nom === nom)!.executer(refusant, T, args, { userId: 'u1' } as never), nom)
        .rejects.toThrow(MESSAGE_OPERATIONS_LOURDES);
      expect([journal.lectures, journal.imports], nom).toEqual([[], []]);
      const acceptant = { couteux: { consommer: async () => ({ accepte: true, attenteMs: 0 }) }, shopify: deps } as unknown as DepsMcp;
      await OUTILS.find((x) => x.nom === nom)!.executer(acceptant, T, args, { userId: 'u1' } as never);
      expect(journal.lectures, nom).toHaveLength(1);
    }
  });

  it('🔴 les deux outils exigent une personne nommée, toutes offres ; l’import exige le nombre choisi, dans sa borne', () => {
    for (const nom of ['preview_shopify_customers', 'import_shopify_customers']) {
      const o = OUTILS.find((x) => x.nom === nom);
      expect(o, nom).toBeDefined();
      expect(o!.exigePersonne, nom).toBe(true);
      expect(o!.fonction, nom).toBeNull();
    }
    expect(OUTILS.find((x) => x.nom === 'preview_shopify_customers')!.annotations.readOnlyHint).toBe(true);
    const imp = OUTILS.find((x) => x.nom === 'import_shopify_customers')!;
    expect(imp.entree.required).toEqual(['max_contacts']);
    expect([imp.entree.properties.max_contacts!.minimum, imp.entree.properties.max_contacts!.maximum]).toEqual([1, IMPORT_MAX]);
  });
});
