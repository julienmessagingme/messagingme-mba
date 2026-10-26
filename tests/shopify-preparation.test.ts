import { describe, it, expect } from 'vitest';
import {
  activerSelonStatut, ESSAIS_OUBLI, estModeleDeLAssistant, PIED_STOP, preparerMessage, reglerMessage, relireAttentes,
  REESSAI_OUBLI_MS, suppressionDesModeles, TEXTES_PROPOSES, traiterOubli, versCorps, type DepsActivation, type DepsPreparation, type JobOubli,
} from '../src/shopify/preparation';
import type { CreateTemplateInput } from '../src/meta/templates';
import type { AttenteMessage, MessageBranche, VueBoutique } from '../src/shopify/store.pg';
import type { Emission } from '../src/emails-produit/emission';
import { EVENEMENTS_SHOPIFY } from '../src/shopify/donnees';

/**
 * L'ASSISTANT DES MESSAGES SHOPIFY DE LA CONSOLE (conception 2026-10-22) : un texte devient un modèle chez Meta, puis le
 * message s'active seul à l'approbation.
 *
 * 🔴 Ce qui se joue : un message ne s'active jamais avant l'approbation ; le message actif n'est jamais touché par une
 * préparation ni par un refus de Meta. Aucune affirmation du consentement n'est demandée, relance comprise (2026-10-26).
 */

const T = 't1';
const VUE: VueBoutique = {
  domaine: 'b.myshopify.com', nom: 'Essai', pays: 'FR', devise: 'EUR', etat: 'connectee', motifCoupure: null, coupeeLe: null,
  connecteeLe: '2026-10-22T00:00:00.000Z', dernierEvenementLe: null, delaiPanierMinutes: 60, origine: 'console',
};
/** L'heure des tests, après la mise en service de l'assistant : les noms qu'il crée sont alors les siens. */
const MAINTENANT = Date.UTC(2026, 9, 23, 12);
/** Un nom de l'assistant, horodaté à une heure donnée du 22 octobre 2026. */
const nomAssistant = (e: string, heure: number): string => `shopify_${e}_${Date.UTC(2026, 9, 22, heure).toString(36)}`;

function monter(o: {
  boutique?: VueBoutique | null; creation?: { ok: true; statut: string; categorie: string } | { ok: false; message: string };
  actif?: MessageBranche | null; attentePrecedente?: AttenteMessage;
} = {}) {
  const journal = {
    modeles: [] as CreateTemplateInput[], branches: [] as unknown[], attentes: [] as unknown[], retraits: [] as unknown[],
    delais: [] as number[], programmes: [] as JobOubli[],
  };
  // Comme le vrai store : brancher remplace le message de l'événement, poser une attente remplace la précédente.
  let messages: MessageBranche[] = o.actif ? [o.actif] : [];
  let attentes: AttenteMessage[] = o.attentePrecedente ? [o.attentePrecedente] : [];
  const deps: DepsPreparation = {
    store: {
      lire: async () => (o.boutique === undefined ? VUE : o.boutique),
      brancher: async (_t, m) => {
        journal.branches.push(m);
        messages = [...messages.filter((x) => x.evenement !== m.evenement), { ...m, modifieLe: '' }];
      },
      poserAttente: async (_t, a) => {
        journal.attentes.push(a);
        attentes = [...attentes.filter((x) => x.evenement !== a.evenement), { ...a, creeLe: '' }];
      },
      retirerAttente: async (_t, c) => {
        journal.retraits.push(c);
        const r = attentes.find((x) => ('evenement' in c ? x.evenement === c.evenement : x.modele === c.modele)) ?? null;
        attentes = attentes.filter((x) => x !== r);
        return r;
      },
      messages: async () => messages,
      attentes: async () => attentes,
      reglerDelaiPanier: async (_t, m) => { journal.delais.push(m); },
      message: async (_t, e) => messages.find((x) => x.evenement === e) ?? null,
    },
    creerModele: async (_t, input) => { journal.modeles.push(input); return o.creation ?? { ok: true, statut: 'pending', categorie: input.category.toLowerCase() }; },
    programmerOubli: async (job) => { journal.programmes.push(job); },
    maintenant: () => MAINTENANT,
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
  it('🔴 une relance se prépare sans aucune affirmation du consentement (décision de Julien du 2026-10-26)', async () => {
    const { deps, journal } = monter();
    const r = await preparerMessage(deps, T, { evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr' }, 'u1');
    expect(r).toMatchObject({ ok: true, valeur: { etat: 'en_validation' } });
    expect(journal.modeles).toHaveLength(1);
  });

  it('une relance : modèle marketing, pied STOP ; en validation, l’attente porte le délai', async () => {
    const { deps, journal } = monter();
    const r = await preparerMessage(deps, T, {
      evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr', delaiMinutes: 15,
    }, 'u1');
    expect(r).toEqual({ ok: true, valeur: { etat: 'en_validation', modele: `shopify_checkout_abandoned_${MAINTENANT.toString(36)}` } });
    expect(journal.modeles[0]).toMatchObject({ category: 'MARKETING', language: 'fr', footer: PIED_STOP.fr, example: ['https://ma-boutique.myshopify.com/checkouts/recover'] });
    expect(journal.attentes).toEqual([{ evenement: 'checkout_abandoned', modele: `shopify_checkout_abandoned_${MAINTENANT.toString(36)}`, langue: 'fr', variables: ['checkout_url'], delaiMinutes: 15, par: 'u1' }]);
    // 🔴 Le message actif n'est pas touché : il part jusqu'à l'approbation du nouveau.
    expect(journal.branches).toEqual([]);
  });

  it('un message de commande : modèle de service, sans pied STOP', async () => {
    const { deps, journal } = monter();
    await preparerMessage(deps, T, { evenement: 'order_paid', texte: TEXTES_PROPOSES.order_paid.en, langue: 'en_US' }, 'u1');
    expect(journal.modeles[0]).toMatchObject({ category: 'UTILITY', language: 'en_US' });
    expect(journal.modeles[0]).not.toHaveProperty('footer');
  });

  it('approuvé tout de suite : branché, délai posé, attente retirée', async () => {
    const { deps, journal } = monter({ creation: { ok: true, statut: 'approved', categorie: 'marketing' } });
    const r = await preparerMessage(deps, T, { evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr', delaiMinutes: 30 }, 'u1');
    expect(r).toMatchObject({ ok: true, valeur: { etat: 'actif' } });
    expect(journal.branches).toMatchObject([{ evenement: 'checkout_abandoned', actif: true, variables: ['checkout_url'] }]);
    expect(journal.delais).toEqual([30]);
    expect(journal.attentes).toEqual([]);
    // Le dernier geste gagne : une attente plus ancienne de l'événement ne s'activera pas par-dessus.
    expect(journal.retraits).toEqual([{ evenement: 'checkout_abandoned' }]);
  });

  it('🔴 un modèle refusé dès sa création est dit tout de suite, sans attente qui resterait « en validation »', async () => {
    const { deps, journal } = monter({ creation: { ok: true, statut: 'rejected', categorie: 'utility' } });
    expect(await preparerMessage(deps, T, { evenement: 'order_paid', texte: TEXTES_PROPOSES.order_paid.fr, langue: 'fr' }, 'u1'))
      .toMatchObject({ ok: false, statut: 422, message: expect.stringContaining('dès sa création') });
    expect(journal.attentes).toEqual([]);
    expect(journal.branches).toEqual([]);
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
    expect(await preparerMessage(monter().deps, T, { evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr', delaiMinutes: 5 }, null))
      .toMatchObject({ ok: false, statut: 400 });
    expect(await preparerMessage(monter({ creation: { ok: false, message: 'nom déjà pris' } }).deps, T, { evenement: 'order_paid', texte, langue: 'fr' }, null))
      .toMatchObject({ ok: false, statut: 422, message: expect.stringContaining('nom déjà pris') });
  });
});

describe('le ménage des modèles remplacés (2026-10-23)', () => {
  const precedente: AttenteMessage = { evenement: 'checkout_abandoned', modele: nomAssistant('checkout_abandoned', 10), langue: 'fr', variables: ['first_name', 'checkout_url'], delaiMinutes: 60, creeLe: '' };
  const enPlace: MessageBranche = { evenement: 'checkout_abandoned', modele: nomAssistant('checkout_abandoned', 9), texte: null, langue: 'fr', variables: ['first_name', 'checkout_url'], actif: true, modifieLe: '' };

  it('🔴 le nom exact de l’assistant ET un horodatage plausible : un nom choisi à la main n’est jamais reconnu', () => {
    expect(estModeleDeLAssistant(nomAssistant('order_paid', 9), MAINTENANT)).toBe(true);
    for (const nom of [
      'commande_payee', 'shopify_order_paid', 'shopify_order_paid_v2', 'shopify_order_paid_confirmation', 'shopify_autre_mviry800',
      'shopify_order_paid_mviry800_copie',
      // Huit caractères dont un chiffre, mais l'horodatage décodé tombe en 1974, 2047, ou avant la mise en service.
      'shopify_order_paid_20261023', 'shopify_order_paid_version2', 'shopify_checkout_abandoned_relance1', 'shopify_order_paid_mh3x9k2a',
    ]) expect(estModeleDeLAssistant(nom, MAINTENANT), nom).toBe(false);
    // Un horodatage dans le futur (au-delà d'un jour de marge) non plus.
    expect(estModeleDeLAssistant(`shopify_order_paid_${(MAINTENANT + 3 * 24 * 3600_000).toString(36)}`, MAINTENANT)).toBe(false);
  });

  it('🔴 le nom que crée la préparation est bien reconnu (le format créé et le format reconnu ne dérivent pas)', async () => {
    const { deps } = monter();
    const r = await preparerMessage(deps, T, { evenement: 'order_paid', texte: TEXTES_PROPOSES.order_paid.fr, langue: 'fr' }, 'u1');
    expect(r.ok && estModeleDeLAssistant(r.valeur.modele, MAINTENANT)).toBe(true);
  });

  it('🔴 une nouvelle version remplace celle qui attendait Meta : son oubli est programmé dans un quart d’heure, le message en place reste', async () => {
    const { deps, journal } = monter({ actif: enPlace, attentePrecedente: precedente });
    expect(await preparerMessage(deps, T, { evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr' }, 'u1'))
      .toMatchObject({ ok: true, valeur: { etat: 'en_validation' } });
    expect(journal.programmes).toEqual([{ tenantId: T, modele: precedente.modele, essai: 0 }]);
  });

  it('🔴 approuvée tout de suite : l’oubli du message remplacé et de l’attente retirée est programmé', async () => {
    const { deps, journal } = monter({ actif: enPlace, attentePrecedente: precedente, creation: { ok: true, statut: 'approved', categorie: 'marketing' } });
    expect(await preparerMessage(deps, T, { evenement: 'checkout_abandoned', texte: TEXTES_PROPOSES.checkout_abandoned.fr, langue: 'fr' }, 'u1'))
      .toMatchObject({ ok: true, valeur: { etat: 'actif' } });
    expect(journal.programmes.map((j) => j.modele).sort()).toEqual([enPlace.modele, precedente.modele].sort());
  });

  it('un modèle refusé dès sa création, ou reclassé, ne servira jamais : son oubli est programmé', async () => {
    const rejete = monter({ creation: { ok: true, statut: 'rejected', categorie: 'utility' } });
    await preparerMessage(rejete.deps, T, { evenement: 'order_paid', texte: TEXTES_PROPOSES.order_paid.fr, langue: 'fr' }, 'u1');
    expect(rejete.journal.programmes.map((j) => j.modele)).toEqual([`shopify_order_paid_${MAINTENANT.toString(36)}`]);
    const reclasse = monter({ creation: { ok: true, statut: 'pending', categorie: 'marketing' } });
    await preparerMessage(reclasse.deps, T, { evenement: 'order_paid', texte: TEXTES_PROPOSES.order_paid.fr, langue: 'fr' }, 'u1');
    expect(reclasse.journal.programmes).toHaveLength(1);
  });
});

describe('le travail du ménage (worker)', () => {
  const modele = nomAssistant('checkout_abandoned', 9);
  const job: JobOubli = { tenantId: T, modele, essai: 0 };
  function monterOubli(o: { messages?: MessageBranche[]; attentes?: AttenteMessage[]; issue?: { ok: true } | { ok: false; message: string } } = {}) {
    const journal = { supprimes: [] as string[], programmes: [] as Array<{ job: JobOubli; quand: Date }> };
    const deps = {
      store: { messages: async () => o.messages ?? [], attentes: async () => o.attentes ?? [] },
      supprimerModele: async (_t: string, nom: string) => { journal.supprimes.push(nom); return o.issue ?? { ok: true as const }; },
      programmerOubli: async (j: JobOubli, quand: Date) => { journal.programmes.push({ job: j, quand }); },
      maintenant: () => MAINTENANT,
    };
    return { deps, journal };
  }
  const branche = (m: string): MessageBranche => ({ evenement: 'checkout_abandoned', modele: m, texte: null, langue: 'fr', variables: [], actif: true, modifieLe: '' });

  it('🔴 un modèle rebranché, ou attendu, entre le geste et le travail n’est PAS supprimé (la course de la relecture)', async () => {
    const rebranche = monterOubli({ messages: [branche(modele)] });
    expect(await traiterOubli(rebranche.deps, job)).toBe('garde');
    const attendu = monterOubli({ attentes: [{ evenement: 'checkout_abandoned', modele, langue: 'fr', variables: [], delaiMinutes: null, creeLe: '' }] });
    expect(await traiterOubli(attendu.deps, job)).toBe('garde');
    expect([...rebranche.journal.supprimes, ...attendu.journal.supprimes]).toEqual([]);
  });

  it('un modèle qui ne sert plus est supprimé', async () => {
    const { deps, journal } = monterOubli({ messages: [branche(nomAssistant('checkout_abandoned', 11))] });
    expect(await traiterOubli(deps, job)).toBe('supprime');
    expect(journal.supprimes).toEqual([modele]);
  });

  it('🔴 un refus (campagne active) se retente une heure plus tard, puis s’abandonne', async () => {
    const refus = { ok: false as const, message: 'template utilisé par une campagne active' };
    const { deps, journal } = monterOubli({ issue: refus });
    expect(await traiterOubli(deps, job)).toBe('reessai');
    expect(journal.programmes).toEqual([{ job: { ...job, essai: 1 }, quand: new Date(MAINTENANT + REESSAI_OUBLI_MS) }]);
    const dernier = monterOubli({ issue: refus });
    expect(await traiterOubli(dernier.deps, { ...job, essai: ESSAIS_OUBLI - 1 })).toBe('abandon');
    expect(dernier.journal.programmes).toEqual([]);
  });

  it('un travail mal formé, ou un nom qui n’est pas celui de l’assistant, ne supprime rien', async () => {
    const { deps, journal } = monterOubli();
    expect(await traiterOubli(deps, { tenantId: T })).toBe('ignore');
    expect(await traiterOubli(deps, null)).toBe('ignore');
    expect(await traiterOubli(deps, { ...job, modele: 'relance_panier' })).toBe('ignore');
    expect(journal.supprimes).toEqual([]);
  });
});

describe('la suppression liée par le câblage', () => {
  function monterSuppression(o: { campagnes?: number; succes?: boolean; panne?: boolean } = {}) {
    const journal = { removes: [] as string[], indices: [] as string[] };
    const deps = {
      repo: {
        getTenantWabaId: async () => 'waba-1',
        listActiveCampaignsForTemplate: async () => Array.from({ length: o.campagnes ?? 0 }, (_v, i) => ({ id: `c${i}`, name: 'Shopify', status: 'running' as const, templateLanguage: 'fr' })),
      },
      meta: {
        templateClientForTenant: async () => ({
          remove: async (_waba: string, nom: string) => {
            if (o.panne) throw new Error('Graph indisponible');
            journal.removes.push(nom);
            return { success: o.succes ?? true };
          },
        }),
      },
      indices: { removeByName: async (_t: string, nom: string) => { journal.indices.push(nom); } },
    } as unknown as Parameters<typeof suppressionDesModeles>[0];
    return { supprimer: suppressionDesModeles(deps), journal };
  }

  it('🔴 elle passe par la garde des campagnes actives : une campagne s’en sert, Meta n’est pas appelé', async () => {
    const { supprimer, journal } = monterSuppression({ campagnes: 1 });
    expect(await supprimer(T, 'm')).toMatchObject({ ok: false });
    expect(journal.removes).toEqual([]);
  });

  it('un succès, un refus de Meta, une panne', async () => {
    const ok = monterSuppression();
    expect(await ok.supprimer(T, 'm')).toEqual({ ok: true });
    expect(ok.journal.indices).toEqual(['m']);
    expect(await monterSuppression({ succes: false }).supprimer(T, 'm')).toMatchObject({ ok: false });
    expect(await monterSuppression({ panne: true }).supprimer(T, 'm')).toEqual({ ok: false, message: 'Graph indisponible' });
  });
});

describe('régler un message sans repasser par Meta', () => {
  it('le délai seulement pour la relance, dans ses bornes ; sans boutique, refusé', async () => {
    const a = monter();
    expect(await reglerMessage(a.deps, T, { evenement: 'checkout_abandoned', delaiMinutes: 120 })).toEqual({ ok: true, valeur: {} });
    expect(a.journal.delais).toEqual([120]);
    expect(await reglerMessage(a.deps, T, { evenement: 'order_paid', delaiMinutes: 120 })).toMatchObject({ ok: false, statut: 400 });
    expect(await reglerMessage(a.deps, T, { evenement: 'checkout_abandoned', delaiMinutes: 5 })).toMatchObject({ ok: false, statut: 400 });
    expect(a.journal.delais).toEqual([120]);
    expect(await reglerMessage(monter({ boutique: null }).deps, T, { evenement: 'checkout_abandoned', delaiMinutes: 120 })).toMatchObject({ ok: false, statut: 409 });
  });
});

describe('l’activation au statut tranché par Meta', () => {
  const ATTENTE: AttenteMessage = { evenement: 'checkout_abandoned', modele: nomAssistant('checkout_abandoned', 10), langue: 'fr', variables: ['first_name', 'checkout_url'], delaiMinutes: 15, creeLe: '' };
  function monterActivation(attente: AttenteMessage | null = ATTENTE, o: {
    boutique?: VueBoutique | null; panne?: boolean; actif?: MessageBranche; suppression?: 'refus' | 'panne';
  } = {}) {
    const journal = { branches: [] as unknown[], emails: [] as Emission[], delais: [] as number[], retraits: [] as unknown[], programmes: [] as JobOubli[] };
    let restante = attente;
    let messages: MessageBranche[] = o.actif ? [o.actif] : [];
    const deps: DepsActivation = {
      store: {
        lire: async () => (o.boutique === undefined ? VUE : o.boutique),
        attenteDuModele: async (_t, modele, langue) => (restante !== null && restante.modele === modele && restante.langue === langue ? restante : null),
        brancher: async (_t, m) => {
          if (o.panne) throw new Error('base perdue');
          journal.branches.push(m);
          messages = [...messages.filter((x) => x.evenement !== m.evenement), { ...m, modifieLe: '' }];
        },
        messages: async () => messages,
        attentes: async () => (restante ? [restante] : []),
        retirerAttente: async (_t, c) => {
          journal.retraits.push(c);
          if ('modele' in c) { const a = restante; restante = null; return a !== null && a.modele === c.modele && a.langue === c.langue ? a : null; }
          return null;
        },
        reglerDelaiPanier: async (_t, m) => { journal.delais.push(m); },
      },
      emails: { emettre: async (e) => { journal.emails.push(e); return {}; } },
      pageParametres: 'https://console.test/parametres',
      programmerOubli: async (j) => {
        if (o.suppression === 'panne') throw new Error('file indisponible');
        journal.programmes.push(j);
      },
    };
    return { deps, journal };
  }

  const ANCIEN = nomAssistant('checkout_abandoned', 9);
  const actifRelance = (modele: string): MessageBranche => ({ evenement: 'checkout_abandoned', modele, texte: null, langue: 'fr', variables: ['first_name', 'checkout_url'], actif: true, modifieLe: '' });

  it('🔴 à l’approbation, l’oubli du modèle de l’assistant qu’elle remplace est programmé, une seule fois, dans un quart d’heure', async () => {
    const { deps, journal } = monterActivation(ATTENTE, { actif: actifRelance(ANCIEN) });
    const s = { modele: ATTENTE.modele, langue: 'fr', statut: 'APPROVED', raison: null };
    expect(await activerSelonStatut(deps, T, s)).toBe('active');
    expect(await activerSelonStatut(deps, T, s)).toBe('rien');
    expect(journal.programmes).toEqual([{ tenantId: T, modele: ANCIEN, essai: 0 }]);
  });

  it('🔴 un message en place nommé par Claude Code ou le marchand n’est jamais visé', async () => {
    const { deps, journal } = monterActivation(ATTENTE, { actif: actifRelance('relance_panier') });
    expect(await activerSelonStatut(deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'APPROVED', raison: null })).toBe('active');
    expect(journal.programmes).toEqual([]);
  });

  it('🔴 un oubli impossible à programmer (file en panne) ne bloque rien : le message est actif, l’e-mail part', async () => {
    for (const suppression of ['panne'] as const) {
      const { deps, journal } = monterActivation(ATTENTE, { actif: actifRelance(ANCIEN), suppression });
      expect(await activerSelonStatut(deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'APPROVED', raison: null })).toBe('active');
      expect(journal.branches).toHaveLength(1);
      expect(journal.emails).toMatchObject([{ cle: 'shopify_message_actif' }]);
    }
  });

  it('un modèle refusé par Meta : son oubli est programmé ; le message en place reste', async () => {
    const { deps, journal } = monterActivation(ATTENTE, { actif: actifRelance(ANCIEN) });
    expect(await activerSelonStatut(deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'REJECTED', raison: 'INVALID_FORMAT' })).toBe('refuse');
    expect(journal.programmes.map((j) => j.modele)).toEqual([ATTENTE.modele]);
  });

  it('🔴 APPROVED active le message qui attend CE modèle, avec son délai, et prévient', async () => {
    const { deps, journal } = monterActivation();
    expect(await activerSelonStatut(deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'APPROVED', raison: null })).toBe('active');
    expect(journal.branches).toEqual([{ evenement: 'checkout_abandoned', modele: ATTENTE.modele, texte: null, langue: 'fr', variables: ['first_name', 'checkout_url'], actif: true, par: null }]);
    expect(journal.delais).toEqual([15]);
    expect(journal.emails).toMatchObject([{ cle: 'shopify_message_actif', a: 'admins', valeurs: { boutique: 'b.myshopify.com', message: 'Relance de panier abandonné', lien_parametres: 'https://console.test/parametres' } }]);
  });

  it('🔴 une panne au branchement laisse l’attente : le rejeu du statut ou le filet la retrouve', async () => {
    const { deps, journal } = monterActivation(ATTENTE, { panne: true });
    await expect(activerSelonStatut(deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'APPROVED', raison: null })).rejects.toThrow('base perdue');
    expect(journal.retraits).toEqual([]);
    expect(journal.emails).toEqual([]);
  });

  it('🔴 le statut et le filet passent tous deux : branché à l’identique, un seul e-mail', async () => {
    const { deps, journal } = monterActivation();
    const s = { modele: ATTENTE.modele, langue: 'fr', statut: 'APPROVED', raison: null };
    expect(await activerSelonStatut(deps, T, s)).toBe('active');
    expect(await activerSelonStatut(deps, T, s)).toBe('rien');
    expect(journal.emails).toHaveLength(1);
  });

  it('🔴 une boutique coupée pendant la validation : branché, mais aucun e-mail « actif » (rien ne part)', async () => {
    const { deps, journal } = monterActivation(ATTENTE, { boutique: { ...VUE, etat: 'coupee' } });
    expect(await activerSelonStatut(deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'APPROVED', raison: null })).toBe('active');
    expect(journal.branches).toHaveLength(1);
    expect(journal.emails).toEqual([]);
  });

  it('🔴 une relance approuvée part sans aucune affirmation du consentement (2026-10-26) : l’e-mail « actif » le dit, comme pour une commande', async () => {
    for (const attente of [ATTENTE, { ...ATTENTE, evenement: 'order_paid' as const, delaiMinutes: null }]) {
      const { deps, journal } = monterActivation(attente, { boutique: VUE });
      expect(await activerSelonStatut(deps, T, { modele: ATTENTE.modele, langue: 'fr', statut: 'APPROVED', raison: null }), attente.evenement).toBe('active');
      expect(journal.emails, attente.evenement).toMatchObject([{ cle: 'shopify_message_actif' }]);
    }
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
