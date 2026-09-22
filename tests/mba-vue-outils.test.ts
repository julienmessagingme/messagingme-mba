import { describe, it, expect } from 'vitest';
import { vueOutilMba, type ContexteVue } from '../src/mba/vue-outils';
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
  workflows: new Map(), ...over,
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
      sourceId: 's', mcpNonActivable: null, mcpIndisponibleLe: null,
      consommateurs: [
        { cle: 'agent:a1', actif: true, agentId: 'a1', agentLabel: 'Support' },
        { cle: 'mba:pn1', actif: true, agentId: null, agentLabel: null },
      ],
    };
    const v = vueOutilMba(outil({ origin: 'http', requestId: 'rq1' }), ctx({ bibliotheque: new Map([['o1', entree]]) }));
    expect(v.aussiUtilisePar).toEqual(['Support']);
    expect(v.cible).toEqual({ type: 'connecteur', requeteId: 'rq1', libelle: 'Poser une étiquette' });
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
