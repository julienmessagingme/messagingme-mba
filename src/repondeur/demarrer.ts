import type { AgentComplet } from '../agent/agent-store';
import type { Lancements } from '../workflow/lancements';
import type { SystemeScenario } from '../workflow/store.pg';
import { grapheDuRepondeur } from './graphe';
import { journaliser } from '../lib/journal';

/**
 * LE DÉMARREUR DU RÉPONDEUR (lot 5, spec `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`, § 5) :
 * l'agent IA désigné prend le message que personne ne tient. Appelé par la remise « personne ne suit »
 * (`ControleDuFil.remettreSiPersonneNeSuit`, `src/inbox/fil.ts`) APRÈS ses gardes (délai de l'équipe, parcours en
 * attente, contact muet, fil de test, numéro) : ce module ne décide que si l'agent PEUT répondre, puis le lance.
 *
 * Tout le reste est le moteur existant : le scénario système de l'espace pour ancre, un graphe construit ici et figé
 * dans le parcours (`fourni_fige`), le type de lancement `repondeur`, la session et le tour d'un bloc Agent IA.
 *
 * Ce qu'il rend, et ce que la remise en fait :
 *  - `parti` : le parcours est lancé, le premier tour enfilé ;
 *  - `credit_epuise` : le solde est nul ou négatif, RIEN n'a démarré (ni parcours, ni session : un tour sortirait
 *    aussitôt par le plafond, et chaque message en ouvrirait un), l'alerte aux admins est partie (une par jour) ;
 *  - `indisponible` : le modèle n'est pas configuré sur l'instance, ou l'agent n'est plus actif ;
 *  - `refuse` : le lancement a refusé (fil tenu par un opérateur, numéro délié, désabonné), sa raison est journalisée.
 * Les trois derniers passent la conversation à l'équipe : le client n'attend pas un robot qui ne viendra pas.
 */
export type IssueRepondeur = 'parti' | 'credit_epuise' | 'indisponible' | 'refuse';

export interface DepsDemarreurRepondeur {
  /** La fiche entière, scopée espace : son statut et ses règles d'arrêt (celles que le modèle peut emprunter). */
  agents: { complet(tenantId: string, id: string): Promise<Pick<AgentComplet, 'id' | 'status' | 'contenu'> | null> };
  /** Le solde prépayé de l'espace, en micro-euros (`PgCreditStore.solde`). */
  credits: { solde(tenantId: string): Promise<number> };
  /** L'ancre des parcours du répondeur, créée à la première utilisation (`PgWorkflowStore.assurerScenarioSysteme`). */
  scenarios: { assurerScenarioSysteme(tenantId: string, systeme: SystemeScenario): Promise<string> };
  /** Les lancements du processus (`buildWorkflowRuntime`), jamais un second exemplaire. */
  lancements: Pick<Lancements, 'lancer'>;
  /**
   * Le modèle est-il configuré (`AI_GATEWAY_API_KEY`) ? Sans lui, la file des tours n'est pas consommée : un
   * parcours lancé attendrait sur le bloc pour toujours, et le contact resterait muet derrière lui.
   */
  gatewayDisponible: boolean;
  /** L'alerte de crédit épuisé aux admins de l'espace (`src/repondeur/alerte-credit.ts`). Ne lève jamais. */
  alerteCredit: { alerter(tenantId: string): Promise<void> };
}

export interface DemarreurRepondeur {
  /**
   * `agentId` : le répondeur que la remise vient de lire dans les réglages (une seule lecture par message).
   * `messageDeclencheur` : le dernier message du contact, inscrit comme déjà reçu par le parcours (sa redélivrance
   * n'enfile pas un second tour) ; `null` = inconnu.
   */
  demarrer(tenantId: string, waId: string, o: { agentId: string; messageDeclencheur: string | null }): Promise<IssueRepondeur>;
}

export function creerDemarreurRepondeur(deps: DepsDemarreurRepondeur): DemarreurRepondeur {
  return {
    async demarrer(tenantId, waId, { agentId, messageDeclencheur }) {
      if (!deps.gatewayDisponible) return 'indisponible';
      const agent = await deps.agents.complet(tenantId, agentId);
      // Désactivé ou supprimé entre le réglage et ce message : la désactivation et la clé étrangère remettent le
      // réglage à nul, ceci ne couvre que la fenêtre entre les deux.
      if (!agent || agent.status !== 'active') return 'indisponible';
      // 🔴 Le solde AVANT tout démarrage : à sec, un parcours et une session par message, chacun sorti aussitôt par le
      // plafond, rempliraient la base pour rien. Même règle que le tour (`soldeEpuise`, `src/agent/run-turn.ts`).
      if ((await deps.credits.solde(tenantId)) <= 0) {
        await deps.alerteCredit.alerter(tenantId);
        return 'credit_epuise';
      }
      const workflowId = await deps.scenarios.assurerScenarioSysteme(tenantId, 'repondeur');
      const issue = await deps.lancements.lancer({
        type: 'repondeur', tenantId, workflowId, waId,
        graphe: grapheDuRepondeur({ id: agent.id, sorties: agent.contenu.sorties }),
        fenetreOuverte: true,
        messageDeclencheur,
      });
      if (issue === true) return 'parti';
      journaliser('warn', 'repondeur_non_demarre', { tenantId, waId, raison: issue });
      return 'refuse';
    },
  };
}
