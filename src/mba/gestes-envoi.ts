import { blocSeul } from './outils-maison';
import { CONTACT_BLOQUE } from './executer-maison';
import type { EmpreinteDuFil } from '../inbox/store.pg';
import type { WorkflowGraph } from '../workflow/graph';
import type { StartOutcome } from '../workflow/executor';

/**
 * Les deux gestes qui envoient au client depuis le relais de l'agent de Meta : « Envoyer un bloc » et « Lancer
 * un scénario ». Toute issue ratée rend le fil, exception comprise : `runFrom` reprend le fil à l'agent avant
 * d'envoyer, puis sur un refus rend une raison sans rendre la main (l'Inbox a un opérateur), et une exception
 * traverse tout. Ici personne n'est là : sans ce rendu, le fil resterait à nous, hors de « À traiter », et
 * l'agent muet. Si la reprise a échoué, `rendreLaMain` ne touche à rien (garde `only: ['app_workflow']`).
 */
export interface DepsGestesEnvoi {
  /** Le graphe publié du scénario, celui que les contacts parcourent, ou `null`. Jamais le brouillon. */
  graphePublie(tenantId: string, workflowId: string): Promise<WorkflowGraph | null>;
  fenetreOuverte(tenantId: string, waId: string): Promise<boolean>;
  contacts: {
    findIdByWaId(tenantId: string, waId: string): Promise<string | null>;
    /** Le contact est-il bloqué dans l'Inbox ? Relu après l'attente : il a pu l'être pendant. */
    isBlockedByWaId(tenantId: string, waId: string): Promise<boolean>;
  };
  /** `startFromNode` : reprend le fil, envoie, et le rend à l'accusé. */
  envoyerDepuisBloc(
    tenantId: string, workflowId: string, graphe: WorkflowGraph, contact: { waId: string; contactId: string | null }, noeudId: string,
  ): Promise<StartOutcome>;
  /** `lancerScenarioPourContact`, le chemin du bouton de l'Inbox. `null` = scénario inconnu. */
  lancerScenario(tenantId: string, workflowId: string, waId: string, fenetreOuverte: boolean): Promise<StartOutcome | null>;
  /** Le runtime des scénarios (`wiring.ts`). */
  runtime: { rendreLaMainApresParcours(tenantId: string, waId: string): Promise<void> };
  /**
   * Attend que l'agent de Meta ait fini son tour, juste avant de lui prendre le fil (`src/mba/fin-de-tour.ts`).
   * Placé après les refus qui ne demandent rien à Meta (bloc disparu, fenêtre fermée), qui partent tout de suite.
   */
  attendreFinDuTour(tenantId: string, waId: string): Promise<unknown>;
  /** L'empreinte du fil, relue avant et après l'attente. */
  inbox: { empreinteDuFil(tenantId: string, waId: string): Promise<EmpreinteDuFil | null> };
}

/**
 * Ce que l'agent de Meta lit quand la conversation a changé de main pendant l'attente de fin de tour (jusqu'à
 * 15 s) : l'envoi part avec `ignoreHumanControl`, et passerait par-dessus un opérateur ou un parcours.
 */
export const FIL_CHANGE_PENDANT_ATTENTE =
  'la conversation a changé de main pendant l’attente (un opérateur ou un parcours l’a prise) : rien n’a été envoyé';

/**
 * La conversation a-t-elle changé de main entre deux empreintes ? Un nouvel envoi de notre part, oui, quelle que
 * soit la colonne (un parcours ou un opérateur a envoyé). Un fil rendu à l'agent de Meta pendant l'attente, non :
 * c'est à lui qu'on allait le prendre. Limite : un parcours lancé pendant l'attente qui n'envoie rien et ne change
 * pas le détenteur reste invisible.
 */
export function aChangeDeMain(avant: EmpreinteDuFil | null, apres: EmpreinteDuFil | null): boolean {
  if (avant === null || apres === null) return avant !== apres;
  if (apres.dernierEnvoi !== avant.dernierEnvoi) return true;
  if (apres.detenteur === avant.detenteur && apres.changeLe === avant.changeLe) return false;
  return apres.detenteur !== 'mba';
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
      await deps.runtime.rendreLaMainApresParcours(tenantId, waId).catch(() => {});
      throw err;
    }
    if (issue === true) return true;
    await deps.runtime.rendreLaMainApresParcours(tenantId, waId);
    return issue ?? siInconnu;
  };

  /**
   * Attend la fin du tour de l'agent, puis rend un refus si la conversation a changé de main ou si le contact a
   * été bloqué entre-temps, `null` sinon. Ce refus n'a rien pris : il ne rend pas le fil (un parcours lancé
   * entre-temps serait relâché).
   */
  const attendreEtRevérifier = async (tenantId: string, waId: string): Promise<string | null> => {
    const avant = await deps.inbox.empreinteDuFil(tenantId, waId);
    await deps.attendreFinDuTour(tenantId, waId);
    if (aChangeDeMain(avant, await deps.inbox.empreinteDuFil(tenantId, waId))) return FIL_CHANGE_PENDANT_ATTENTE;
    if (await deps.contacts.isBlockedByWaId(tenantId, waId)) return CONTACT_BLOQUE;
    return null;
  };

  return {
    async envoyerBloc(tenantId, waId, { workflowId, code }) {
      const graphe = await deps.graphePublie(tenantId, workflowId);
      if (!graphe) return 'le scénario de ce bloc n’existe plus';
      // Revérifié à chaque appel : le scénario a pu changer depuis la création de l'outil.
      const seul = blocSeul(graphe, code);
      if (!seul.ok) return seul.raison;
      if (!seul.modele && !(await deps.fenetreOuverte(tenantId, waId))) {
        return 'la fenêtre de 24 h est fermée : ce bloc ne peut pas partir';
      }
      const contactId = await deps.contacts.findIdByWaId(tenantId, waId);
      const refus = await attendreEtRevérifier(tenantId, waId);
      if (refus !== null) return refus;
      // Le graphe réduit au bloc : ce qui le suit dans le scénario ne peut pas partir.
      return enRendantSurEchec(tenantId, waId,
        () => deps.envoyerDepuisBloc(tenantId, workflowId, seul.graphe, { waId, contactId }, seul.noeudId),
        'le bloc n’a pas pu partir');
    },
    async lancerScenario(tenantId, waId, workflowId) {
      const ouverte = await deps.fenetreOuverte(tenantId, waId);
      const refus = await attendreEtRevérifier(tenantId, waId);
      if (refus !== null) return refus;
      return enRendantSurEchec(tenantId, waId,
        () => deps.lancerScenario(tenantId, workflowId, waId, ouverte),
        'ce scénario n’existe plus');
    },
  };
}
