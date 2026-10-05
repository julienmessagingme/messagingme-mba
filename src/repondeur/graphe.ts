import type { WorkflowEdge, WorkflowGraph } from '../workflow/graph';
import type { SortieAgent } from '../agent/agent-store';
import { SORTIE_HUMAIN, SORTIE_TIMEOUT } from '../agent/sorties';

/**
 * LE GRAPHE DU RÉPONDEUR (lot 5, spec `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`, § 4).
 *
 * Construit à CHAQUE démarrage depuis le réglage (l'agent désigné, ses règles d'arrêt) et figé dans le parcours
 * (`fourni_fige`, `src/workflow/lancements.ts`) : la ligne du scénario système n'est qu'une ancre, et changer d'agent
 * ou de règles n'écrit rien nulle part. Un parcours en cours garde le graphe avec lequel il a commencé.
 *
 * Un bloc Agent IA, et une fin silencieuse. Ce qui y mène, et pourquoi :
 *  - chaque règle d'arrêt de l'agent (`sortie:<code>`) : la conversation de l'agent est close, le fil reste aux robots
 *    (`app_workflow`), et le prochain message du contact relance l'agent. La frise note la règle (`sortie_agent`) ;
 *  - `humain` (l'escalade) : 🔴 câblée, sinon le moteur passerait la main à l'équipe pendant la sortie (`boutonSansSuite`),
 *    AVANT que l'escalade de l'agent (`src/agent/escalade.ts`) ne le fasse elle-même ; sa bascule, gardée `only:
 *    ['app_workflow']`, rendrait alors `false`, et la dernière phrase de l'agent (« un conseiller vous répond ») serait
 *    jetée. Ici, l'escalade trouve le fil aux robots, le passe à l'équipe avec la marque, et la phrase part ;
 *  - `timeout` (l'inactivité) : le contact ne répond plus, rien à dire, le prochain message relance l'agent.
 *
 * Laissées SANS arête, délibérément : `echec`, `plafond` et `sans_source`. Une sortie non câblée remonte la
 * conversation à l'équipe (`boutonSansSuite`, `WorkflowExecutor.advance`), ce qui est exactement voulu : un modèle en
 * panne, un crédit épuisé, une question sans source ne doivent pas laisser le contact sans personne. Sauf si l'agent
 * déclare lui-même une règle d'arrêt de ce code : c'est alors sa règle, et elle mène à la fin comme les autres.
 */

/** Le bloc de l'agent et la fin : des identifiants fixes, le graphe n'est jamais édité. */
export const BLOC_AGENT_REPONDEUR = 'agent';
const BLOC_FIN = 'fin';

export function grapheDuRepondeur(agent: { id: string; sorties: readonly SortieAgent[] }): WorkflowGraph {
  const handles = new Set<string>([...agent.sorties.map((s) => `sortie:${s.code}`), `sortie:${SORTIE_HUMAIN}`, SORTIE_TIMEOUT]);
  const edges: WorkflowEdge[] = [...handles].map((h) => ({ id: `fin-${h}`, source: BLOC_AGENT_REPONDEUR, target: BLOC_FIN, sourceHandle: h }));
  return {
    nodes: [
      { id: BLOC_AGENT_REPONDEUR, type: 'agent', position: { x: 0, y: 0 }, data: { agentId: agent.id } },
      // Une action sans sous-action ne fait rien (`actionOf` rend `null`) et n'a aucune arête : le parcours finit là.
      { id: BLOC_FIN, type: 'action', position: { x: 0, y: 200 }, data: {} },
    ],
    edges,
  };
}
