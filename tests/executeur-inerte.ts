import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { RunState } from '../src/workflow/run-store.pg';
import { RcsSender } from '../src/rcs/sender';
import { Reachability, type ReachabilityStore } from '../src/rcs/reachability';
import { FakeRcsProvider } from '../src/rcs/fake';

/**
 * LES DÉPENDANCES DE L'EXÉCUTEUR, EN VALEURS INERTES NOMMÉES (lot 3 de l'audit ponytail, 2026-09-26).
 *
 * 🔴 POURQUOI ELLES EXISTENT. Ces membres de `WorkflowExecutorDeps` étaient OPTIONNELS « pour les suites de
 * tests à deps minimales », alors que le seul `new WorkflowExecutor` de production (`src/workflow/wiring.ts`)
 * les fournit TOUS, sans condition. Chaque garde de présence (`if (this.deps.mayAct && ...)`) était donc une
 * branche morte en production, et un câblage qui en oubliait une compilait en silence. C'est le motif déjà
 * payé avec `estDesabonne` (cf. `tests/consentement.ts`) : ils sont requis, et les fixtures DISENT leur
 * hypothèse au lieu de la laisser deviner.
 *
 * ⚠️ CHAQUE VALEUR REPRODUIT EXACTEMENT L'ABSENCE D'AVANT, et c'est ce qui autorise à ne toucher aucune
 * assertion : `mayAct` absent permettait tout, `isWindowOpen` absent disait « fermée » (fail-closed),
 * `reclaimControl` absent ne refusait rien, les autres ne faisaient rien. Changer l'une d'elles changerait des
 * verdicts de test sans qu'on l'ait voulu.
 *
 * 🔴 CE FICHIER EST DANS `tests/`, JAMAIS DANS `src/` (même règle que `tests/gardes.ts`) : une valeur qui
 * « permet tout » y serait importable par le câblage de production.
 */

/** `mayAct` absent : le fil était toujours considéré comme à nous, rien n'était refusé. */
export const filToujoursANous = async (): Promise<boolean> => true;
/** `reclaimControl` absent : aucune reprise tentée, donc aucune reprise refusée (`void` = succès). */
export const repriseSansObjection = async (): Promise<void> => {};
/** Aucune reprise du fil après un modèle (le comportement d'avant le 2026-09-29) : le test ne parle pas du fil. */
export const aucuneRetenue = async (): Promise<void> => {};
/** `isWindowOpen` absent : la fenêtre était considérée FERMÉE (fail-closed). Surtout pas `true`. */
export const fenetreToujoursFermee = async (): Promise<boolean> => false;
/** `evalContext` absent : aucun contexte, donc conditions sur « faux » et valeur dynamique vide. */
export const contexteIntrouvable = async (): Promise<null> => null;
/** `mbaActifPour` absent : l'agent de Meta était considéré éteint. */
export const agentDeMetaEteint = async (): Promise<boolean> => false;
/** `verifierNumeroWhatsApp` absent : aucune vérification préalable, rien n'était levé. */
export const numeroJamaisDelie = async (): Promise<void> => {};
/** `recordNodeEvent` absent : aucune mesure par bloc. */
export const aucuneMesure = async (): Promise<void> => {};
/** `setOptIn` absent : le bloc « consentement » était un no-op. */
export const consentementNonEcrit = async (): Promise<void> => {};
/** `escalateToHuman` absent : aucune remontée à un humain. */
export const personneNeReprend = async (): Promise<void> => {};
/** `enqueueAgentTurn` absent : aucun tour d'agent enfilé. */
export const aucunTourEnfile = async (): Promise<void> => {};
/** `releaseToMba` absent : le fil n'était jamais rendu à l'agent de Meta. */
export const filJamaisRendu = async (): Promise<void> => {};
/** `transmettreHorsParcours` absent : rien n'était transmis à l'agent de Meta. */
export const rienATransmettre = async (): Promise<void> => {};
/** `emitTagAdded` absent : aucune publication « tag ajouté ». */
export const aucunEvenement = async (): Promise<void> => {};
/** `rcs.recordOutbound` absent : l'envoi RCS n'était pas écrit dans le fil. */
export const filRcsNonJournalise = async (): Promise<void> => {};
/** `rcs.jetonPour` absent : les liens partaient tracés mais anonymes. */
export const aucunJetonRcs = async (): Promise<null> => null;

const sansCache: ReachabilityStore = { get: async () => null, put: async () => {} };
const fournisseurMuet = new FakeRcsProvider();

/**
 * `rcs` absent : un bloc RCS partait sur « non joignable » sans rien envoyer. Un espace SANS agent RCS
 * (`agentIdFor` rend `null`) produit exactement ce chemin, et l'expéditeur n'est jamais appelé.
 *
 * ⚠️ UN SEUL ÉCART, et il ne touche que les tests : un message rapide sur un parcours RCS rendait
 * « canal RCS non câblé sur ce serveur », il rend désormais « le canal RCS n'est pas activé sur cet espace ».
 * Aucun test n'exerce ce chemin sans RCS, et la production câble toujours le canal.
 */
export const rcsSansAgent: WorkflowExecutorDeps['rcs'] = {
  sender: new RcsSender(fournisseurMuet, new Reachability(fournisseurMuet, sansCache), { isOptedOut: async () => false }),
  agentIdFor: async () => null,
  recordOutbound: filRcsNonJournalise,
  jetonPour: aucunJetonRcs,
};

type Runs = WorkflowExecutorDeps['runs'];
type GardesDEtat = Pick<Runs, 'setStateSiVivant' | 'setStateSiEncoreSur'>;

/**
 * Les deux écritures GARDÉES d'un faux `runs`, quand il ne les porte pas : leur absence valait un `setState`
 * inconditionnel suivi de « écrit », et c'est exactement ce que font ces deux délégations.
 *
 * ⚠️ `Object.assign` SUR L'INSTANCE, jamais un étalement `{ ...runs }` : les faux sont souvent des CLASSES, et
 * un étalement perdrait les méthodes du prototype (piège déjà écrit dans `workflow-avance-concurrente.test.ts`).
 * Un faux qui porte déjà ses gardes les GARDE : on ne remplace rien.
 *
 * ⚠️ DES FONCTIONS À `this`, PAS DES FLÈCHES : un test qui recompose un faux (`{ ...deps.runs, setState }`)
 * doit voir ses gardes inertes appeler SON `setState`, celui qu'il vient de poser, comme le faisait l'absence
 * d'avant. Une flèche aurait capturé l'ancien objet.
 */
async function setStateSiVivantInerte(this: Pick<Runs, 'setState'>, _tenantId: string, id: string, state: RunState): Promise<boolean> {
  await this.setState(id, state);
  return true;
}
async function setStateSiEncoreSurInerte(
  this: Pick<Runs, 'setState'>, _tenantId: string, id: string, _nodeId: string | null, state: RunState,
): Promise<boolean> {
  await this.setState(id, state);
  return true;
}
// `NoInfer` : sans lui, le compilateur déduirait `R` du type ATTENDU au point d'appel (le `runs` complet) au lieu
// du faux qu'on lui passe, et exigerait du faux les deux gardes qu'on est justement en train d'ajouter.
export function avecGardesDEtatInertes<R extends Pick<Runs, 'setState'> & Partial<GardesDEtat>>(runs: R): NoInfer<R> & GardesDEtat {
  return Object.assign(runs, {
    setStateSiVivant: runs.setStateSiVivant ?? setStateSiVivantInerte,
    setStateSiEncoreSur: runs.setStateSiEncoreSur ?? setStateSiEncoreSurInerte,
  });
}

/**
 * Toutes les dépendances requises de l'exécuteur qu'une fixture ne regarde pas. À étaler EN TÊTE : ce que le
 * test observe vient après et l'emporte.
 */
export const depsInertes = {
  mayAct: filToujoursANous,
  reclaimControl: repriseSansObjection,
  retenirApresModele: aucuneRetenue,
  isWindowOpen: fenetreToujoursFermee,
  evalContext: contexteIntrouvable,
  mbaActifPour: agentDeMetaEteint,
  verifierNumeroWhatsApp: numeroJamaisDelie,
  recordNodeEvent: aucuneMesure,
  setOptIn: consentementNonEcrit,
  escalateToHuman: personneNeReprend,
  enqueueAgentTurn: aucunTourEnfile,
  releaseToMba: filJamaisRendu,
  transmettreHorsParcours: rienATransmettre,
  emitTagAdded: aucunEvenement,
  rcs: rcsSansAgent,
} satisfies Partial<WorkflowExecutorDeps>;
