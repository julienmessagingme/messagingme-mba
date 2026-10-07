import { blocSeul } from '../mba/outils-maison';
import type { WorkflowGraph } from '../workflow/graph';
import type { StartOutcome } from '../workflow/executor';
import { MOTIF_SCENARIO_LANCE } from '../workflow/lancements';
import type { AgentSessionStore } from './session-store';
import type { SourceOffres } from '../offres/offre.pg';
import { INDISPONIBLE_POUR_LE_MODELE } from '../offres/refus';

/**
 * Les deux outils d'un agent IA qui envoient au contact sur une CIBLE FIXÉE (RC4) : « Envoyer un bloc » et « Lancer un
 * scénario ». Pendants de `src/mba/gestes-envoi.ts` (l'agent de Meta), sans en partager le chemin : l'agent IA parle
 * depuis un parcours qui l'attend sur son bloc, et ce parcours doit survivre au bloc envoyé, ou disparaître avec le
 * scénario lancé.
 */
export interface DepsGestesEnvoiAgent {
  /** Le graphe PUBLIÉ du scénario, celui que les contacts parcourent, ou `null` (supprimé, autre espace). Jamais le
   *  brouillon. */
  graphePublie(tenantId: string, workflowId: string): Promise<WorkflowGraph | null>;
  /** `WorkflowExecutor.envoyerBlocDepuisAgent` : le bloc seul, sans faire bouger le parcours de l'agent. */
  envoyerDepuisAgent(tenantId: string, waId: string, input: {
    runId: string; workflowId: string; graphe: WorkflowGraph; noeudId: string;
  }): Promise<{ ok: boolean; raison?: string }>;
  /** Le type de lancement `agent_ia_scenario` (`src/workflow/lancements.ts`). `null` = scénario inconnu. */
  lancer(demande: {
    type: 'agent_ia_scenario'; tenantId: string; workflowId: string; waId: string; fenetreOuverte: boolean;
  }): Promise<StartOutcome | null>;
  /** La fenêtre de 24 h est-elle ouverte ? La preuve que la politique `selon_preuve` lit. */
  fenetreOuverte(tenantId: string, waId: string): Promise<boolean>;
  /** 🔴 Le contact a-t-il demandé à ne plus rien recevoir ? Requise, comme partout où l'on écrit à un contact. */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /**
   * L'offre de l'espace (lot 6, B2a, décision de Julien) : sans `scenarios`, les deux outils refusent avant tout geste,
   * comme leurs pendants de l'agent de Meta. Le répondeur agent IA, lui, continue de répondre.
   */
  offres: SourceOffres;
  sessions: Pick<AgentSessionStore, 'clore'>;
  /**
   * Clôt le parcours de l'agent s'il vit encore (`setStateSiVivant` à `done`). `false` = déjà clos, le cas normal : le
   * démarrage du scénario l'a remplacé.
   */
  parcours: { clore(tenantId: string, runId: string): Promise<boolean> };
}

export const CONTACT_DESABONNE = 'ce contact a demandé à ne plus rien recevoir : aucun scénario ne peut lui être lancé';
export const SCENARIO_INCONNU = 'ce scénario n’existe plus';

export function creerGestesEnvoiAgent(deps: DepsGestesEnvoiAgent): {
  envoyerBloc(input: { tenantId: string; waId: string; runId: string; workflowId: string; code: string }): Promise<{ ok: boolean; raison?: string }>;
  lancerScenario(input: { tenantId: string; waId: string; runId: string; sessionId: string; workflowId: string }): Promise<{ ok: boolean; raison?: string }>;
} {
  const scenariosOuverts = async (tenantId: string) => (await deps.offres.offreDe(tenantId)).droits.fonctions.has('scenarios');
  return {
    /**
     * Le bloc fixé, revérifié à chaque appel sur le graphe PUBLIÉ (le scénario a pu changer depuis la pose de l'outil),
     * et réduit à lui seul (`blocSeul`, la règle de l'agent de Meta) : un bloc qui attend une réponse, ouvre un agent
     * ou part en RCS est refusé avec sa raison, avant tout envoi.
     */
    async envoyerBloc({ tenantId, waId, runId, workflowId, code }) {
      if (!(await scenariosOuverts(tenantId))) return { ok: false, raison: INDISPONIBLE_POUR_LE_MODELE };
      const graphe = await deps.graphePublie(tenantId, workflowId);
      if (!graphe) return { ok: false, raison: 'le scénario de ce bloc n’existe plus' };
      const seul = blocSeul(graphe, code);
      if (!seul.ok) return { ok: false, raison: seul.raison };
      return deps.envoyerDepuisAgent(tenantId, waId, { runId, workflowId, graphe: seul.graphe, noeudId: seul.noeudId });
    },

    /**
     * 🔴 LANCER, PUIS SE RETIRER. Le démarrage remplace le parcours de l'agent et clôt sa session comme un retrait
     * (`sessionRemplacee: 'retiree'`) ; on la clôt aussi ici, avec le parcours, pour le seul cas où le démarrage ne
     * remplace rien (un scénario fait d'actions muettes, fini aussitôt). Aucune des deux clôtures ne fait sortir le
     * bloc agent : le parcours de l'agent ne repart par aucune branche. Un refus ne clôt rien : la session continue, et
     * le modèle lit la raison.
     */
    async lancerScenario({ tenantId, waId, runId, sessionId, workflowId }) {
      if (!(await scenariosOuverts(tenantId))) return { ok: false, raison: INDISPONIBLE_POUR_LE_MODELE };
      if (await deps.estDesabonne(tenantId, waId)) return { ok: false, raison: CONTACT_DESABONNE };
      const fenetreOuverte = await deps.fenetreOuverte(tenantId, waId);
      const issue = await deps.lancer({ type: 'agent_ia_scenario', tenantId, workflowId, waId, fenetreOuverte });
      if (issue !== true) return { ok: false, raison: issue ?? SCENARIO_INCONNU };
      await deps.sessions.clore(tenantId, sessionId, 'sortie', MOTIF_SCENARIO_LANCE);
      await deps.parcours.clore(tenantId, runId);
      return { ok: true };
    },
  };
}
