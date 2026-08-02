/**
 * Éligibilité d'un scénario à une CAMPAGNE broadcast (Lot D). Module PUR : aucune IO, aucune dépendance
 * React/navigateur (types structuraux locaux, comme `node-search.ts`) -> testable depuis la suite racine
 * (tests/web-campaign-eligibility.test.ts). Importer `./api` ici tirerait `session.ts` (et `window`) dans la
 * compilation racine : à ne pas faire.
 *
 * Depuis le Lot D, un scénario peut démarrer par autre chose qu'un template (formulaire, message rapide) :
 * il reste valide et enregistrable, mais il n'est utilisable QUE là où la fenêtre de service 24 h est garantie
 * (contact qui vient d'écrire). Une campagne broadcast, elle, part sur une audience froide : seul un template
 * peut ouvrir, sinon Meta rejette l'envoi (131047).
 *
 * Ce helper filtre le sélecteur de scénarios côté campagne pour ne proposer QUE ce qui partira réellement.
 * Il ne remplace PAS la garde serveur (`POST /campaigns` refuse en 400 une entrée non-template) : c'est de la
 * prévention d'UI, la garde serveur reste le contrôle.
 */

/** Forme minimale d'un bloc, structurelle : `WorkflowNode` de `./api` la satisfait sans import. */
export interface GraphNodeLike {
  id: string;
  type: string;
  data: Record<string, unknown>;
}
/** Forme minimale d'un graphe (`WorkflowGraph` de `./api` la satisfait). Seuls `source`/`target` comptent ici ;
 *  `id` (et tout autre champ d'arête) est accepté et ignoré. */
export interface GraphLike {
  nodes: GraphNodeLike[];
  edges: { source: string; target: string; id?: string }[];
}

/** Bloc d'entrée d'un graphe = un bloc SANS arête entrante (défaut : le 1er bloc). null si le graphe est vide.
 *  Miroir de `entryNode` côté serveur (src/workflow/engine.ts). */
export function entryNodeOf(graph: GraphLike): GraphNodeLike | null {
  if (graph.nodes.length === 0) return null;
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  return graph.nodes.find((n) => !hasIncoming.has(n.id)) ?? graph.nodes[0] ?? null;
}

/**
 * Le scénario peut-il être lancé en campagne broadcast ? Exige une entrée `template` AVEC un `templateName`
 * non vide : un bloc template pas encore configuré n'a rien à envoyer et ferait échouer la campagne au lancement
 * (le serveur ne vérifie que le TYPE de l'entrée, donc ce contrôle-ci est plus strict, volontairement : mieux
 * vaut ne pas proposer un scénario inachevé que le laisser échouer après le clic).
 */
export function isCampaignEligible(graph: GraphLike): boolean {
  const entry = entryNodeOf(graph);
  if (!entry || entry.type !== 'template') return false;
  return String(entry.data.templateName ?? '').trim() !== '';
}
