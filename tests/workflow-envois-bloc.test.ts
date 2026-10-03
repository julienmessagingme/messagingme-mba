import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { creerEnvoisDeBloc, type ClientDesEnvois, type DepsEnvoisDeBloc, type EnvoisDeBloc, type TplInfo } from '../src/workflow/envois-bloc';
import { buildWorkflowRuntime } from '../src/workflow/wiring';
import type { SendRefusal, WorkflowExecutorDeps } from '../src/workflow/executor';
import { problemeLienBouton, type LienBouton } from '../src/workflow/engine';
import { fabriquerJeton } from '../src/links/jeton-contact';
import type { LienTrace } from '../src/links/tracked-links.pg';
import { SUFFIXE_ANONYME } from '../src/campaign/engine';
import type { TemplateSummary } from '../src/meta/templates';
import type { OutboundCarouselCard } from '../src/meta/template-components';

/**
 * LES QUATRE ENVOIS D'UN BLOC DE SCÉNARIO, EXÉCUTÉS (`src/workflow/envois-bloc.ts`).
 *
 * Le vrai module tourne contre un faux client Meta qui note chaque appel, et de faux dépôts. Chaque branche est
 * jouée : ce qui part chez Meta (méthode et arguments exacts), ce qui est refusé (la chaîne exacte), ce qui est
 * journalisé dans le fil. Les derniers cas montent le VRAI câblage (`buildWorkflowRuntime`) et appellent les
 * dépendances qu'il a données à l'exécuteur.
 *
 * 🔴 DEUX DÉFAUTS QUE LE COMPILATEUR NE VOIT PAS, et que seule l'exécution attrape. La catégorie d'un template
 * envoyé par un scénario : `logTemplateSent` reçoit son contexte dans un objet FACULTATIF, et retirer l'argument
 * aux deux points d'appel passait le typecheck et toute la suite (mesuré le 2026-09-07). Un envoi sans catégorie
 * remonte en volume mais ne produit aucun coût : vécu chez le tenant Demo, 22 envois de scénario invisibles du
 * coût estimé. Et le bouton de lien d'un message rapide : `lien` est le SIXIÈME paramètre d'un contrat qui les
 * déclare facultatifs à partir du cinquième, et une flèche qui n'en déclare que cinq compile en avalant le lien.
 */

const T = 't1';
const W = '33600000001';
const NOM = 'bienvenue';
const LANGUE = 'fr';
const MESSAGE_ID = 'wamid.1';
const SANS_NUMERO = 'aucun numéro WhatsApp rattaché à ce workspace';

/** Un appel au client Meta : la méthode, puis ses arguments. */
type Appel = [string, ...unknown[]];

/** Un faux client Meta : chaque envoi est noté et réussit. */
function fauxClient(appels: Appel[]): ClientDesEnvois {
  const noter = (methode: string) => async (...args: unknown[]) => { appels.push([methode, ...args]); return { messageId: MESSAGE_ID }; };
  return {
    sendTemplate: noter('sendTemplate'),
    sendCtaUrl: noter('sendCtaUrl'),
    sendInteractive: noter('sendInteractive'),
    sendImage: noter('sendImage'),
    sendText: noter('sendText'),
    sendList: noter('sendList'),
    sendFlowMessage: noter('sendFlowMessage'),
  };
}

/** La lecture d'un template sans variable ni visuel, catégorie `utility`. */
const LECTURE: TplInfo = { count: 0, statut: 'APPROVED', langue: LANGUE, category: 'utility', nonEnvoyable: null };

/** Le module, monté sur des faux qui réussissent tous ; chaque cas remplace ce qu'il regarde. */
function monter(over: Partial<DepsEnvoisDeBloc> = {}) {
  const appels: Appel[] = [];
  const journal: unknown[][] = [];
  const deps: DepsEnvoisDeBloc = {
    dryRun: false,
    clientWhatsApp: vi.fn(async () => fauxClient(appels)),
    templateVarInfo: vi.fn(async () => LECTURE),
    prepareCarouselMedia: vi.fn(async (_t: string, cartes: OutboundCarouselCard[]) => cartes.map((c) => ({ ...c, mediaId: 'media-carte' }))),
    prepareHeaderMedia: vi.fn(async () => 'media-entete'),
    trackedLinks: { listByTemplates: vi.fn(async () => []), jetonPourE164: vi.fn(async () => 'jeton-abc') },
    hintStore: { get: vi.fn(async () => []) },
    contactStore: { getResolvableByPhone: vi.fn(async () => null) },
    varsDuContact: vi.fn(async () => ({})),
    inboxStore: { recordOutboundByWaId: vi.fn(async (...a: unknown[]) => { journal.push(a); }) },
    ...over,
  };
  return { envois: creerEnvoisDeBloc(deps), deps, appels, journal };
}

/** Ce que la ligne du fil porte (troisième argument de `recordOutboundByWaId`). */
const ligneDuFil = (journal: unknown[][], i = 0): unknown => journal[i]?.[2];

let erreurs: MockInstance<typeof console.error>;
beforeEach(() => { erreurs = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

/**
 * Ce que les quatre envois ont en commun : DRY_RUN, l'espace sans numéro, le journal, l'identifiant remonté.
 * `sendTemplate` passe ici par la branche des indications (aucune variable déjà résolue).
 */
const QUATRE: Array<{ nom: keyof EnvoisDeBloc; envoyer: (e: EnvoisDeBloc) => Promise<SendRefusal>; qui: string; quoi: string; ligne: Record<string, unknown> }> = [
  {
    nom: 'sendTemplate', envoyer: (e) => e.sendTemplate(T, W, NOM, LANGUE, []),
    qui: 'workflow sendTemplate', quoi: `template « ${NOM} » non envoyé`,
    ligne: { body: `Template « ${NOM} »`, messageId: MESSAGE_ID, type: 'template', templateName: NOM, origine: 'scenario', templateCategory: 'utility' },
  },
  {
    nom: 'sendQuickMessage', envoyer: (e) => e.sendQuickMessage(T, W, 'Bonjour', []),
    qui: 'workflow sendQuickMessage', quoi: `message rapide non envoyé à ${W}`,
    ligne: { body: 'Bonjour', messageId: MESSAGE_ID, type: 'text', origine: 'scenario' },
  },
  {
    nom: 'sendQuestion', envoyer: (e) => e.sendQuestion(T, W, 'Votre choix ?', 'Choisir', [{ title: 'A' }]),
    qui: 'workflow sendQuestion', quoi: `question non envoyée à ${W}`,
    ligne: { body: 'Votre choix ?', messageId: MESSAGE_ID, type: 'text', origine: 'scenario' },
  },
  {
    nom: 'sendFlow', envoyer: (e) => e.sendFlow(T, W, 'flow-1', 'Remplissez le formulaire', 'Ouvrir'),
    qui: 'workflow sendFlow', quoi: `formulaire non envoyé à ${W}`,
    ligne: { body: 'Remplissez le formulaire', messageId: MESSAGE_ID, type: 'text', origine: 'scenario' },
  },
];

describe('les quatre envois', () => {
  for (const { nom, envoyer, qui, quoi, ligne } of QUATRE) {
    describe(nom, () => {
      it('DRY_RUN : rien ne part, rien n’est lu, rien n’est journalisé', async () => {
        const { envois, deps, appels, journal } = monter({ dryRun: true });
        expect(await envoyer(envois)).toBeUndefined();
        expect(deps.clientWhatsApp).not.toHaveBeenCalled();
        expect(deps.templateVarInfo).not.toHaveBeenCalled();
        expect(deps.trackedLinks.listByTemplates).not.toHaveBeenCalled();
        expect(deps.varsDuContact).not.toHaveBeenCalled();
        expect(appels).toEqual([]);
        expect(journal).toEqual([]);
      });

      it('aucun numéro rattaché : le refus du client remonte, sans appel à Meta', async () => {
        const { envois, deps, appels, journal } = monter({ clientWhatsApp: vi.fn(async () => SANS_NUMERO) });
        expect(await envoyer(envois)).toBe(SANS_NUMERO);
        // Ce que le câblage écrit dans son journal d'erreur nomme le bloc et ce qui n'est pas parti.
        expect(deps.clientWhatsApp).toHaveBeenCalledWith(T, qui, quoi);
        expect(appels).toEqual([]);
        expect(journal).toEqual([]);
      });

      it('le journal du fil porte l’origine `scenario`', async () => {
        const { envois, journal } = monter();
        await envoyer(envois);
        expect(journal).toEqual([[T, W, ligne]]);
      });

      it('un journal qui lève ne fait pas échouer un envoi parti', async () => {
        const { envois, appels } = monter({ inboxStore: { recordOutboundByWaId: vi.fn(async () => { throw new Error('base indisponible'); }) } });
        expect(await envoyer(envois)).toEqual({ messageId: MESSAGE_ID });
        expect(appels).toHaveLength(1);
      });

      it('l’identifiant du message rendu par Meta remonte', async () => {
        const { envois } = monter();
        expect(await envoyer(envois)).toEqual({ messageId: MESSAGE_ID });
      });
    });
  }
});

/** Les deux branches de `sendTemplate` : variables déjà résolues (`[]` compris), ou résolues par les indications. */
const BRANCHES: Array<{ branche: string; params: string[] | undefined }> = [
  { branche: 'variables déjà résolues', params: [] },
  { branche: 'indications', params: undefined },
];

describe('sendTemplate, branche « variables déjà résolues » (campagne de scénario)', () => {
  it('construit les composants avec les valeurs reçues, sans lire les indications ni la fiche', async () => {
    const { envois, deps, appels } = monter({ templateVarInfo: vi.fn(async () => ({ ...LECTURE, count: 1 })) });
    const r = await envois.sendTemplate(T, W, NOM, LANGUE, [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Voir' }], ['Camille']);
    expect(r).toEqual({ messageId: MESSAGE_ID });
    expect(appels).toEqual([['sendTemplate', W, { name: NOM, language: LANGUE, components: [
      { type: 'body', parameters: [{ type: 'text', text: 'Camille' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'btn:0' }] },
    ] }]]);
    expect(deps.templateVarInfo).toHaveBeenCalledWith(T, NOM, LANGUE);
    expect(deps.hintStore.get).not.toHaveBeenCalled();
    expect(deps.contactStore.getResolvableByPhone).not.toHaveBeenCalled();
  });

  it('sans variable ni bouton, part sans `components`', async () => {
    const { envois, appels } = monter();
    await envois.sendTemplate(T, W, NOM, LANGUE, [], []);
    expect(appels).toEqual([['sendTemplate', W, { name: NOM, language: LANGUE }]]);
  });

  it('🔴 journalise la catégorie de SA lecture du template', async () => {
    const { envois, journal } = monter({ templateVarInfo: vi.fn(async () => ({ ...LECTURE, category: 'marketing' })) });
    await envois.sendTemplate(T, W, NOM, LANGUE, [], []);
    expect(ligneDuFil(journal)).toMatchObject({ templateCategory: 'marketing', origine: 'scenario', messageId: MESSAGE_ID });
  });

  it('une lecture en échec part quand même, sans visuel et sans catégorie (jamais une catégorie inventée)', async () => {
    for (const lecture of [vi.fn(async () => { throw new Error('réseau'); }), vi.fn(async () => null)]) {
      const { envois, appels, journal } = monter({ templateVarInfo: lecture });
      expect(await envois.sendTemplate(T, W, NOM, LANGUE, [], ['Camille'])).toEqual({ messageId: MESSAGE_ID });
      expect(appels).toEqual([['sendTemplate', W, { name: NOM, language: LANGUE, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Camille' }] }] }]]);
      expect(ligneDuFil(journal)).toEqual({ body: `Template « ${NOM} »`, messageId: MESSAGE_ID, type: 'template', templateName: NOM, origine: 'scenario' });
    }
  });

  it('un en-tête média préparé part dans les composants', async () => {
    const { envois, deps, appels } = monter({ templateVarInfo: vi.fn(async () => ({ ...LECTURE, headerFormat: 'IMAGE' as const, headerMediaUrl: 'https://cdn.meta/x.jpg' })) });
    await envois.sendTemplate(T, W, NOM, LANGUE, [], []);
    expect(deps.prepareHeaderMedia).toHaveBeenCalledWith(T, 'https://cdn.meta/x.jpg');
    expect(appels).toEqual([['sendTemplate', W, { name: NOM, language: LANGUE, components: [
      { type: 'header', parameters: [{ type: 'image', image: { id: 'media-entete' } }] },
    ] }]]);
  });

  it('un visuel non préparé refuse avec sa raison, sans appel', async () => {
    const { envois, appels, journal } = monter({
      templateVarInfo: vi.fn(async () => ({ ...LECTURE, headerFormat: 'IMAGE' as const, headerMediaUrl: 'https://cdn.meta/x.jpg' })),
      prepareHeaderMedia: vi.fn(async () => null),
    });
    const raison = 'l’image d’en-tête du template n’a pas pu être préparée pour l’envoi';
    expect(await envois.sendTemplate(T, W, NOM, LANGUE, [], [])).toBe(`template « ${NOM} » : ${raison}`);
    expect(erreurs).toHaveBeenCalledWith(`workflow sendTemplate: « ${NOM} » non envoyé à ${W} : ${raison}`);
    expect(appels).toEqual([]);
    expect(journal).toEqual([]);
  });

  it('une valeur vide refuse avec ses positions, sans appel', async () => {
    const { envois, appels } = monter();
    expect(await envois.sendTemplate(T, W, NOM, LANGUE, [], ['Camille', '']))
      .toBe(`template « ${NOM} » : valeur manquante pour la ou les variables {{2}}`);
    expect(erreurs).toHaveBeenCalledWith(`workflow sendTemplate: « ${NOM} » non envoyé à ${W} : variable(s) manquante(s) position(s) 2`);
    expect(appels).toEqual([]);
  });
});

describe('sendTemplate, branche « indications » (réponse du contact)', () => {
  const MESSAGE_INTROUVABLE = `template « ${NOM} » introuvable chez Meta (nom, langue, ou WhatsApp momentanément injoignable)`;

  it('un template introuvable refuse, sans appel', async () => {
    const { envois, appels } = monter({ templateVarInfo: vi.fn(async () => null) });
    expect(await envois.sendTemplate(T, W, NOM, LANGUE, [])).toBe(MESSAGE_INTROUVABLE);
    expect(erreurs).toHaveBeenCalledWith(`workflow sendTemplate: variables de « ${NOM} » indéterminables (WABA/template/réseau) -> non envoyé à ${W}`);
    expect(appels).toEqual([]);
  });

  it('une lecture qui lève refuse de même, et dit pourquoi', async () => {
    const { envois, appels } = monter({ templateVarInfo: vi.fn(async () => { throw new Error('réseau'); }) });
    expect(await envois.sendTemplate(T, W, NOM, LANGUE, [])).toBe(MESSAGE_INTROUVABLE);
    expect(erreurs).toHaveBeenCalledWith(`workflow sendTemplate: variables de « ${NOM} » indéterminables:`, 'réseau');
    expect(appels).toEqual([]);
  });

  it('la fiche et les indications ne sont lues que si le template a des variables', async () => {
    const sans = monter();
    await sans.envois.sendTemplate(T, W, NOM, LANGUE, []);
    expect(sans.deps.hintStore.get).not.toHaveBeenCalled();
    expect(sans.deps.contactStore.getResolvableByPhone).not.toHaveBeenCalled();

    const avec = monter({ templateVarInfo: vi.fn(async () => ({ ...LECTURE, count: 1 })) });
    await avec.envois.sendTemplate(T, W, NOM, LANGUE, []);
    expect(avec.deps.hintStore.get).toHaveBeenCalledWith(T, NOM, LANGUE);
    expect(avec.deps.contactStore.getResolvableByPhone).toHaveBeenCalledWith(T, W);
  });

  it('les variables sont résolues par les indications sur la fiche du contact', async () => {
    const { envois, appels } = monter({
      templateVarInfo: vi.fn(async () => ({ ...LECTURE, count: 1 })),
      hintStore: { get: vi.fn(async () => [{ position: 1, source: { type: 'field' as const, key: 'prenom' } }]) },
      contactStore: { getResolvableByPhone: vi.fn(async () => ({ phone_e164: `+${W}`, bsuid: null, profile_name: null, fields: { prenom: 'Camille' } })) },
    });
    expect(await envois.sendTemplate(T, W, NOM, LANGUE, [])).toEqual({ messageId: MESSAGE_ID });
    expect(appels).toEqual([['sendTemplate', W, { name: NOM, language: LANGUE, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Camille' }] }] }]]);
  });

  it('une variable sans valeur sur la fiche refuse, sans appel', async () => {
    const { envois, appels } = monter({
      templateVarInfo: vi.fn(async () => ({ ...LECTURE, count: 1 })),
      hintStore: { get: vi.fn(async () => [{ position: 1, source: { type: 'field' as const, key: 'prenom' } }]) },
    });
    expect(await envois.sendTemplate(T, W, NOM, LANGUE, []))
      .toBe(`template « ${NOM} » : ce contact n'a pas de valeur pour la ou les variables {{1}}`);
    expect(erreurs).toHaveBeenCalledWith(`workflow sendTemplate: « ${NOM} » non envoyé à ${W} : variable(s) manquante(s) position(s) 1`);
    expect(appels).toEqual([]);
  });

  it('🔴 journalise la catégorie de SA lecture du template', async () => {
    const { envois, journal } = monter({ templateVarInfo: vi.fn(async () => ({ ...LECTURE, category: 'marketing' })) });
    await envois.sendTemplate(T, W, NOM, LANGUE, []);
    expect(ligneDuFil(journal)).toMatchObject({ templateCategory: 'marketing', origine: 'scenario', messageId: MESSAGE_ID });
  });

  it('un carousel non envoyable refuse avec sa raison, sans appel', async () => {
    const { envois, appels } = monter({
      templateVarInfo: vi.fn(async () => ({ ...LECTURE, carousel: { cards: [{ mediaUrl: 'https://cdn.meta/c1.jpg' }] } })),
      // Le re-téléversement a échoué : la carte n'a pas de `mediaId`.
      prepareCarouselMedia: vi.fn(async () => [{ mediaUrl: 'https://cdn.meta/c1.jpg' }]),
    });
    const raison = 'l\'image de la carte 1 n\'a pas pu être préparée pour l\'envoi';
    expect(await envois.sendTemplate(T, W, NOM, LANGUE, [])).toBe(`template « ${NOM} » : ${raison}`);
    expect(erreurs).toHaveBeenCalledWith(`workflow sendTemplate: « ${NOM} » non envoyé à ${W} : ${raison}`);
    expect(appels).toEqual([]);
  });
});

/**
 * LA CATÉGORIE JOURNALISÉE. Sans elle, un envoi de scénario compte en volume et pas dans le coût
 * (`estimateCostSeries` ignore la ligne, `src/stats/cost.ts`), et l'écran affiche zéro sans rien signaler.
 */
describe('la catégorie d’un template envoyé par un scénario', () => {
  it('🔴 les DEUX branches de sendTemplate journalisent la catégorie', async () => {
    // Leur divergence a déjà laissé le carousel, puis l'en-tête média, non branchés côté campagne : c'est le
    // défaut récurrent de ce couple.
    for (const { branche, params } of BRANCHES) {
      const { envois, journal } = monter({ templateVarInfo: vi.fn(async () => ({ ...LECTURE, category: 'marketing' })) });
      await envois.sendTemplate(T, W, NOM, LANGUE, [], params);
      expect(ligneDuFil(journal), branche).toMatchObject({ templateCategory: 'marketing' });
    }
  });

  it('🔴 chaque branche lit la catégorie de SA propre lecture de template', async () => {
    // Trois envois sur le même module, chacun avec sa lecture : la catégorie journalisée est celle de la lecture
    // de CET envoi, jamais celle d'un envoi précédent, et une lecture ratée n'en journalise aucune.
    const lectures = [
      async () => ({ ...LECTURE, category: 'marketing' }),
      async () => ({ ...LECTURE, category: 'utility' }),
      async () => { throw new Error('réseau'); },
    ];
    const { envois, journal } = monter({ templateVarInfo: vi.fn(async () => (lectures.shift() as () => Promise<TplInfo>)()) });
    await envois.sendTemplate(T, W, NOM, LANGUE, [], []);
    await envois.sendTemplate(T, W, NOM, LANGUE, []);
    await envois.sendTemplate(T, W, NOM, LANGUE, [], []);
    expect(journal.map((l) => (l[2] as { templateCategory?: string }).templateCategory)).toEqual(['marketing', 'utility', undefined]);
  });

  it('🔴 la catégorie est LUE de la réponse Meta, jamais devinée du nom du template (vrai câblage)', async () => {
    // Un template nommé « promo_marketing » que Meta range en UTILITY : la catégorie vient de la réponse, en
    // minuscules (Meta rend 'MARKETING'/'UTILITY', la base et `estimateCostSeries` comparent en minuscules).
    const { deps, templateVarInfo, journal } = cablage({ templates: [template({ name: 'promo_marketing', category: 'UTILITY' })] });
    expect(await templateVarInfo(T, 'promo_marketing', LANGUE)).toMatchObject({ category: 'utility' });
    await deps.sendTemplate(T, W, 'promo_marketing', LANGUE, []);
    await deps.sendTemplate(T, W, 'promo_marketing', LANGUE, [], []);
    expect(journal.map((l) => l[2])).toEqual([
      { body: 'Template « promo_marketing »', messageId: MESSAGE_ID, type: 'template', templateName: 'promo_marketing', origine: 'scenario', templateCategory: 'utility' },
      { body: 'Template « promo_marketing »', messageId: MESSAGE_ID, type: 'template', templateName: 'promo_marketing', origine: 'scenario', templateCategory: 'utility' },
    ]);
  });
});

describe('sendTemplate, boutons de lien tracés (attribution des clics)', () => {
  const lien = (o: Partial<LienTrace> = {}): LienTrace => ({
    templateName: NOM, templateLanguage: LANGUE, cardIndex: null, buttonIndex: 1, code: 'c0de', destination: 'https://exemple.fr', avecJeton: true, ...o,
  });
  const boutonUrl = (texte: string) => ({ type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: texte }] });

  it('🔴 un bouton tracé à jeton reçoit le jeton du contact en suffixe, dans les deux branches', async () => {
    // Sans ce composant, Meta refuse tout le message en 131008.
    for (const { branche, params } of BRANCHES) {
      const { envois, deps, appels } = monter({ trackedLinks: { listByTemplates: vi.fn(async () => [lien()]), jetonPourE164: vi.fn(async () => 'jeton-abc') } });
      await envois.sendTemplate(T, W, NOM, LANGUE, [], params);
      expect(deps.trackedLinks.listByTemplates, branche).toHaveBeenCalledWith(T, [NOM]);
      expect(deps.trackedLinks.jetonPourE164, branche).toHaveBeenCalledWith(T, W, fabriquerJeton);
      expect(appels, branche).toEqual([['sendTemplate', W, { name: NOM, language: LANGUE, components: [boutonUrl('jeton-abc')] }]]);
    }
  });

  it('un jeton illisible part avec le suffixe anonyme : le lien marche, le clic n’est rattaché à personne', async () => {
    const { envois, appels } = monter({ trackedLinks: { listByTemplates: vi.fn(async () => [lien()]), jetonPourE164: vi.fn(async () => { throw new Error('base'); }) } });
    await envois.sendTemplate(T, W, NOM, LANGUE, []);
    expect(appels).toEqual([['sendTemplate', W, { name: NOM, language: LANGUE, components: [boutonUrl(SUFFIXE_ANONYME)] }]]);
  });

  it('un lien sans jeton, ou sur une carte de carousel, ne demande ni suffixe ni jeton', async () => {
    const { envois, deps, appels } = monter({ trackedLinks: { listByTemplates: vi.fn(async () => [lien({ avecJeton: false }), lien({ cardIndex: 0 })]), jetonPourE164: vi.fn(async () => 'jeton-abc') } });
    await envois.sendTemplate(T, W, NOM, LANGUE, []);
    expect(deps.trackedLinks.jetonPourE164).not.toHaveBeenCalled();
    expect(appels).toEqual([['sendTemplate', W, { name: NOM, language: LANGUE }]]);
  });

  it('une lecture des liens en échec part sans suffixe, et le dit', async () => {
    const { envois, appels } = monter({ trackedLinks: { listByTemplates: vi.fn(async () => { throw new Error('base indisponible'); }), jetonPourE164: vi.fn(async () => 'jeton-abc') } });
    expect(await envois.sendTemplate(T, W, NOM, LANGUE, [])).toEqual({ messageId: MESSAGE_ID });
    expect(erreurs).toHaveBeenCalledWith(`workflow sendTemplate: liens tracés de « ${NOM} » illisibles:`, 'base indisponible');
    expect(appels).toEqual([['sendTemplate', W, { name: NOM, language: LANGUE }]]);
  });
});

describe('sendQuickMessage', () => {
  const LIEN: LienBouton = { texte: 'Télécharger', url: 'https://exemple.fr/brochure.pdf' };

  it('un texte vide refuse, sans chercher le client', async () => {
    const { envois, deps } = monter();
    expect(await envois.sendQuickMessage(T, W, '   ', [])).toBe('le bloc « message rapide » n\'a pas de texte');
    expect(deps.clientWhatsApp).not.toHaveBeenCalled();
  });

  it('🔴 un lien inutilisable REFUSE l’envoi, il ne laisse pas partir un message nu', async () => {
    // Le client a coché la case : lui livrer le texte seul parce que l'adresse manque, c'est exactement le
    // silence que ce bloc ferme déjà pour le visuel non préparable.
    for (const lien of [{ texte: ' ', url: 'https://exemple.fr' }, { texte: 'Voir', url: '' }, { texte: 'Voir', url: 'javascript:alert(1)' }]) {
      const { envois, deps, appels } = monter();
      const r = await envois.sendQuickMessage(T, W, 'La brochure', [], undefined, lien);
      expect(r).toBe(problemeLienBouton(lien));
      expect(r).toBeTruthy();
      expect(deps.clientWhatsApp).not.toHaveBeenCalled();
      expect(appels).toEqual([]);
    }
  });

  it('🔴 un bloc à lien part en `cta_url`, jamais en message à boutons', async () => {
    // Le lien est le SIXIÈME paramètre : une implémentation à cinq paramètres le perdrait et partirait en boutons.
    // Le moteur vide déjà `buttons` ; même s'il en arrive, le lien passe en premier.
    const { envois, appels } = monter();
    await envois.sendQuickMessage(T, W, 'La brochure', [{ type: 'QUICK_REPLY', text: 'Oui' }], undefined, LIEN);
    expect(appels).toEqual([['sendCtaUrl', W, 'La brochure', LIEN, undefined]]);
  });

  it('un bloc à lien et à visuel porte le visuel en en-tête du `cta_url`', async () => {
    const { envois, appels } = monter();
    await envois.sendQuickMessage(T, W, 'La brochure', [], 'https://console/v.jpg', LIEN);
    expect(appels).toEqual([['sendCtaUrl', W, 'La brochure', LIEN, 'media-entete']]);
  });

  it('🔴 la branche à boutons reste atteignable, et la liste part ENTIÈRE', async () => {
    // `sendInteractive` écarte les titres vides en gardant l'index d'origine dans `btn:<i>` : filtrer avant
    // renumérotait, et la réponse « Non » ne correspondait plus à aucune branche.
    const boutons = [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'QUICK_REPLY', text: ' ' }, { type: 'QUICK_REPLY', text: 'Non' }];
    const { envois, appels } = monter();
    await envois.sendQuickMessage(T, W, 'Vous venez ?', boutons);
    expect(appels).toEqual([['sendInteractive', W, 'Vous venez ?', [
      { type: 'QUICK_REPLY', text: 'Oui' }, { type: 'QUICK_REPLY', text: ' ' }, { type: 'QUICK_REPLY', text: 'Non' },
    ], undefined]]);
  });

  it('des boutons avec un visuel : le visuel part en en-tête du message à boutons', async () => {
    const boutons = [{ type: 'QUICK_REPLY', text: 'Oui' }];
    const { envois, appels } = monter();
    await envois.sendQuickMessage(T, W, 'Vous venez ?', boutons, 'https://console/v.jpg');
    expect(appels).toEqual([['sendInteractive', W, 'Vous venez ?', boutons, 'media-entete']]);
  });

  it('un visuel sans bouton part en image légendée, l’adresse rognée', async () => {
    const { envois, deps, appels } = monter();
    await envois.sendQuickMessage(T, W, 'Notre affiche', [], '  https://console/v.jpg  ');
    expect(deps.prepareHeaderMedia).toHaveBeenCalledWith(T, 'https://console/v.jpg');
    expect(appels).toEqual([['sendImage', W, 'media-entete', 'Notre affiche']]);
  });

  it('ni visuel ni bouton utilisable : texte simple, et une adresse vide ne prépare rien', async () => {
    const { envois, deps, appels } = monter();
    await envois.sendQuickMessage(T, W, 'Bonjour', [{ type: 'QUICK_REPLY', text: '  ' }], '   ');
    expect(deps.prepareHeaderMedia).not.toHaveBeenCalled();
    expect(appels).toEqual([['sendText', W, 'Bonjour']]);
  });

  it('un visuel non préparé refuse, jamais un envoi sans l’image demandée', async () => {
    const { envois, appels, journal } = monter({ prepareHeaderMedia: vi.fn(async () => null) });
    expect(await envois.sendQuickMessage(T, W, 'Notre affiche', [], 'https://console/v.jpg'))
      .toBe('le visuel du bloc « message rapide » n’a pas pu être préparé pour l’envoi');
    expect(appels).toEqual([]);
    expect(journal).toEqual([]);
  });
});

describe('sendQuestion', () => {
  it('un texte vide refuse, sans chercher le client', async () => {
    const { envois, deps } = monter();
    expect(await envois.sendQuestion(T, W, ' ', 'Choisir', [{ title: 'A' }])).toBe('le bloc « question » n\'a pas de texte');
    expect(deps.clientWhatsApp).not.toHaveBeenCalled();
  });

  it('les variables sont rendues dans le corps et les lignes, la fiche lue une fois, les lignes vides gardées', async () => {
    const { envois, deps, appels, journal } = monter({ varsDuContact: vi.fn(async () => ({ prenom: 'Camille', ville: 'Lyon' })) });
    await envois.sendQuestion(T, W, 'Bonjour {{prenom}}', 'Choisir', [
      { title: 'Oui {{prenom}}', description: 'à {{ville}}' }, { title: 'Non' }, { title: '' },
    ]);
    expect(deps.varsDuContact).toHaveBeenCalledTimes(1);
    expect(deps.varsDuContact).toHaveBeenCalledWith(T, W);
    // `rows` part entier : `sendList` écarte les lignes vides APRÈS numérotation (`row:<i>`).
    expect(appels).toEqual([['sendList', W, 'Bonjour Camille', 'Choisir', [
      { title: 'Oui Camille', description: 'à Lyon' }, { title: 'Non' }, { title: '' },
    ]]]);
    // Le fil porte ce que le contact a reçu, variables résolues.
    expect(ligneDuFil(journal)).toEqual({ body: 'Bonjour Camille', messageId: MESSAGE_ID, type: 'text', origine: 'scenario' });
  });

  it('une variable dans une seule ligne suffit à lire la fiche', async () => {
    const { envois, deps, appels } = monter({ varsDuContact: vi.fn(async () => ({ prenom: 'Camille' })) });
    await envois.sendQuestion(T, W, 'Qui êtes-vous ?', 'Choisir', [{ title: 'Je suis {{prenom}}' }]);
    expect(deps.varsDuContact).toHaveBeenCalledTimes(1);
    expect(appels).toEqual([['sendList', W, 'Qui êtes-vous ?', 'Choisir', [{ title: 'Je suis Camille' }]]]);
  });

  it('sans variable, la fiche n’est pas lue et les lignes partent telles quelles', async () => {
    const lignes = [{ title: 'A' }, { title: '' }, { title: 'C', description: 'troisième' }];
    const { envois, deps, appels } = monter();
    await envois.sendQuestion(T, W, 'Votre choix ?', 'Choisir', lignes);
    expect(deps.varsDuContact).not.toHaveBeenCalled();
    expect(appels).toEqual([['sendList', W, 'Votre choix ?', 'Choisir', lignes]]);
    expect(appels[0]?.[4]).toBe(lignes);
  });

  it('aucune ligne à libellé : un texte simple, Meta refusant une liste vide', async () => {
    const { envois, appels } = monter();
    await envois.sendQuestion(T, W, 'Dites-nous tout', 'Choisir', [{ title: ' ' }, { title: '' }]);
    expect(appels).toEqual([['sendText', W, 'Dites-nous tout']]);
  });
});

describe('sendFlow', () => {
  it('un formulaire vide refuse, sans chercher le client', async () => {
    const { envois, deps } = monter();
    expect(await envois.sendFlow(T, W, '  ', 'Remplissez', 'Ouvrir')).toBe('le bloc « formulaire » ne désigne aucun formulaire');
    expect(deps.clientWhatsApp).not.toHaveBeenCalled();
  });

  it('le jeton de flow n’est jamais vide (Meta #131009)', async () => {
    const { envois, appels } = monter();
    await envois.sendFlow(T, W, 'flow-1', 'Remplissez le formulaire', 'Ouvrir');
    expect(appels).toEqual([['sendFlowMessage', W, {
      body: 'Remplissez le formulaire', flowId: 'flow-1', cta: 'Ouvrir', flowToken: expect.stringMatching(new RegExp(`^${W}-\\d+$`)),
    }]]);
  });
});

/** Un template tel que `tplClient.list` le rend, sans variable ni visuel. */
function template(o: Partial<TemplateSummary>): TemplateSummary {
  return { id: 'tpl-1', name: NOM, status: 'APPROVED', category: 'UTILITY', language: LANGUE, body: 'Bonjour', headerFormat: null, isCarousel: false, editable: true, ...o };
}

/**
 * Le VRAI câblage, monté sans base (ses dépôts ne font que retenir le pool, qui rend des lignes vides). On appelle
 * les dépendances qu'il a données à l'exécuteur : elles sont celles du module, avec le client de l'espace, le
 * cache des templates et le journal du câblage.
 */
function cablage(opts: { dryRun?: boolean; numero?: string | null; templates?: TemplateSummary[] } = {}) {
  const appels: Appel[] = [];
  const journal: unknown[][] = [];
  const clients: unknown[][] = [];
  const inerte = {} as never;
  const { executor, templateVarInfo } = buildWorkflowRuntime({
    pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    queue: { enqueue: async () => {} }, dryRun: opts.dryRun ?? false,
    repo: { getTenantWabaId: async () => 'waba-1' } as never,
    contactStore: { getResolvableByPhone: async () => null } as never,
    inboxStore: { recordOutboundByWaId: async (...a: unknown[]) => { journal.push(a); } } as never,
    settingsStore: inerte, workflowStore: inerte, metaCredentials: inerte,
    metaFactory: {
      clientForTenant: async (...a: unknown[]) => { clients.push(a); return fauxClient(appels); },
      templateClientForTenant: async () => ({ list: async () => opts.templates ?? [template({})] }),
    } as never,
    rcsProvider: 'fake', emailTemplates: inerte, emailResolver: inerte,
    numeroDeLEspace: async () => (opts.numero === undefined ? 'pn-1' : opts.numero), runStore: inerte, fil: inerte,
  });
  // `deps` est privé à l'exécuteur : on lit les dépendances que le câblage lui a données.
  const deps = Reflect.get(executor, 'deps') as WorkflowExecutorDeps;
  return { deps, templateVarInfo, appels, journal, clients };
}

describe('le vrai câblage donne ces envois à l’exécuteur', () => {
  it('🔴 le sendQuickMessage de l’exécuteur reçoit `lien` en sixième paramètre et part en `cta_url`', async () => {
    // Ce qui traverse le câblage : une flèche à cinq paramètres posée entre l'exécuteur et le module compilerait,
    // et le lien disparaîtrait sans un mot.
    const lien: LienBouton = { texte: 'Voir', url: 'https://exemple.fr' };
    const { deps, appels, clients } = cablage();
    expect(await deps.sendQuickMessage(T, W, 'La brochure', [], undefined, lien)).toEqual({ messageId: MESSAGE_ID });
    expect(clients).toEqual([[T, 'pn-1']]);
    expect(appels).toEqual([['sendCtaUrl', W, 'La brochure', lien, undefined]]);
  });

  it('🔴 DRY_RUN traverse le câblage : aucun des quatre envois ne construit de client', async () => {
    const { deps, appels, clients, journal } = cablage({ dryRun: true });
    expect(await deps.sendTemplate(T, W, NOM, LANGUE, [])).toBeUndefined();
    expect(await deps.sendQuickMessage(T, W, 'Bonjour', [])).toBeUndefined();
    expect(await deps.sendQuestion(T, W, 'Votre choix ?', 'Choisir', [{ title: 'A' }])).toBeUndefined();
    expect(await deps.sendFlow(T, W, 'flow-1', 'Remplissez', 'Ouvrir')).toBeUndefined();
    expect(clients).toEqual([]);
    expect(appels).toEqual([]);
    expect(journal).toEqual([]);
  });

  it('sans numéro, chaque envoi rend le refus et le journal d’erreur nomme ce qui n’est pas parti', async () => {
    const { deps, clients } = cablage({ numero: null });
    expect(await deps.sendTemplate(T, W, NOM, LANGUE, [])).toBe(SANS_NUMERO);
    expect(await deps.sendQuickMessage(T, W, 'Bonjour', [])).toBe(SANS_NUMERO);
    expect(await deps.sendQuestion(T, W, 'Votre choix ?', 'Choisir', [{ title: 'A' }])).toBe(SANS_NUMERO);
    expect(await deps.sendFlow(T, W, 'flow-1', 'Remplissez', 'Ouvrir')).toBe(SANS_NUMERO);
    expect(clients).toEqual([]);
    expect(erreurs.mock.calls).toEqual([
      [`workflow sendTemplate: aucun numéro pour le tenant ${T}, template « ${NOM} » non envoyé`],
      [`workflow sendQuickMessage: aucun numéro pour le tenant ${T}, message rapide non envoyé à ${W}`],
      [`workflow sendQuestion: aucun numéro pour le tenant ${T}, question non envoyée à ${W}`],
      [`workflow sendFlow: aucun numéro pour le tenant ${T}, formulaire non envoyé à ${W}`],
    ]);
  });
});
