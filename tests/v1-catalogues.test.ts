// tests/v1-catalogues.test.ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { sha256Hex } from '../src/lib/signature';
import { makeRequireApiKey, requireScope } from '../src/auth/api-key';
import { RateLimiter } from '../src/auth/rate-limit';
import { plafondsDeTest } from './aide/plafonds';
import { GardeUsageMemoire } from '../src/api/usage-guard.memoire';
import { unitesDe, estLourde } from '../src/api/usage-guard';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { TemplateSummary } from '../src/meta/templates';
import type { OutboundCarouselCard } from '../src/meta/template-components';
import { verdictModele } from '../src/api/modele-envoi';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from '../src/workflow/graph';
import type { RcsOutbound } from '../src/rcs/types';
import type { IndiceDuTemplate } from '../src/crm/template-hints.pg';
import { canalDOuverture } from '../src/workflow/store.pg';
import type { ScenarioPublie } from '../src/workflow/store.pg';
import { modeleDOuverture, ouvertureApi } from '../src/workflow/ouverture-api';
import type { OuvertureApi } from '../src/workflow/ouverture-api';
import {
  catalogueTemplates, catalogueScenarios, catalogueMessagesRcs, registerV1Catalogues,
} from '../src/http/v1-catalogues';
import type { V1CataloguesRouteDeps } from '../src/http/v1-catalogues';
import { resolveNode } from '../src/ids/resolve';
import { newTrackingCode } from '../src/ids/code';
import { estLienTraceAvecJeton, lienDe, lienTraceAvecJeton } from '../src/links/rewrite';
import { MetaApiError } from '../src/meta/errors';
import { buildServer, CORPS_OPAQUE_5XX } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { cleApiDeTest } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';

/**
 * LES CATALOGUES DE L'API PUBLIQUE (lot 4, spec du 2026-09-24 § 6).
 *
 * 🔴 CE QUE CES CAS PROTÈGENT : chaque ligne d'un catalogue peut partir par `POST /v1/sends`. Un template
 * non approuvé, une catégorie que l'envoi ne connaît pas, un carrousel ou un en-tête que le moteur refuserait
 * avant de partir, un scénario dont l'ouverture diffère de celle que l'envoi calculera : tout cela ferait
 * construire à un intégrateur un appel refusé, sans qu'aucune erreur ne le lui dise avant son premier envoi.
 * Chaque tri est tenu en PARITÉ avec la fonction de l'envoi, jamais avec une règle recopiée.
 */

// --- Fixtures ----------------------------------------------------------------------------------------------

const modele = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: 'tpl-1',
  name: 'confirmation_commande',
  status: 'APPROVED',
  category: 'UTILITY',
  language: 'fr',
  body: 'Bonjour {{1}}, votre commande {{2}} est confirmée.',
  headerFormat: null,
  isCarousel: false,
  editable: true,
  ...over,
});

const noeud = (id: string, type: WorkflowNode['type'], data: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, position: { x: 0, y: 0 }, data });
const arete = (source: string, target: string, sourceHandle?: string): WorkflowEdge =>
  ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const graphe = (nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowGraph => ({ nodes, edges });
const ligne = (graph: WorkflowGraph, name = 'Scénario'): ScenarioPublie =>
  ({ code: 'scn_k3f9qa_01j8z3m4v6x7y8z9a0b1c2d3e4', name, publishedAt: '2026-09-20T08:30:00.000Z', graph });

// --- Templates ---------------------------------------------------------------------------------------------

describe('GET /v1/templates : ce qui entre au catalogue', () => {
  it('🔴 seuls les templates APPROUVÉS entrent', () => {
    const sortie = catalogueTemplates([
      modele({ name: 'a_approuve' }),
      modele({ name: 'b_en_attente', status: 'PENDING' }),
      modele({ name: 'c_refuse', status: 'REJECTED' }),
      modele({ name: 'd_en_pause', status: 'PAUSED' }),
    ], []);
    expect(sortie.map((t) => t.name)).toEqual(['a_approuve']);
  });

  it('🔴 une catégorie que l’envoi ne connaît pas n’entre pas (authentification)', () => {
    const sortie = catalogueTemplates([modele({ name: 'code_otp', category: 'AUTHENTICATION' }), modele()], []);
    expect(sortie.map((t) => t.name)).toEqual(['confirmation_commande']);
    expect(sortie[0]!.category).toBe('utility');
  });

  /**
   * 🔴 LA PARITÉ AVEC `POST /v1/sends` SUR LE STATUT ET LA CATÉGORIE. Les valeurs attendues sont celles de la
   * spec (§ 3 et § 6 : approuvé, et `marketing` ou `utility`), ET chaque cas est comparé à `verdictModele`, la
   * lecture de l'envoi : une règle voisine écrite ici divergerait un jour sans bruit.
   *
   * ⚠️ `count` (le nombre de variables du corps) est exigé par `ModeleLu` depuis le lot 3 ; il ne joue pas
   * sur le statut, d'où 0 ici.
   */
  it('🔴 statut et catégorie : un template entre si et seulement si l’envoi l’accepterait', () => {
    const cas: Array<{ over: Partial<TemplateSummary>; entre: boolean }> = [
      { over: { status: 'APPROVED', category: 'MARKETING' }, entre: true },
      { over: { status: 'APPROVED', category: 'UTILITY' }, entre: true },
      { over: { status: 'APPROVED', category: 'AUTHENTICATION' }, entre: false },
      { over: { status: 'APPROVED', category: '' }, entre: false },
      { over: { status: 'PENDING', category: 'UTILITY' }, entre: false },
      { over: { status: 'REJECTED', category: 'MARKETING' }, entre: false },
      { over: { status: '', category: 'UTILITY' }, entre: false },
    ];
    for (const { over, entre } of cas) {
      const t = modele(over);
      const rendu = catalogueTemplates([t], []).length === 1;
      const envoi = verdictModele({ statut: t.status, langue: t.language, category: t.category.toLowerCase(), count: 0, nonEnvoyable: null }, t.language);
      expect(rendu, `la valeur de la spec : ${JSON.stringify(over)}`).toBe(entre);
      expect(rendu, `la lecture de /v1/sends : ${JSON.stringify(over)}`).toBe(envoi.statut === 'approuve');
    }
  });

  it('l’en-tête est nommé en minuscules, et un format qu’un envoi ne sait pas remplir n’entre pas', () => {
    const visuel = 'https://exemple.test/visuel.jpg';
    const sortie = catalogueTemplates([
      modele({ name: 'a', headerFormat: null }),
      modele({ name: 'b', headerFormat: 'TEXT' }),
      modele({ name: 'c', headerFormat: 'IMAGE', headerMediaUrl: visuel }),
      modele({ name: 'd', headerFormat: 'VIDEO', headerMediaUrl: visuel }),
      modele({ name: 'e', headerFormat: 'DOCUMENT', headerMediaUrl: visuel }),
      modele({ name: 'f', headerFormat: 'LOCATION' }),
      // Un format inconnu qui porte le nom d'une propriété d'objet : la table est une Map, il ne passe pas.
      modele({ name: 'g', headerFormat: 'toString' }),
    ], []);
    expect(sortie.map((t) => [t.name, t.header])).toEqual([
      ['a', 'none'], ['b', 'text'], ['c', 'image'], ['d', 'video'], ['e', 'document'],
    ]);
  });

  /**
   * 🔴 CE QUE LE MOTEUR D'ENVOI REFUSE AVANT DE PARTIR n'entre pas, jugé par SES fonctions
   * (`carouselSendBlocker`, `headerMediaSendBlocker`) : une carte ou un lien de carte qui porte une variable
   * (rien ne stocke sa valeur), une carte ou un en-tête sans visuel lisible (Meta l'exige à chaque envoi).
   * Annoncés, ils feraient partir un envoi que la campagne refuse en entier.
   */
  it('🔴 un carrousel à variable, une carte sans visuel, un en-tête média sans adresse n’entrent pas', () => {
    const carte = (over: Partial<OutboundCarouselCard> = {}): OutboundCarouselCard => ({
      mediaUrl: 'https://exemple.test/carte.jpg', mediaFormat: 'IMAGE', body: 'Découvrez la collection',
      buttons: [{ type: 'QUICK_REPLY', text: 'Je veux voir' }], ...over,
    });
    const sortie = catalogueTemplates([
      modele({ name: 'a_carrousel', isCarousel: true, carousel: { cards: [carte(), carte()] } }),
      modele({ name: 'b_carte_a_variable', isCarousel: true, carousel: { cards: [carte(), carte({ body: 'Pour {{1}}' })] } }),
      modele({
        name: 'c_lien_a_variable', isCarousel: true,
        carousel: { cards: [carte({ buttons: [{ type: 'URL', text: 'Voir', url: 'https://exemple.test/p/{{1}}' }] })] },
      }),
      modele({ name: 'd_carte_sans_visuel', isCarousel: true, carousel: { cards: [carte({ mediaUrl: undefined })] } }),
      modele({ name: 'e_image_lisible', headerFormat: 'IMAGE', headerMediaUrl: 'https://exemple.test/visuel.jpg' }),
      modele({ name: 'f_image_sans_adresse', headerFormat: 'IMAGE' }),
    ], []);
    // Un carrousel a ses visuels par carte, sans en-tête de premier niveau : `none`.
    expect(sortie.map((t) => [t.name, t.header])).toEqual([['a_carrousel', 'none'], ['e_image_lisible', 'image']]);
  });

  /**
   * 🔴 UN PARAMÈTRE QU'AUCUN ENVOI NE REMPLIT n'entre pas : Meta refuserait chaque message (132000) après un
   * 201 qui annonçait le contraire. `buildTemplateComponents` ne produit aucun paramètre d'en-tête texte, et ne
   * remplit une adresse de bouton que pour un lien tracé à jeton (`suffixesBoutons`). Chaque cas « n'entre pas »
   * a son jumeau qui ENTRE : sans lui, une règle qui écarterait tout en-tête texte ou tout bouton de lien
   * passerait ces cas en écartant des templates parfaitement envoyables.
   */
  describe('🔴 un paramètre qu’aucun envoi ne remplit n’entre pas', () => {
    const base = 'https://api.messagingme.app';
    const lienTrace = lienTraceAvecJeton(base, 'k3f9qa01j8z3');
    const bouton = (url: string) => ({ type: 'URL' as const, text: 'Voir', url });

    it('un en-tête TEXTE à variable n’entre pas ; un en-tête texte fixe entre', () => {
      const sortie = catalogueTemplates([
        modele({ name: 'a_entete_fixe', headerFormat: 'TEXT', headerText: 'Votre commande' }),
        modele({ name: 'b_entete_a_variable', headerFormat: 'TEXT', headerText: 'Commande {{1}}' }),
      ], []);
      expect(sortie.map((t) => [t.name, t.header])).toEqual([['a_entete_fixe', 'text']]);
    });

    it('un bouton de lien à variable n’entre pas, SAUF un lien tracé à jeton ; un lien fixe entre', () => {
      const sortie = catalogueTemplates([
        modele({ name: 'a_lien_fixe', buttons: [bouton('https://exemple.test/commande')] }),
        modele({ name: 'b_lien_a_variable', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }, bouton('https://exemple.test/p/{{1}}')] }),
        modele({ name: 'c_lien_trace', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }, bouton(lienTrace)] }),
        // La forme de nos liens, sur un code qui n'en est pas un : aucun lien tracé ne la produit.
        modele({ name: 'd_imitation', buttons: [bouton(`${base}/r/pas-un-code/{{1}}`)] }),
      ], []);
      expect(sortie.map((t) => t.name)).toEqual(['a_lien_fixe', 'c_lien_trace']);
    });

    it('🔴 la forme reconnue est CELLE du producteur des liens tracés, sur des codes du vrai générateur', () => {
      for (let i = 0; i < 200; i += 1) {
        const code = newTrackingCode();
        expect(estLienTraceAvecJeton(lienTraceAvecJeton(base, code)), code).toBe(true);
        // Le lien d'AVANT le jeton n'a pas de variable : il n'a rien à remplir, et ce n'est pas lui qu'on cherche.
        expect(estLienTraceAvecJeton(lienDe(base, code)), code).toBe(false);
      }
    });
  });

  it('🔴 chaque {{n}} du corps est une variable, avec la source que la console connaît, sinon null', () => {
    const indices: IndiceDuTemplate[] = [
      { name: 'confirmation_commande', language: 'fr', position: 1, source: { type: 'field', key: 'prenom' } },
      // Même template, AUTRE langue : ne doit pas déborder sur le français.
      { name: 'confirmation_commande', language: 'en', position: 2, source: { type: 'attribute', key: 'name' } },
    ];
    const [t] = catalogueTemplates([modele({ body: 'Bonjour {{1}}, commande {{3}}.' })], indices);
    // Corps non contigu : Meta attend 3 paramètres, pas 2 (countTemplateVariables).
    expect(t!.variables).toEqual([
      { position: 1, source: { type: 'field', key: 'prenom' } },
      { position: 2, source: null },
      { position: 3, source: null },
    ]);
  });

  it('🔴 un indice illisible en base ne sort pas : il devient null, jamais une valeur inventée', () => {
    const casse = { name: 'confirmation_commande', language: 'fr', position: 1, source: { type: 'inconnu' } } as unknown as IndiceDuTemplate;
    const [t] = catalogueTemplates([modele()], [casse]);
    expect(t!.variables[0]).toEqual({ position: 1, source: null });
  });

  it('un corps sans variable rend une liste vide, et le catalogue est trié par nom puis langue', () => {
    const sortie = catalogueTemplates([
      modele({ name: 'b', language: 'fr', body: 'Merci.' }),
      modele({ name: 'a', language: 'fr', body: 'Merci.' }),
      modele({ name: 'a', language: 'en', body: 'Thanks.' }),
    ], []);
    expect(sortie.map((t) => `${t.name}/${t.language}`)).toEqual(['a/en', 'a/fr', 'b/fr']);
    expect(sortie.every((t) => t.variables.length === 0)).toBe(true);
  });
});

// --- Scénarios : la parité d'ouverture (spec § 13) ---------------------------------------------------------

/**
 * 🔴 LA PARITÉ D'OUVERTURE, ET C'EST LE CAS LE PLUS IMPORTANT DU FICHIER. Le catalogue, `/v1/sends` et la
 * console doivent dire la même chose d'un même graphe. Les valeurs attendues sont recopiées de la table de la
 * spec (§ 3, « Ce qu'un scénario ou un bloc envoie EN PREMIER »), pas lues dans le code : un test qui lit sa
 * réponse dans l'implémentation ne peut pas échouer.
 */
const CAS_OUVERTURE: Array<{ cas: string; graph: WorkflowGraph; ouverture: OuvertureApi | null }> = [
  { cas: 'template nommé', graph: graphe([noeud('t', 'template', { templateName: 'promo' })]), ouverture: 'whatsapp_template' },
  { cas: 'bloc RCS configuré', graph: graphe([noeud('r', 'rcs_message', { text: 'Bonjour' })]), ouverture: 'rcs' },
  {
    cas: 'RCS, puis template de repli sur la sortie « non joignable »',
    graph: graphe([noeud('r', 'rcs_message', { text: 'Bonjour' }), noeud('t', 'template', { templateName: 'promo' })], [arete('r', 't', 'unreachable')]),
    ouverture: 'rcs',
  },
  { cas: 'message rapide', graph: graphe([noeud('q', 'quick_message', { body: 'Coucou' })]), ouverture: 'whatsapp_session' },
  {
    cas: 'prudence : une branche en session, l’autre en template',
    graph: graphe(
      [noeud('c', 'condition'), noeud('q', 'quick_message', { body: 'Coucou' }), noeud('t', 'template', { templateName: 'promo' })],
      [arete('c', 'q', 'true'), arete('c', 't', 'false')],
    ),
    ouverture: 'whatsapp_session',
  },
  {
    cas: 'attente avant tout envoi',
    graph: graphe([noeud('w', 'wait', { seconds: 60 }), noeud('t', 'template', { templateName: 'promo' })], [arete('w', 't')]),
    ouverture: null,
  },
  {
    cas: 'deux templates différents possibles',
    graph: graphe(
      [noeud('c', 'condition'), noeud('a', 'template', { templateName: 'promo' }), noeud('b', 'template', { templateName: 'relance' })],
      [arete('c', 'a', 'true'), arete('c', 'b', 'false')],
    ),
    ouverture: null,
  },
  { cas: 'template sans nom', graph: graphe([noeud('t', 'template', { templateName: '  ' })]), ouverture: null },
  { cas: 'graphe vide', graph: graphe([]), ouverture: null },
];

/** Ce que la console déduit de la même ouverture : un canal de campagne, et rien pour une ouverture de session. */
const versCanal = (o: OuvertureApi | null): 'whatsapp' | 'rcs' | null =>
  (o === 'whatsapp_template' ? 'whatsapp' : o === 'rcs' ? 'rcs' : null);

describe('GET /v1/scenarios : l’ouverture est celle de l’envoi ET de la console', () => {
  it.each(CAS_OUVERTURE)('$cas', ({ graph, ouverture }) => {
    const [s] = catalogueScenarios([ligne(graph)]);
    expect(s!.opening, 'la valeur de la spec').toBe(ouverture);
    expect(s!.opening, 'la fonction de /v1/sends').toBe(ouvertureApi(graph).ouverture);
    expect(versCanal(s!.opening), 'la règle de la console').toBe(canalDOuverture(graph));
  });

  it('le catalogue rend le code, le nom, l’ouverture, son template, le bloc d’entrée et la date, jamais le graphe', () => {
    const [s] = catalogueScenarios([ligne(CAS_OUVERTURE[0]!.graph, 'Bienvenue')]);
    expect(Object.keys(s!).sort()).toEqual(['code', 'entryNode', 'name', 'opening', 'openingTemplate', 'publishedAt']);
  });
});

/**
 * 🔴 DE QUOI CONSTRUIRE L'APPEL, et pas seulement de quoi savoir s'il partira. Un scénario qui ouvre par un
 * template à variables exige `params` de la bonne longueur ; un scénario qui ouvre en message de session ne se
 * vise que par son bloc d'entrée. Sans ces deux lectures, l'intégrateur devait ouvrir la console.
 */
describe('GET /v1/scenarios : le template d’ouverture et le bloc d’entrée', () => {
  const CODE_T = 'nod_k3f9qa_01J8Z3N5W7X8Y9Z0A1B2C3D4E5';
  const CODE_Q = 'nod_k3f9qa_01J8Z3P6X8Y9Z0A1B2C3D4E5F6';

  it('🔴 une ouverture par template rend CE template, lu comme l’envoi le lira (langue fr par défaut)', () => {
    const cas: Array<{ graph: WorkflowGraph; attendu: { name: string; language: string } | null }> = [
      { graph: graphe([noeud('t', 'template', { templateName: 'promo' })]), attendu: { name: 'promo', language: 'fr' } },
      { graph: graphe([noeud('t', 'template', { templateName: 'promo', language: 'en' })]), attendu: { name: 'promo', language: 'en' } },
      // Un RCS qui ouvre, avec son template de REPLI : ce n'est pas lui qui part, et `params` y est refusé.
      { graph: CAS_OUVERTURE[2]!.graph, attendu: null },
      { graph: CAS_OUVERTURE[3]!.graph, attendu: null },
      { graph: CAS_OUVERTURE[5]!.graph, attendu: null },
    ];
    for (const { graph, attendu } of cas) {
      const [s] = catalogueScenarios([ligne(graph)]);
      expect(s!.openingTemplate).toEqual(attendu);
      // La parité avec `/v1/sends` : la même fonction lit le template que `params` paramètre.
      const envoi = s!.opening === 'whatsapp_template' ? modeleDOuverture(graph) : null;
      expect(s!.openingTemplate).toEqual(envoi ? { name: envoi.templateName, language: envoi.language } : null);
    }
  });

  it('🔴 le bloc d’entrée est celui que la cible node retrouve, et le viser rend la MÊME ouverture', async () => {
    // L'entrée n'est PAS le premier bloc de la liste : c'est le bloc sans arête entrante (`entryNode`).
    const graph = graphe(
      [noeud('t', 'template', { templateName: 'promo', code: CODE_T }), noeud('q', 'quick_message', { body: 'Coucou', code: CODE_Q })],
      [arete('q', 't')],
    );
    const [s] = catalogueScenarios([ligne(graph)]);
    expect(s!.entryNode).toBe(CODE_Q);
    expect(s!.opening).toBe('whatsapp_session');
    const r = await resolveNode('t1', s!.entryNode!, { list: async () => [{ id: 'wf-1', code: 'scn_x', name: 'x', graph }] });
    expect(r).toMatchObject({ ok: true, value: { nodeId: 'q' } });
    expect(ouvertureApi(graph, 'q').ouverture).toBe(s!.opening);
  });

  it('un bloc d’entrée sans code public (ou dont le code n’en a pas la forme) rend null', () => {
    for (const code of [undefined, '', 'nod_x', 'return 1;']) {
      const [s] = catalogueScenarios([ligne(graphe([noeud('q', 'quick_message', { body: 'Coucou', ...(code === undefined ? {} : { code }) })]))]);
      expect(s!.entryNode, String(code)).toBeNull();
    }
    expect(catalogueScenarios([ligne(graphe([]))])[0]!.entryNode).toBeNull();
  });
});

// --- Messages RCS ------------------------------------------------------------------------------------------

describe('GET /v1/rcs-messages', () => {
  const texte: RcsOutbound = { kind: 'text', text: 'Bonjour {{prenom}}, rendez-vous le {{date_rdv}}.' };
  const carte: RcsOutbound = { kind: 'card', card: { title: 'Rappel', description: '{{prenom}}, à demain' } };

  it('rend le format et les variables du message, triés par nom', () => {
    expect(catalogueMessagesRcs([{ name: 'b-carte', content: carte }, { name: 'a-texte', content: texte }])).toEqual([
      { name: 'a-texte', kind: 'text', variables: ['prenom', 'date_rdv'] },
      { name: 'b-carte', kind: 'card', variables: ['prenom'] },
    ]);
  });

  it('🔴 un message dont le contenu stocké n’est plus reconnu n’entre pas : il ne partirait pas', () => {
    expect(catalogueMessagesRcs([{ name: 'illisible', content: null }, { name: 'ok', content: texte }]).map((m) => m.name))
      .toEqual(['ok']);
  });
});

// --- Les routes : garde, isolation, comptage ----------------------------------------------------------------

class FaussesCles implements ApiKeyLookup {
  private readonly parEmpreinte = new Map<string, { id: string; tenantId: string; scopes: string[]; tenantStatus?: string }>();
  ajouter(brute: string, rec: { id: string; tenantId: string; scopes: string[]; tenantStatus?: string }): this {
    this.parEmpreinte.set(sha256Hex(brute), rec);
    return this;
  }
  async findActiveByHash(hash: string) { return this.parEmpreinte.get(hash) ?? null; }
  async touchLastUsed(): Promise<void> {}
}

const CLE_ENVOIS = cleApiDeTest('catalogues_envois');
const CLE_CONTACTS = cleApiDeTest('catalogues_contacts');
/** Une clé d'un AUTRE espace, avec le même droit : c'est elle qui éprouve l'isolation. */
const CLE_T2 = cleApiDeTest('catalogues_espace_t2');
/** Une clé VALIDE d'un espace SUSPENDU (`tenants.status = 'locked'`). */
const CLE_VERROUILLEE = cleApiDeTest('catalogues_verrouillee');
const LES_TROIS = ['/v1/templates', '/v1/scenarios', '/v1/rcs-messages'] as const;

/**
 * `debitParEspace` : le plafond de l'espace par minute (défaut de production : 60, et 1 000 par heure).
 *
 * ⚠️ Chaque espace a SES données (l'espace `t1` celles des cas historiques, les autres des noms qui portent leur
 * espace) : une lecture qui recevrait le mauvais espace rendrait donc des lignes étrangères, pas seulement un
 * appel mal étiqueté.
 */
function monter(debitParEspace = 60) {
  const appels: string[] = [];
  const usage = new GardeUsageMemoire();
  const cles = new FaussesCles()
    .ajouter(CLE_ENVOIS, { id: 'k1', tenantId: 't1', scopes: ['sends:create'] })
    .ajouter(CLE_CONTACTS, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] })
    .ajouter(CLE_T2, { id: 'k3', tenantId: 't2', scopes: ['sends:create'] })
    .ajouter(CLE_VERROUILLEE, { id: 'k4', tenantId: 't3', scopes: ['sends:create'], tenantStatus: 'locked' });
  const deps: V1CataloguesRouteDeps = {
    usage,
    templates: async (t) => {
      appels.push(`templates:${t}`);
      return t === 't1' ? [modele(), modele({ name: 'en_attente', status: 'PENDING' })] : [modele({ name: `modele_${t}` })];
    },
    indicesDeVariables: async (t) => {
      appels.push(`indices:${t}`);
      return t === 't1' ? [{ name: 'confirmation_commande', language: 'fr', position: 1, source: { type: 'field', key: 'prenom' } }] : [];
    },
    scenariosPublies: async (t) => {
      appels.push(`scenarios:${t}`);
      return [ligne(CAS_OUVERTURE[0]!.graph, t === 't1' ? 'Bienvenue' : `Scénario ${t}`)];
    },
    messagesRcs: async (t) => {
      appels.push(`rcs:${t}`);
      return [{ name: t === 't1' ? 'rappel-rdv' : `message-${t}`, content: { kind: 'text', text: 'Bonjour {{prenom}}' } }];
    },
  };
  const app = Fastify({ logger: false });
  // La VRAIE garde de l'entrée /v1 : la clé, puis le droit. C'est elle, pas un faux, qui pose `req.auth`.
  registerV1Catalogues(app, deps, [
    makeRequireApiKey(cles, plafondsDeTest({ minute: debitParEspace }), new RateLimiter(1000, 60_000)),
    requireScope('sends:create'),
  ]);
  return { app, appels, usage };
}

const avec = (cle: string) => ({ authorization: `Bearer ${cle}` });

describe('les trois routes des catalogues', () => {
  it('🔴 une clé qui a `sends:create` lit les trois, et l’espace vient de la CLÉ', async () => {
    const { app, appels } = monter();
    const tpl = await app.inject({ method: 'GET', url: '/v1/templates', headers: avec(CLE_ENVOIS) });
    const scn = await app.inject({ method: 'GET', url: '/v1/scenarios', headers: avec(CLE_ENVOIS) });
    const rcs = await app.inject({ method: 'GET', url: '/v1/rcs-messages', headers: avec(CLE_ENVOIS) });
    expect([tpl.statusCode, scn.statusCode, rcs.statusCode]).toEqual([200, 200, 200]);
    expect(tpl.json()).toEqual({
      templates: [{
        name: 'confirmation_commande', language: 'fr', category: 'utility', header: 'none',
        variables: [{ position: 1, source: { type: 'field', key: 'prenom' } }, { position: 2, source: null }],
      }],
    });
    expect(scn.json()).toEqual({
      scenarios: [{
        code: 'scn_k3f9qa_01j8z3m4v6x7y8z9a0b1c2d3e4', name: 'Bienvenue', opening: 'whatsapp_template',
        openingTemplate: { name: 'promo', language: 'fr' }, entryNode: null, publishedAt: '2026-09-20T08:30:00.000Z',
      }],
    });
    expect(rcs.json()).toEqual({ rcsMessages: [{ name: 'rappel-rdv', kind: 'text', variables: ['prenom'] }] });
    // L'isolation : chaque lecture a reçu l'espace de la clé, et aucun autre.
    expect(appels.sort()).toEqual(['indices:t1', 'rcs:t1', 'scenarios:t1', 'templates:t1']);
    await app.close();
  });

  /**
   * 🔴 L'ISOLATION, ÉPROUVÉE AVEC DEUX ESPACES. Avec un seul, une route qui lirait un espace écrit en dur, ou
   * celui d'une autre requête, passerait le cas précédent. Ici la clé de `t2` doit recevoir les lignes de `t2`,
   * et AUCUNE lecture ne doit partir avec `t1`.
   */
  it('🔴 deux espaces : la clé de t2 ne lit que t2, et aucune lecture ne reçoit t1', async () => {
    const { app, appels } = monter();
    // La clé de t1 passe d'abord : une route qui retiendrait l'espace d'un appel précédent se trahirait ensuite.
    for (const url of LES_TROIS) await app.inject({ method: 'GET', url, headers: avec(CLE_ENVOIS) });
    appels.length = 0;
    const [tpl, scn, rcs] = await Promise.all(LES_TROIS.map((url) => app.inject({ method: 'GET', url, headers: avec(CLE_T2) })));
    expect([tpl!.statusCode, scn!.statusCode, rcs!.statusCode]).toEqual([200, 200, 200]);
    expect(tpl!.json<{ templates: Array<{ name: string }> }>().templates.map((t) => t.name)).toEqual(['modele_t2']);
    expect(scn!.json<{ scenarios: Array<{ name: string }> }>().scenarios.map((s) => s.name)).toEqual(['Scénario t2']);
    expect(rcs!.json<{ rcsMessages: Array<{ name: string }> }>().rcsMessages.map((m) => m.name)).toEqual(['message-t2']);
    expect(appels.sort()).toEqual(['indices:t2', 'rcs:t2', 'scenarios:t2', 'templates:t2']);
    expect(appels.filter((a) => a.endsWith(':t1'))).toEqual([]);
    await app.close();
  });

  /**
   * 🔴 UN ESPACE SUSPENDU N'A PLUS D'API, catalogues compris : 403 `tenant_locked` (la clé est bonne, un 401
   * l'enverrait en refaire une), et la page Documentation API documente ce code. Sur les TROIS routes : une
   * route montée derrière une autre garde passerait le cas d'une seule.
   */
  it('🔴 espace suspendu : 403 `tenant_locked` sur les trois routes, et rien n’est lu', async () => {
    const { app, appels } = monter();
    for (const url of LES_TROIS) {
      const res = await app.inject({ method: 'GET', url, headers: avec(CLE_VERROUILLEE) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toMatchObject({ code: 'tenant_locked' });
    }
    expect(appels).toEqual([]);
    await app.close();
  });

  /**
   * 🔴 LES REFUS DE LA GARDE PORTENT LEUR CODE, pas seulement leur statut : la page Documentation API
   * documente `missing_scope`, `unauthorized` et `rate_limited`, et affirme la forme `{ error, code }`. Un
   * contrôle du seul statut laisserait la page mentir sans qu'aucun test ne le voie.
   */
  it('🔴 une clé SANS `sends:create` est refusée en 403 `missing_scope`, et rien n’est lu', async () => {
    const { app, appels } = monter();
    for (const url of ['/v1/templates', '/v1/scenarios', '/v1/rcs-messages']) {
      const res = await app.inject({ method: 'GET', url, headers: avec(CLE_CONTACTS) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toMatchObject({ code: 'missing_scope' });
    }
    expect(appels).toEqual([]);
    await app.close();
  });

  it('🔴 sans clé : 401 `unauthorized`, et rien n’est lu', async () => {
    const { app, appels } = monter();
    const res = await app.inject({ method: 'GET', url: '/v1/templates' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthorized' });
    expect(appels).toEqual([]);
    await app.close();
  });

  it('au-delà du débit de l’espace : 429 `rate_limited`, et la seconde lecture n’a pas lieu', async () => {
    const { app, appels } = monter(1);
    const premier = await app.inject({ method: 'GET', url: '/v1/scenarios', headers: avec(CLE_ENVOIS) });
    const second = await app.inject({ method: 'GET', url: '/v1/scenarios', headers: avec(CLE_ENVOIS) });
    expect([premier.statusCode, second.statusCode]).toEqual([200, 429]);
    expect(second.json()).toMatchObject({ code: 'rate_limited' });
    expect(appels).toEqual(['scenarios:t1']);
    await app.close();
  });

  it('chaque lecture COMPTE, une unité, sous `catalogues.read`', async () => {
    const { app, usage } = monter();
    for (const url of ['/v1/templates', '/v1/scenarios', '/v1/rcs-messages']) {
      await app.inject({ method: 'GET', url, headers: avec(CLE_ENVOIS) });
    }
    expect(usage.compteurs().find((c) => c.operation === 'catalogues.read')).toMatchObject({ appels: 3, unites: 3 });
    // Une lecture ne réserve pas de place lourde : la soumettre au plafond ferait refuser une consultation
    // pendant qu'un lot écrit.
    expect(unitesDe('catalogues.read')).toBe(1);
    expect(estLourde('catalogues.read')).toBe(false);
    await app.close();
  });
});

describe('monté dans l’entrée /v1 du registre', () => {
  function serveur(templates: V1CataloguesRouteDeps['templates'] = async () => [modele()]) {
    const cles = new FaussesCles()
      .ajouter(CLE_ENVOIS, { id: 'k1', tenantId: 't1', scopes: ['sends:create'] })
      .ajouter(CLE_CONTACTS, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] });
    return buildServer({
      queue: new FakeQueue(),
      v1: {
        apiKeys: cles,
        // Les routes de contacts sont montées mais jamais appelées ici : ce bloc éprouve le montage des
        // catalogues, pas les contacts (qui ont leurs propres tests).
        contacts: contactsV1Muets(),
        catalogues: {
          templates,
          indicesDeVariables: async () => [],
          scenariosPublies: async () => [],
          messagesRcs: async () => [],
        },
      },
    });
  }

  /**
   * 🔴 CE QU'UNE PANNE DE META REND, parce que la page Documentation API le dit mot pour mot, et que le plan du
   * lot 4 l'avait écrit faux (« 5xx sans corps »). Le catalogue n'attrape rien : le gestionnaire GLOBAL décide.
   * Un REFUS de Meta sort en 422 avec une phrase qui commence par « Meta: », une panne réseau en 500 opaque, et
   * dans les deux cas SANS `code` et JAMAIS en liste vide (qui ferait croire à l'intégrateur qu'il n'a aucun
   * template approuvé). Le jour où un code dédié est décidé (`todo.md`), ces deux cas tombent, et la page avec.
   */
  it('🔴 un REFUS de Meta pendant la lecture : 422, une phrase « Meta: … », sans code, jamais une liste vide', async () => {
    const server = serveur(async () => { throw new MetaApiError(400, { code: 190, message: 'Invalid OAuth access token' }); });
    const res = await server.inject({ method: 'GET', url: '/v1/templates', headers: avec(CLE_ENVOIS) });
    expect(res.statusCode).toBe(422);
    const corps = res.json<Record<string, unknown>>();
    expect(corps.error).toMatch(/^Meta: /);
    expect(Object.keys(corps)).toEqual(['error']);
    await server.close();
  });

  it('🔴 une panne RÉSEAU pendant la lecture : 500 au corps opaque, sans code', async () => {
    const server = serveur(async () => { throw new TypeError('fetch failed'); });
    const res = await server.inject({ method: 'GET', url: '/v1/templates', headers: avec(CLE_ENVOIS) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: CORPS_OPAQUE_5XX });
    await server.close();
  });

  it('🔴 la route répond derrière la VRAIE garde du registre, droit `sends:create` exigé', async () => {
    const server = serveur();
    const ok = await server.inject({ method: 'GET', url: '/v1/templates', headers: avec(CLE_ENVOIS) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ templates: unknown[] }>().templates).toHaveLength(1);
    const refus = await server.inject({ method: 'GET', url: '/v1/scenarios', headers: avec(CLE_CONTACTS) });
    expect(refus.statusCode).toBe(403);
    await server.close();
  });
});
