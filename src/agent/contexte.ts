import type { AgentStore } from './agent-store';
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
    mentionIaFrequence: fiche.mentionIaFrequence,
    sorties: fiche.contenu.sorties,
    contenu: fiche.contenu,
    outilsActifs: await deps.outils.listActifs(tenantId, agentId),
    plafonds: { maxAppelsOutils: fiche.maxAppelsOutils, budgetMicroEur: fiche.budgetMicroEur },
    // La politique face à un contact inconnu vient de la FICHE, jamais de l'appelant : c'est ce qui fait que
    // le bac à sable montre le même refus d'outil que la production.
    contactInconnu: fiche.contactInconnu,
  };
}
