import { describe, it, expect } from 'vitest';
import { outilsMcpProposables, vueOutilMba, type ContexteVue } from '../src/mba/vue-outils';
import type { OutilComplet, OutilBibliotheque } from '../src/agent/catalog';

/**
 * La ligne d'un outil dans l'onglet « Outils » de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 9.1).
 * 🔴 CE QUE CE FICHIER PROTÈGE : ce qui manque se DIT (un champ supprimé, un appel supprimé, un outil illisible,
 * un outil désactivé). Un outil dont la cible a disparu refuse à chaque appel ; sans sa ligne rouge, personne
 * ne le saurait.
 */
const outil = (over: Partial<OutilComplet>): OutilComplet => ({
  id: 'o1', tenantId: 't1', origin: 'mba', name: 'n', description: 'd', nePasUtiliser: 'p', gestes: [], params: [],
  binding: {}, sourceId: null, requestId: null, nature: 'integre', outputPaths: [], risk: 'write', timeoutMs: 5000,
  maxBytes: 16384, autonome: false, mcpAnnonce: null, mcpNonActivable: null, mcpIndisponibleLe: null, mcpVuLe: null,
  title: 'T', actif: true, activeLe: null, autonomeLe: null, ...over,
});
const ctx = (over: Partial<ContexteVue> = {}): ContexteVue => ({
  requetes: new Map([['rq1', { label: 'Poser une étiquette' }]]), champs: new Set(['ville']), bibliotheque: new Map(),
  workflows: new Map(), serveurs: new Map([['s1', { label: 'notion' }]]), ...over,
});
const entreeBiblio = (over: Partial<OutilBibliotheque>): OutilBibliotheque => ({
  id: 'o1', name: 'notion_search', title: 'Chercher', description: 'd', nePasUtiliser: 'p', origin: 'mcp', risk: 'read',
  sourceId: 's1', mcpNonActivable: null, mcpIndisponibleLe: null, mcpPropose: true, consommateurs: [], ...over,
});

describe('la ligne d’un outil dans l’onglet', () => {
  it('un tag : son type et sa cible', () => {
    expect(vueOutilMba(outil({ binding: { handler: 'tag_fixe', tag: 'vip' } }), ctx()))
      .toMatchObject({ type: 'tag', cible: { type: 'tag', tag: 'vip' }, cibleManquante: null, actif: true, risque: 'write' });
  });

  it('🔴 un champ supprimé du mini-CRM est SIGNALÉ', () => {
    const v = vueOutilMba(outil({ binding: { handler: 'champ_fixe', champ: 'code_postal', valeurs: [] } }), ctx());
    expect(v.type).toBe('champ');
    expect(v.cibleManquante).toContain('code_postal');
  });

  it('🔴 un connecteur dont l’appel a été supprimé est SIGNALÉ', () => {
    const v = vueOutilMba(outil({ origin: 'http', requestId: 'rq9' }), ctx());
    expect(v).toMatchObject({ type: 'connecteur', cible: { type: 'connecteur', requeteId: 'rq9', libelle: null } });
    expect(v.cibleManquante).toContain('Connecteurs API');
  });

  it('🔴 un connecteur partagé NOMME les agents IA qui s’en servent, pas l’agent de Meta', () => {
    const entree: OutilBibliotheque = {
      id: 'o1', name: 'n', title: 'T', description: 'd', nePasUtiliser: 'p', origin: 'http', risk: 'write',
      sourceId: 's', mcpNonActivable: null, mcpIndisponibleLe: null, mcpPropose: true,
      consommateurs: [
        { cle: 'agent:a1', actif: true, agentId: 'a1', agentLabel: 'Support' },
        { cle: 'mba:pn1', actif: true, agentId: null, agentLabel: null },
      ],
    };
    const v = vueOutilMba(outil({ origin: 'http', requestId: 'rq1' }), ctx({ bibliotheque: new Map([['o1', entree]]) }));
    expect(v.aussiUtilisePar).toEqual(['Support']);
    expect(v.cible).toEqual({ type: 'connecteur', requeteId: 'rq1', libelle: 'Poser une étiquette' });
  });

  it('🔴 un outil MCP : son serveur nommé, les agents IA qui le partagent, et il part chez Meta', () => {
    const entree = entreeBiblio({ consommateurs: [
      { cle: 'agent:a1', actif: true, agentId: 'a1', agentLabel: 'Support' },
      { cle: 'mba:pn1', actif: true, agentId: null, agentLabel: null },
    ] });
    const v = vueOutilMba(outil({ origin: 'mcp', sourceId: 's1' }), ctx({ bibliotheque: new Map([['o1', entree]]) }));
    expect(v).toMatchObject({ type: 'mcp', cible: { type: 'mcp', sourceId: 's1', serveur: 'notion' }, cibleManquante: null, publiable: true });
    expect(v.aussiUtilisePar).toEqual(['Support']);
  });

  it('🔴 un outil MCP disparu de son serveur, ou non activable, est SIGNALÉ et ne part pas', () => {
    const disparu = vueOutilMba(outil({ origin: 'mcp', sourceId: 's1', mcpIndisponibleLe: new Date() }), ctx());
    expect(disparu).toMatchObject({ type: 'mcp', publiable: false, cibleManquante: expect.stringContaining('disparu') });
    const refuse = vueOutilMba(outil({ origin: 'mcp', sourceId: 's1', mcpNonActivable: 'schéma illisible' }), ctx());
    expect(refuse).toMatchObject({ publiable: false, cibleManquante: 'schéma illisible' });
  });

  it('🔴 un outil maison illisible est montré comme tel, pas masqué', () => {
    expect(vueOutilMba(outil({ binding: { handler: 'poser_tag' } }), ctx()))
      .toMatchObject({ type: 'inconnu', cible: { type: 'inconnu' }, cibleManquante: expect.stringContaining('supprimez-le') });
  });

  it('🔴 un appel irréversible le DIT : l’agent de Meta l’exécute sans validation humaine', () => {
    expect(vueOutilMba(outil({ origin: 'http', requestId: 'rq1', risk: 'irreversible' }), ctx()).risque).toBe('irreversible');
  });

  it('🔴 un outil désactivé le dit (son auteur a quitté l’espace)', () => {
    expect(vueOutilMba(outil({ binding: { handler: 'tag_fixe', tag: 'vip' }, actif: false }), ctx()).actif).toBe(false);
  });
});

const WF = '11111111-1111-4111-8111-111111111111';
const CODE = `nod_abc_${'A'.repeat(26)}`;
const noeud = (type: string, data: Record<string, unknown>) =>
  ({ id: 'n1', type, position: { x: 0, y: 0 }, data: { code: CODE, name: 'Brochure', ...data } }) as never;

describe('les lignes d’un bloc et d’un scénario', () => {
  it('un bloc envoyable : son scénario et son nom, rien ne manque, et il se dit irréversible', () => {
    const workflows = new Map([[WF, { name: 'Accueil', graph: { nodes: [noeud('quick_message', { body: 'x', quickReplies: [] })], edges: [] } }]]);
    expect(vueOutilMba(outil({ binding: { handler: 'bloc_fixe', workflowId: WF, code: CODE }, risk: 'irreversible' }), ctx({ workflows })))
      .toMatchObject({
        type: 'bloc', cible: { type: 'bloc', workflowId: WF, code: CODE, scenario: 'Accueil', bloc: 'Brochure' },
        cibleManquante: null, risque: 'irreversible',
      });
  });

  it('🔴 un bloc DEVENU un bloc qui attend une réponse est signalé, avec la raison', () => {
    const workflows = new Map([[WF, { name: 'Accueil', graph: { nodes: [noeud('quick_message', { body: 'x', quickReplies: ['Oui'] })], edges: [] } }]]);
    expect(vueOutilMba(outil({ binding: { handler: 'bloc_fixe', workflowId: WF, code: CODE } }), ctx({ workflows })).cibleManquante)
      .toContain('Lancer un scénario');
  });

  it('🔴 un bloc supprimé du scénario, ou dont le scénario est supprimé, est signalé', () => {
    const vide = new Map([[WF, { name: 'Accueil', graph: { nodes: [], edges: [] } }]]);
    const v = vueOutilMba(outil({ binding: { handler: 'bloc_fixe', workflowId: WF, code: CODE } }), ctx({ workflows: vide }));
    expect(v.cibleManquante).toContain('n’existe plus');
    expect(v.cible).toMatchObject({ scenario: 'Accueil', bloc: null });
    expect(vueOutilMba(outil({ binding: { handler: 'bloc_fixe', workflowId: WF, code: CODE } }), ctx()).cibleManquante)
      .toContain('le scénario de ce bloc n’existe plus');
  });

  it('🔴 un scénario supprimé, ou vide, est signalé', () => {
    expect(vueOutilMba(outil({ binding: { handler: 'scenario_fixe', workflowId: WF } }), ctx()).cibleManquante).toContain('n’existe plus');
    const vide = new Map([[WF, { name: 'Vide', graph: { nodes: [], edges: [] } }]]);
    expect(vueOutilMba(outil({ binding: { handler: 'scenario_fixe', workflowId: WF } }), ctx({ workflows: vide })))
      .toMatchObject({ type: 'scenario', cible: { type: 'scenario', scenario: 'Vide' }, cibleManquante: expect.stringContaining('vide') });
  });
});

describe('les outils MCP proposés à l’agent de Meta', () => {
  const serveurs = new Map([['s1', { label: 'notion' }]]);

  it('🔴 seulement les MCP appelables qui ne sont pas déjà à lui, serveur nommé', () => {
    const biblio = [
      entreeBiblio({ id: 'libre', consommateurs: [{ cle: 'agent:a1', actif: true, agentId: 'a1', agentLabel: 'Support' }] }),
      entreeBiblio({ id: 'deja', consommateurs: [{ cle: 'mba:pn1', actif: false, agentId: null, agentLabel: null }] }),
      entreeBiblio({ id: 'disparu', mcpIndisponibleLe: '2026-10-01T00:00:00Z' }),
      entreeBiblio({ id: 'refuse', mcpNonActivable: 'schéma illisible' }),
      entreeBiblio({ id: 'http', origin: 'http' }),
      // Décoché sur Tools > Connecteurs MCP (0199) : il ne s'offre à aucun agent.
      entreeBiblio({ id: 'decoche', mcpPropose: false }),
    ];
    expect(outilsMcpProposables(biblio, 'mba:pn1', serveurs)).toEqual([{
      id: 'libre', name: 'notion_search', title: 'Chercher', description: 'd', serveur: 'notion', risque: 'read',
      aussiUtilisePar: ['Support'],
    }]);
  });

  it('⚠️ un outil d’un AUTRE numéro reste proposable : le consentement est par numéro', () => {
    const biblio = [entreeBiblio({ consommateurs: [{ cle: 'mba:autre', actif: true, agentId: null, agentLabel: null }] })];
    expect(outilsMcpProposables(biblio, 'mba:pn1', serveurs).map((o) => o.id)).toEqual(['o1']);
  });
});
