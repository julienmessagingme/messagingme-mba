import type { AgentStore, FrequenceMentionIa } from './agent-store';
import type { ToolCatalog } from './catalog';
import type { ContexteAgentComplet } from './brain.gateway';
import { equipePourPrompt, MODE_TRANSFERT_DEFAUT, type EquipePourPrompt, type ModeTransfert } from './disponibilite-equipe';
import type { BusinessHours } from '../workflow/conditions';

/**
 * Tout ce que le cerveau doit savoir d'un agent : sa fiche, ses règles d'arrêt, ses outils actifs.
 *
 * Un seul point de lecture pour le tour de production et le bac à sable : un champ ajouté d'un seul côté
 * ferait diverger ce que le modèle voit en essai et en production. Typé contre les contrats, pas contre
 * Postgres, pour se tester sans base.
 */
export interface DepsContexteAgent {
  agents: Pick<AgentStore, 'complet'>;
  outils: Pick<ToolCatalog, 'listActifs'>;
  /**
   * Quand les agents de cet espace annoncent qu'ils sont des IA : une politique d'espace, pas un champ de la
   * fiche (l'obligation d'information pèse sur la marque déployante). Absente : `session`.
   */
  politiqueMentionIa?(tenantId: string): Promise<FrequenceMentionIa | null>;
  /**
   * L'équipe est-elle joignable, et sinon quand reprend-elle : réglage d'espace, lu ici pour que le bac à sable
   * et la production produisent la même phrase. Absente : l'équipe est réputée joignable.
   */
  disponibiliteEquipe?(tenantId: string): Promise<EquipePourPrompt | null>;
}

export async function lireContexteAgent(
  deps: DepsContexteAgent, tenantId: string, agentId: string,
): Promise<ContexteAgentComplet | null> {
  const fiche = await deps.agents.complet(tenantId, agentId);
  if (!fiche) return null;
  return {
    // Le modèle de l'agent, pas celui de l'IA de construction : deux réglages distincts.
    modele: fiche.modele,
    mentionIa: fiche.mentionIa,
    // La politique de l'espace, jamais celle de l'agent.
    mentionIaFrequence: (deps.politiqueMentionIa ? await deps.politiqueMentionIa(tenantId) : null) ?? 'session',
    sorties: fiche.contenu.sorties,
    contenu: fiche.contenu,
    outilsActifs: await deps.outils.listActifs(tenantId, agentId),
    plafonds: { maxAppelsOutils: fiche.maxAppelsOutils, budgetMicroEur: fiche.budgetMicroEur },
    // La politique face à un contact inconnu vient de la fiche, jamais de l'appelant : le bac à sable montre
    // ainsi le même refus d'outil que la production.
    contactInconnu: fiche.contactInconnu,
    // `?? undefined` et non `?? { disponible: true }` : le champ absent veut déjà dire « joignable ».
    equipe: (deps.disponibiliteEquipe ? await deps.disponibiliteEquipe(tenantId) : null) ?? undefined,
  };
}

/**
 * Le contexte d'un tour avec les deux politiques de l'espace lues dans ses réglages, pour le tour de
 * production comme pour le bac à sable. Une seule lecture des réglages (chemin de chaque tour d'agent), et
 * l'heure prise au moment du tour : calculée plus tôt, la disponibilité serait fausse sur une conversation
 * qui traverse l'heure de fermeture.
 */
export async function lireContexteAvecReglages(
  deps: Pick<DepsContexteAgent, 'agents' | 'outils'> & {
    reglages: {
      get(tenantId: string): Promise<{
        mentionIaFrequence: FrequenceMentionIa | null;
        agentTransfertMode: ModeTransfert | null;
        timezone: string;
        businessHours: BusinessHours;
      }>;
    };
  },
  tenantId: string,
  agentId: string,
): Promise<ContexteAgentComplet | null> {
  const reglages = await deps.reglages.get(tenantId);
  return lireContexteAgent({
    agents: deps.agents,
    outils: deps.outils,
    politiqueMentionIa: async () => reglages.mentionIaFrequence,
    disponibiliteEquipe: async () => equipePourPrompt(
      reglages.agentTransfertMode ?? MODE_TRANSFERT_DEFAUT,
      new Date(),
      reglages.timezone,
      reglages.businessHours,
    ),
  }, tenantId, agentId);
}
