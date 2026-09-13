import type { AgentStore, FrequenceMentionIa } from './agent-store';
import type { ToolCatalog } from './catalog';
import type { ContexteAgentComplet } from './brain.gateway';

/**
 * Tout ce que le cerveau doit savoir d'un agent : sa fiche, ses règles d'arrêt, ses outils ACTIFS.
 *
 * 🔴 UN SEUL POINT DE LECTURE, pour les deux consommateurs. Le tour de production (`src/worker.ts`) et le bac
 * à sable de la console (`src/index.ts`) construisaient chacun le leur, à l'identique : c'est exactement la
 * famille de doublons que l'audit anti-slop du 2026-08-18 a nettoyée. Le risque n'est pas la duplication en
 * soi, c'est qu'un champ ajouté d'un seul côté fasse diverger ce que le modèle voit selon qu'on teste ou
 * qu'on est en production, c'est-à-dire précisément ce que le bac à sable existe pour empêcher.
 *
 * Typée contre les CONTRATS (`AgentStore`, `ToolCatalog`) et non contre leurs implémentations Postgres : elle
 * se teste sans base.
 */
export interface DepsContexteAgent {
  agents: Pick<AgentStore, 'complet'>;
  outils: Pick<ToolCatalog, 'listActifs'>;
  /**
   * QUAND les agents de cet ESPACE annoncent qu'ils sont des IA (migration 0140).
   *
   * 🔴 UNE DEP À PART, parce que ce n'est plus un champ de la fiche : l'obligation d'information pèse sur la
   * marque déployante, donc un espace porte UNE politique et pas une par robot. La lire ici, dans le point
   * de passage unique, garantit que le bac à sable et la production voient la MÊME chose : c'est
   * précisément ce que ce module existe pour empêcher de diverger.
   *
   * ⚠️ Absente -> `session`, le défaut de 0126, donc le comportement d'avant. Un harnais de test qui ne la
   * câble pas ne change donc rien.
   */
  politiqueMentionIa?(tenantId: string): Promise<FrequenceMentionIa | null>;
}

export async function lireContexteAgent(
  deps: DepsContexteAgent, tenantId: string, agentId: string,
): Promise<ContexteAgentComplet | null> {
  const fiche = await deps.agents.complet(tenantId, agentId);
  if (!fiche) return null;
  return {
    // Le modèle de l'AGENT, pas celui de l'IA de construction : ce sont deux réglages distincts, et les
    // confondre ferait répondre aux contacts avec le modèle réservé au setup.
    modele: fiche.modele,
    mentionIa: fiche.mentionIa,
    // La politique de l'ESPACE, jamais celle de l'agent : la fiche n'en porte plus depuis 0140.
    mentionIaFrequence: (deps.politiqueMentionIa ? await deps.politiqueMentionIa(tenantId) : null) ?? 'session',
    sorties: fiche.contenu.sorties,
    contenu: fiche.contenu,
    outilsActifs: await deps.outils.listActifs(tenantId, agentId),
    plafonds: { maxAppelsOutils: fiche.maxAppelsOutils, budgetMicroEur: fiche.budgetMicroEur },
    // La politique face à un contact inconnu vient de la FICHE, jamais de l'appelant : c'est ce qui fait que
    // le bac à sable montre le même refus d'outil que la production.
    contactInconnu: fiche.contactInconnu,
  };
}
