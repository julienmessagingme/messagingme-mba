import type { WorkflowGraph, WorkflowNode } from './graph';
import { blocDuCode, cibleDuSaut, sautsApresAttenteLongue, scanOpening } from './engine';
import { summarize } from './node-list';

/**
 * LE BLOC « ALLER À » (RC5, livraison B), ce que le moteur pur ne peut pas trancher seul.
 *
 * `data.cible` porte le code public d'un bloc (`nod_<client>_<ULID>`, `src/workflow/node-codes.ts`) de n'importe quel
 * scénario de l'espace. Dans le MÊME scénario, `walk` suit le saut comme une flèche (`src/workflow/engine.ts`). Vers un
 * AUTRE scénario, l'exécuteur clôt le parcours et en démarre un sur le bloc visé (`WorkflowExecutor.sauter`), avec le
 * type de lancement `aller_a` (`src/workflow/lancements.ts`). Les réponses déjà données suivent le contact sans rien
 * transporter : un parcours ne porte aucune variable propre, tout vit sur la fiche.
 *
 * Ce module porte les deux décisions qui lisent PLUSIEURS scénarios : la garde anti-boucle entre scénarios, et le refus
 * de publication.
 */

/**
 * 🔴 LA GARDE ANTI-BOUCLE ENTRE SCÉNARIOS. A saute vers B qui saute vers A, sans pause : `walk` ne voit qu'un graphe,
 * sa garde `visited` ne peut rien. Le compteur voyage avec le démarrage (`DepartDuParcours` `saut`) et repart de zéro à
 * chaque pause (une réponse, un réveil). Le 21e saut d'affilée n'a pas lieu : le parcours s'arrête, la conversation va
 * à l'équipe et le journal des échecs le dit.
 */
export const MAX_SAUTS_SANS_PAUSE = 20;

/** Le nom d'un bloc tel que l'écran le montre : celui donné par l'utilisateur, sinon son résumé, sinon son type. */
export function nomDuBloc(n: WorkflowNode): string {
  const libre = typeof n.data.name === 'string' ? n.data.name.trim() : '';
  if (libre !== '') return libre;
  return summarize(n.type, n.data) || (n.type === 'aller_a' ? 'Aller à' : n.type);
}

/**
 * 🔴 LES SAUTS INTERNES D'UNE COPIE VISENT LA COPIE. Dupliquer un scénario refait le code de chaque bloc (deux
 * scénarios ne partagent jamais un code public) : un « Aller à » qui visait un bloc de l'original viserait sinon
 * l'ORIGINAL, et la copie enverrait ses contacts dans un autre scénario sans que rien ne le montre. `avant` est le graphe
 * copié, codes d'origine compris ; `apres`, le même après `mintNodeCodes` (mêmes identifiants de bloc). Un saut vers un
 * autre scénario, lui, ne bouge pas.
 */
export function sautsDeLaCopie(avant: WorkflowGraph, apres: WorkflowGraph): WorkflowGraph {
  const nouveau = new Map<string, string>();
  for (const n of avant.nodes) {
    const ancien = typeof n.data.code === 'string' ? n.data.code : '';
    const neuf = apres.nodes.find((x) => x.id === n.id)?.data.code;
    if (ancien !== '' && typeof neuf === 'string') nouveau.set(ancien, neuf);
  }
  return {
    ...apres,
    nodes: apres.nodes.map((n) => {
      const neuf = n.type === 'aller_a' ? nouveau.get(cibleDuSaut(n)) : undefined;
      return neuf === undefined ? n : { ...n, data: { ...n.data, cible: neuf } };
    }),
  };
}

/** Un scénario de l'espace tel que la publication le lit : sa version PUBLIÉE, la seule qu'un contact parcourt. */
export interface ScenarioDeLEspace {
  id: string;
  name: string;
  graph: WorkflowGraph;
}

/** Combien de sauts la recherche d'un message de session suit au plus, comme l'exécution. */
const SAUTS_SUIVIS = MAX_SAUTS_SANS_PAUSE;

/**
 * Ce qui empêche de publier ce brouillon, ou `null`. Lu par `POST /workflows/:id/publish` AVANT la mise en ligne.
 *
 * Deux refus, et rien d'autre (la publication ne valide pas le reste de `data`, cf. `documentation.md` § 4.3) :
 *
 * 1. 🔴 **UNE CIBLE INEXISTANTE.** Un bloc « Aller à » sans cible, ou dont la cible n'est ni dans CE brouillon (le même
 *    scénario se lit dans ce qu'on publie), ni dans la version PUBLIÉE d'un autre scénario de l'espace. `scenarios`
 *    vient d'une lecture scopée à l'espace : un code d'un autre espace n'y est jamais, il est donc inexistant. Une
 *    cible présente seulement dans la version publiée de CE scénario est inexistante aussi : à la mise en ligne, le
 *    brouillon la remplace.
 *
 * 2. 🔴 **LA FENÊTRE DE 24 H SUIT LE SAUT.** Un « Aller à » vers un AUTRE scénario, atteint après une attente cumulée de
 *    24 h ou plus (`sautsApresAttenteLongue`), dont le bloc visé envoie d'abord un message de session (message rapide,
 *    question, formulaire, agent IA) : ce message ne partira jamais. La console ne peut pas le montrer (elle n'a pas le
 *    graphe de l'autre scénario), d'où le refus ici plutôt qu'un avertissement. On suit les sauts suivants, jusqu'à
 *    `SAUTS_SUIVIS`. Un saut vers un bloc du MÊME scénario, lui, est suivi par `waitBeforeSessionMessage` et reste un
 *    avertissement de l'écran, comme toute flèche vers un message mort-né : la règle d'avant ne change pas.
 *
 * Pure : l'appelant lit les scénarios, une fois.
 */
export function refusDePublication(
  brouillon: WorkflowGraph,
  workflowId: string,
  scenarios: readonly ScenarioDeLEspace[],
): string | null {
  const autres = scenarios.filter((s) => s.id !== workflowId);
  /** Où vit ce code : dans le brouillon d'abord (le même scénario), sinon dans la version publiée d'un autre. */
  const resoudre = (code: string): { scenario: string | null; graph: WorkflowGraph; noeud: WorkflowNode } | null => {
    const ici = blocDuCode(brouillon, code);
    if (ici) return { scenario: null, graph: brouillon, noeud: ici };
    for (const s of autres) {
      const n = blocDuCode(s.graph, code);
      if (n) return { scenario: s.name, graph: s.graph, noeud: n };
    }
    return null;
  };

  for (const n of brouillon.nodes) {
    if (n.type !== 'aller_a') continue;
    const code = cibleDuSaut(n);
    if (code === '') return `le bloc « ${nomDuBloc(n)} » ne vise aucun bloc : choisissez sa cible, ou retirez-le`;
    if (!resoudre(code)) {
      return `le bloc « ${nomDuBloc(n)} » vise un bloc qui n’existe pas (${code}) : il n’est ni dans ce scénario, ni dans la version publiée d’un autre scénario de l’espace`;
    }
  }

  for (const saut of sautsApresAttenteLongue(brouillon)) {
    const depart = brouillon.nodes.find((x) => x.id === saut.sautNodeId);
    const attente = brouillon.nodes.find((x) => x.id === saut.waitNodeId);
    const session = messageDeSessionAuBoutDe(saut.cible, resoudre);
    if (session && depart && attente) {
      return `après le bloc « ${nomDuBloc(attente)} », qui attend 24 h ou plus, le bloc « ${nomDuBloc(depart)} » mène à « ${nomDuBloc(session.noeud)} »`
        + `${session.scenario ? ` du scénario « ${session.scenario} »` : ''}, dont le premier envoi est un message hors modèle : passé 24 h sans message du contact, `
        + 'WhatsApp n’accepte plus qu’un modèle. Visez un bloc qui envoie un modèle, ou raccourcissez l’attente';
    }
  }
  return null;
}

/**
 * Le bloc visé par ce code (ou atteint par les « Aller à » qui le suivent) dont le premier envoi est un message de
 * session, ou `null`. Le jugement est celui de l'ouverture d'un scénario (`scanOpening`), depuis ce bloc. Un bloc
 * introuvable ne mène à rien (le refus de la cible inexistante passe avant).
 */
function messageDeSessionAuBoutDe(
  code: string,
  resoudre: (code: string) => { scenario: string | null; graph: WorkflowGraph; noeud: WorkflowNode } | null,
): { scenario: string | null; noeud: WorkflowNode } | null {
  const vus = new Set<string>();
  const file: string[] = [code];
  while (file.length > 0 && vus.size < SAUTS_SUIVIS) {
    const c = file.shift()!;
    if (vus.has(c)) continue;
    vus.add(c);
    const r = resoudre(c);
    if (!r) continue;
    const scan = scanOpening(r.graph, r.noeud.id);
    if (scan.sessionOpen) return { scenario: r.scenario, noeud: r.noeud };
    file.push(...scan.sautsHorsScenario);
  }
  return null;
}

