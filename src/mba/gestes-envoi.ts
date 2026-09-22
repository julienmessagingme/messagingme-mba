import { blocSeul } from './outils-maison';
import type { WorkflowGraph } from '../workflow/graph';
import type { StartOutcome } from '../workflow/executor';

/**
 * LES DEUX GESTES QUI ENVOIENT AU CLIENT depuis le relais de l'agent de Meta (spec 2026-09-21-outils-maison-mba,
 * § 3.3 et § 3.4) : « Envoyer un bloc » et « Lancer un scénario ».
 *
 * 🔴 TOUTE ISSUE RATÉE REND LE FIL, EXCEPTION COMPRISE (revue finale du 2026-09-22). Les deux passent par `runFrom`,
 * qui REPREND le fil à l'agent de Meta avant d'envoyer. S'il refuse ensuite (désabonné, envoi refusé), il rend une
 * raison SANS rendre la main, parce que ses autres appelants (l'Inbox) ont un opérateur ; et s'il LÈVE (Meta refuse
 * un modèle en pause, coupure réseau), l'exception traverse tout. Ici personne n'est là pour rendre le fil : sans
 * ce module, il restait à nous (`app_workflow`, donc hors de « À traiter ») et l'agent de Meta muet. Si la reprise
 * elle-même a échoué, `rendreLaMain` ne touche à rien (sa garde `only: ['app_workflow']`).
 *
 * ⚠️ SORTI DU CÂBLAGE POUR ÊTRE TESTÉ : écrit dans `src/index.ts`, retirer ce rendu ne faisait tomber aucun test.
 */
export interface DepsGestesEnvoi {
  /** Le graphe PUBLIÉ du scénario, celui que les contacts parcourent, ou `null`. Jamais le brouillon. */
  graphePublie(tenantId: string, workflowId: string): Promise<WorkflowGraph | null>;
  fenetreOuverte(tenantId: string, waId: string): Promise<boolean>;
  contactId(tenantId: string, waId: string): Promise<string | null>;
  /** `startFromNode` : reprend le fil, envoie, et le rend à l'accusé (0149). */
  envoyerDepuisBloc(
    tenantId: string, workflowId: string, graphe: WorkflowGraph, contact: { waId: string; contactId: string | null }, noeudId: string,
  ): Promise<StartOutcome>;
  /** `lancerScenarioPourContact`, le chemin du bouton de l'Inbox. `null` = scénario inconnu. */
  lancerScenario(tenantId: string, workflowId: string, waId: string, fenetreOuverte: boolean): Promise<StartOutcome | null>;
  /** `rendreLaMainApresParcours` (`wiring.ts`). */
  rendreLaMain(tenantId: string, waId: string): Promise<void>;
  /**
   * Attend que l'agent de Meta ait fini son tour, JUSTE AVANT de lui prendre le fil (`src/mba/fin-de-tour.ts`).
   * Placé après les refus qui ne demandent rien à Meta (bloc disparu, fenêtre fermée) : ceux-là partent tout de
   * suite, dans le délai de réponse du relais, et l'agent les lit.
   */
  attendreFinDuTour(tenantId: string, waId: string): Promise<unknown>;
}

export function creerGestesEnvoi(deps: DepsGestesEnvoi): {
  envoyerBloc(tenantId: string, waId: string, cible: { workflowId: string; code: string }): Promise<true | string>;
  lancerScenario(tenantId: string, waId: string, workflowId: string): Promise<true | string>;
} {
  /** Joue le geste ; sur un refus OU une exception, rend le fil avant de rendre la raison (ou de relancer). */
  const enRendantSurEchec = async (
    tenantId: string, waId: string, geste: () => Promise<StartOutcome | null>, siInconnu: string,
  ): Promise<true | string> => {
    let issue: StartOutcome | null;
    try {
      issue = await geste();
    } catch (err) {
      await deps.rendreLaMain(tenantId, waId).catch(() => {});
      throw err;
    }
    if (issue === true) return true;
    await deps.rendreLaMain(tenantId, waId);
    return issue ?? siInconnu;
  };

  return {
    async envoyerBloc(tenantId, waId, { workflowId, code }) {
      const graphe = await deps.graphePublie(tenantId, workflowId);
      if (!graphe) return 'le scénario de ce bloc n’existe plus';
      // Revérifié à CHAQUE appel : le scénario a pu changer depuis la création de l'outil.
      const seul = blocSeul(graphe, code);
      if (!seul.ok) return seul.raison;
      if (!seul.modele && !(await deps.fenetreOuverte(tenantId, waId))) {
        return 'la fenêtre de 24 h est fermée : ce bloc ne peut pas partir';
      }
      const contactId = await deps.contactId(tenantId, waId);
      await deps.attendreFinDuTour(tenantId, waId);
      // Le graphe RÉDUIT au bloc : ce qui le suit dans le scénario ne peut pas partir.
      return enRendantSurEchec(tenantId, waId,
        () => deps.envoyerDepuisBloc(tenantId, workflowId, seul.graphe, { waId, contactId }, seul.noeudId),
        'le bloc n’a pas pu partir');
    },
    async lancerScenario(tenantId, waId, workflowId) {
      const ouverte = await deps.fenetreOuverte(tenantId, waId);
      await deps.attendreFinDuTour(tenantId, waId);
      return enRendantSurEchec(tenantId, waId,
        () => deps.lancerScenario(tenantId, workflowId, waId, ouverte),
        'ce scénario n’existe plus');
    },
  };
}
