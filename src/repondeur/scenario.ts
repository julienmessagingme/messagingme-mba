import type { Lancements } from '../workflow/lancements';
import type { WorkflowRow } from '../workflow/store.pg';
import { journaliser } from '../lib/journal';

/**
 * LE SCÉNARIO RÉPONDEUR (RC6, plan `docs/superpowers/plans/2026-10-06-rc6-qui-repond.md`, A3) : en mode `scenario`, le
 * scénario publié que l'espace a choisi prend le message que personne ne tient, AU PLUS UNE FOIS PAR DÉLAI pour un même
 * contact ; entre-temps, la conversation va à l'équipe. Appelé par la remise « personne ne suit »
 * (`ControleDuFil.remettreSiPersonneNeSuit`, `src/inbox/fil.ts`) APRÈS ses gardes, en deux temps :
 *
 *  1. `reclamerScenario` : le scénario est-il jouable (de cet espace, non système, publié), puis la réclamation du
 *     départ, ATOMIQUE (`contacts.repondeur_scenario_le`, une seule instruction gardée par le délai) : deux entrants
 *     simultanés, un seul départ, l'autre à l'équipe. La remise réclame AVANT de reprendre le fil à l'équipe : dans le
 *     délai, le fil n'a pas à passer par les robots.
 *  2. `lancerScenario` : le type de lancement `repondeur_scenario` (`src/workflow/lancements.ts`) : jamais à un
 *     opérateur qui tient le fil, ses étiquettes publient, le graphe publié, la fenêtre prouvée par l'entrant.
 *
 * Une colonne plutôt qu'une lecture de `workflow_runs` : la rétention purge les parcours, et aucun index ne les sert par
 * contact et par scénario.
 */
export type IssueReclamation =
  /** Le départ est à ce message : la date est posée. */
  | 'reclame'
  /** Un départ a eu lieu pour ce contact il y a moins que le délai (ou à l'instant, par un entrant simultané). */
  | 'deja_parti'
  /** Le scénario n'est plus jouable : supprimé, système, d'un autre espace, ou jamais publié. Rien n'est posé. */
  | 'indisponible';

export type IssueLancementScenario = 'parti' | 'refuse';

export interface DemarreurScenario {
  reclamerScenario(tenantId: string, waId: string, o: { workflowId: string; delaiS: number }): Promise<IssueReclamation>;
  /** `messageDeclencheur` : le dernier message du contact, que le parcours naît en ayant reçu ; `null` = inconnu. */
  lancerScenario(tenantId: string, waId: string, o: { workflowId: string; messageDeclencheur: string | null }): Promise<IssueLancementScenario>;
}

export interface DepsDemarreurScenario {
  /** Le scénario, scopé espace, système exclu (`PgWorkflowStore.getById`) : `null` = inconnu ici. */
  scenarios: { getById(id: string, tenantId: string): Promise<Pick<WorkflowRow, 'graph'> | null> };
  /** La réclamation atomique du départ (`PgContactStore.reclamerDepartRepondeur`). */
  contacts: { reclamerDepartRepondeur(tenantId: string, waId: string, delaiS: number): Promise<boolean> };
  /** Les lancements du processus (`buildWorkflowRuntime`), jamais un second exemplaire. */
  lancements: Pick<Lancements, 'lancer'>;
}

export function creerDemarreurScenario(deps: DepsDemarreurScenario): DemarreurScenario {
  return {
    async reclamerScenario(tenantId, waId, { workflowId, delaiS }) {
      // « Publié » = le graphe en ligne porte au moins un bloc (la règle de `listPublies`) : un scénario jamais publié
      // partirait sans rien envoyer, et le contact n'aurait aucune réponse. Lu AVANT la réclamation : un scénario
      // injouable ne consomme pas le délai.
      const wf = await deps.scenarios.getById(workflowId, tenantId);
      if (!wf || wf.graph.nodes.length === 0) {
        journaliser('warn', 'repondeur_scenario_indisponible', { tenantId, waId, workflowId });
        return 'indisponible';
      }
      return (await deps.contacts.reclamerDepartRepondeur(tenantId, waId, delaiS)) ? 'reclame' : 'deja_parti';
    },

    async lancerScenario(tenantId, waId, { workflowId, messageDeclencheur }) {
      const issue = await deps.lancements.lancer({
        type: 'repondeur_scenario', tenantId, workflowId, waId, fenetreOuverte: true, messageDeclencheur,
      });
      if (issue === true) return 'parti';
      journaliser('warn', 'repondeur_scenario_non_demarre', { tenantId, waId, workflowId, raison: issue ?? 'scenario inconnu' });
      return 'refuse';
    },
  };
}
