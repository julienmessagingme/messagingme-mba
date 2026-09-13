import { describe, it, expect } from 'vitest';
import { canalDOuverture } from '../src/workflow/store.pg';
import { isCampaignEligible } from '../web/lib/campaign-eligibility';
import type { GraphLike, GraphNodeLike } from '../web/lib/campaign-eligibility';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * PAR QUOI UN SCÉNARIO OUVRE.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, ET CE N'EST PAS « le canal est juste ». C'est que `campaignEligible`, un
 * contrat lu par TROIS écrans (l'assistant de campagne, la page Scénarios, le sélecteur de l'Inbox), ne
 * change PAS de valeur en gagnant un voisin. Le booléen est désormais DÉRIVÉ du canal : la parité avec la
 * règle d'origine, restée intacte côté navigateur, est donc la seule chose qui prouve que rien n'a bougé.
 *
 * ⚠️ La règle côté navigateur (`web/lib/campaign-eligibility.ts`) n'a pas été touchée par ce lot : c'est
 * pour ça qu'elle sert de témoin. Sa propre parité avec le serveur est gardée par
 * `tests/web-campaign-eligibility.test.ts`.
 */
const g = (nodes: GraphNodeLike[], edges: GraphLike['edges'] = []): GraphLike => ({ nodes, edges });
const n = (id: string, type: string, data: Record<string, unknown> = {}): GraphNodeLike => ({ id, type, data });
const canal = (graph: GraphLike) => canalDOuverture(graph as unknown as WorkflowGraph);

describe('le canal d’ouverture d’un scénario', () => {
  it('un scénario qui ouvre par un modèle NOMMÉ rend whatsapp', () => {
    expect(canal(g([n('a', 'template', { templateName: 'promo' })]))).toBe('whatsapp');
  });

  it('un scénario qui ouvre par un bloc RCS configuré rend rcs', () => {
    expect(canal(g([n('r', 'rcs_message', { text: 'Bonjour' })]))).toBe('rcs');
  });

  /**
   * 🔴 LE CAS QUI COMPTE. Un modèle sans nom n'enverrait rien : il ne peut donc ouvrir aucun canal, et
   * surtout pas « whatsapp » au motif que le bloc est de type template. C'est déjà ce que dit
   * `isCampaignEligible`, et le canal doit dire la même chose.
   */
  it('🔴 un modèle SANS NOM rend null, pas whatsapp', () => {
    expect(canal(g([n('a', 'template', { templateName: '   ' })]))).toBeNull();
    expect(canal(g([n('a', 'template')]))).toBeNull();
  });

  it('un bloc RCS VIDE rend null : rien ne partirait', () => {
    expect(canal(g([n('r', 'rcs_message', { text: '  ' })]))).toBeNull();
    expect(canal(g([n('r', 'rcs_message')]))).toBeNull();
  });

  it('un scénario qui commence par une ATTENTE rend null', () => {
    const graph = g(
      [n('w', 'wait', { seconds: 60 }), n('t', 'template', { templateName: 'promo' })],
      [{ id: 'e', source: 'w', target: 't' }],
    );
    expect(canal(graph)).toBeNull();
  });

  it('un scénario qui ouvre par un message de SESSION rend null : la fenêtre de 24 h est fermée', () => {
    expect(canal(g([n('q', 'quick_message', { action: { kind: 'sendQuickMessage', text: 'coucou' } })]))).toBeNull();
  });

  it('un graphe vide rend null', () => {
    expect(canal(g([]))).toBeNull();
  });

  /**
   * ⚠️ L'ORDRE DES DEUX CANAUX EST CELUI DE LA RÈGLE D'ORIGINE : le RCS est examiné AVANT le modèle. Un
   * scénario qui ouvre en RCS ouvre en RCS, même s'il porte un modèle plus loin dans le parcours.
   */
  it('⚠️ ouverture RCS suivie d’un modèle : c’est rcs, pas whatsapp', () => {
    const graph = g(
      [n('r', 'rcs_message', { text: 'Bonjour' }), n('t', 'template', { templateName: 'promo' })],
      [{ id: 'e', source: 'r', target: 't' }],
    );
    expect(canal(graph)).toBe('rcs');
  });

  /**
   * 🔴 LA PARITÉ, ET C'EST LE TEST LE PLUS IMPORTANT DU FICHIER. `campaignEligible` est dérivé de
   * `canalDOuverture` : si les deux divergeaient d'un seul cas, l'assistant proposerait un scénario que la
   * création refuse, ou cacherait un scénario qu'elle accepte. Aucune erreur ne serait levée.
   */
  it('🔴 « il a un canal » veut dire EXACTEMENT « il est éligible », sur tous les cas', () => {
    const cas: Array<[string, GraphLike]> = [
      ['modèle nommé', g([n('a', 'template', { templateName: 'promo' })])],
      ['modèle sans nom', g([n('a', 'template', { templateName: '  ' })])],
      ['modèle absent de données', g([n('a', 'template')])],
      ['RCS configuré', g([n('r', 'rcs_message', { text: 'Bonjour' })])],
      ['RCS vide', g([n('r', 'rcs_message')])],
      ['message de session', g([n('q', 'quick_message', { action: { kind: 'sendQuickMessage', text: 'x' } })])],
      ['graphe vide', g([])],
      ['attente puis modèle', g(
        [n('w', 'wait', { seconds: 60 }), n('t', 'template', { templateName: 'promo' })],
        [{ id: 'e', source: 'w', target: 't' }],
      )],
      ['tag puis modèle', g(
        [n('g', 'tag', { tag: 'x' }), n('t', 'template', { templateName: 'promo' })],
        [{ id: 'e', source: 'g', target: 't' }],
      )],
      ['RCS puis modèle', g(
        [n('r', 'rcs_message', { text: 'Bonjour' }), n('t', 'template', { templateName: 'promo' })],
        [{ id: 'e', source: 'r', target: 't' }],
      )],
      ['deux modèles de noms différents', g(
        [n('c', 'condition', {}), n('t1', 'template', { templateName: 'a' }), n('t2', 'template', { templateName: 'b' })],
        [{ id: 'e1', source: 'c', target: 't1' }, { id: 'e2', source: 'c', target: 't2' }],
      )],
    ];
    for (const [nom, graph] of cas) {
      expect(canal(graph) !== null, nom).toBe(isCampaignEligible(graph));
    }
  });
});
