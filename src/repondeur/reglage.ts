import type { AgentComplet } from '../agent/agent-store';
import type { AuteurModification } from '../agent/gestion';
import { EtatMetaIllisible, MetaARefuse, type ResultatActivation } from '../mba/activation';
import type { ListeDeLAgent } from '../mba/liste';
import type { HistoriqueStore } from '../reglages/historique';
import { estUuid } from '../http/scope';
import { refus, type Issue } from '../lib/issue';
import { journaliser } from '../lib/journal';

/**
 * LE RÉGLAGE DU RÉPONDEUR DE L'ESPACE (lot 5, spec `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`,
 * § 3) : quel agent IA répond à tout message que personne ne tient.
 *
 * 🔴 UNE SEULE VOIX. La base la garantit (`tenant_settings_repondeur_une_voix_chk`, migration 0209) ; ce module fait
 * le geste qui la rend vraie chez Meta aussi. Désigner un agent IA alors que l'agent de Meta est allumé l'éteint par
 * le chemin de l'Accueil (`appliquerActivation(false)`, `activationPour` dans `src/http/mba.ts`), puis retire de la
 * liste de l'agent de Meta tous les contacts qu'il tenait (`toutRetirer`) : sans ce retrait, Meta continuerait de
 * ranger en `standby` les messages de ces contacts, que nos étapes ignorent. Le réglage s'écrit EN DERNIER : écrit
 * avant, le CHECK lèverait (l'agent de Meta encore allumé), ou deux voix répondraient le temps de l'extinction.
 *
 * UNE SEULE VÉRITÉ, DEUX PORTES, comme la gestion d'un agent (`src/agent/gestion.ts`) : la route de la console
 * (`PUT /tenants/:tenantId/agents/repondeur`) et l'outil MCP `set_default_responder` appellent CETTE fonction.
 */

export interface DepsReglageRepondeur {
  /** La fiche, scopée espace : `null` = inconnu ici (supprimé, ou d'un autre espace). */
  agents: { complet(tenantId: string, id: string): Promise<Pick<AgentComplet, 'id' | 'label' | 'status'> | null> };
  reglages: {
    get(tenantId: string): Promise<{ mbaEnabled: boolean; repondeurAgentId: string | null }>;
    setRepondeur(tenantId: string, agentId: string | null): Promise<void>;
  };
  /**
   * Le modèle est-il configuré sur cette instance (`AI_GATEWAY_API_KEY`) ? Sans lui, la file des tours d'agent n'est
   * pas consommée : un répondeur désigné laisserait chaque contact muet derrière un parcours qui attend pour toujours.
   */
  gatewayDisponible: boolean;
  /** Éteint l'agent de Meta par le chemin de l'Accueil. Lève `EtatMetaIllisible` ou `MetaARefuse`, sans rien écrire. */
  eteindreAgentDeMeta(tenantId: string): Promise<ResultatActivation>;
  /** La liste de l'agent de Meta (`src/mba/liste.ts`), le seul module qui la touche. */
  liste: Pick<ListeDeLAgent, 'toutRetirer'>;
  /** L'historique des réglages : le changement de répondeur y laisse sa ligne, avec son auteur et sa porte. */
  historique: Pick<HistoriqueStore, 'ecrire'>;
}

/** Ce que le geste a fait, rendu tel quel à l'écran et à l'outil MCP. */
export interface ReglageRepondeur {
  repondeurAgentId: string | null;
  /** L'agent de Meta était allumé, et ce geste vient de l'éteindre pour tous les contacts de l'espace. */
  agentDeMetaEteint: boolean;
  /** Les contacts retirés de la liste de l'agent de Meta, et ceux que Meta a refusé de retirer (ils y restent). */
  liste: { retires: number; refuses: number };
}

const INTROUVABLE = 'agent introuvable';
const PAS_DE_MODELE = 'les agents IA ne peuvent pas répondre sur cette instance (aucun modèle configuré) : le répondeur ne peut pas être réglé.';
const PAS_ACTIF = 'seul un agent actif peut être le répondeur de l’espace : activez-le d’abord.';
const DEUX_VOIX = 'l’agent de Meta vient d’être rallumé sur cet espace : rien n’a été changé, réessayez.';

/** L'erreur Postgres d'une contrainte, lue sans `as` sur sa forme. */
function contrainteViolee(err: unknown): { code: string; contrainte: string } | null {
  if (err === null || typeof err !== 'object') return null;
  const { code, constraint } = err as Record<string, unknown>;
  return typeof code === 'string' ? { code, contrainte: typeof constraint === 'string' ? constraint : '' } : null;
}

/**
 * Désigne l'agent IA répondeur de l'espace, ou le retire (`null`). Refuse un agent inconnu (404), inactif (422), ou
 * une instance sans modèle (422) ; un refus de Meta à l'extinction de son agent (409) n'écrit rien.
 */
export async function choisirRepondeur(
  deps: DepsReglageRepondeur, tenantId: string, agentId: string | null, auteur: AuteurModification,
): Promise<Issue<ReglageRepondeur>> {
  const avant = await deps.reglages.get(tenantId);
  const rien = { retires: 0, refuses: 0 };
  if (agentId === null) {
    await deps.reglages.setRepondeur(tenantId, null);
    if (avant.repondeurAgentId !== null) {
      await journaliserLigne(deps, tenantId, avant.repondeurAgentId, 'Répondeur de l’espace : retiré', avant, null, auteur);
    }
    return { ok: true, valeur: { repondeurAgentId: null, agentDeMetaEteint: false, liste: rien } };
  }
  // Identifiant mal formé : 404, sinon Postgres lèverait sur la colonne `uuid` (donc un 500).
  if (!estUuid(agentId)) return refus(404, INTROUVABLE);
  if (!deps.gatewayDisponible) return refus(422, PAS_DE_MODELE);
  const agent = await deps.agents.complet(tenantId, agentId);
  if (!agent) return refus(404, INTROUVABLE);
  if (agent.status !== 'active') return refus(422, PAS_ACTIF);
  // Déjà le répondeur, agent de Meta éteint : rien à faire, et rien à journaliser.
  if (avant.repondeurAgentId === agentId && !avant.mbaEnabled) {
    return { ok: true, valeur: { repondeurAgentId: agentId, agentDeMetaEteint: false, liste: rien } };
  }

  let agentDeMetaEteint = false;
  if (avant.mbaEnabled) {
    try {
      await deps.eteindreAgentDeMeta(tenantId);
      agentDeMetaEteint = true;
    } catch (err) {
      // 4xx, jamais 5xx (Cloudflare remplacerait le corps). Rien n'a été écrit : ni chez Meta, ni chez nous.
      if (err instanceof EtatMetaIllisible) return refus(409, 'L’état de l’agent de Meta n’a pas pu être lu. Rien n’a été changé, réessayez dans un instant.');
      if (err instanceof MetaARefuse) return refus(409, 'Meta a refusé d’éteindre son agent. Rien n’a été changé de notre côté.');
      throw err;
    }
  }
  // Toujours, même agent de Meta déjà éteint : un contact resté sur sa liste verrait ses messages rangés en `standby`.
  const liste = await deps.liste.toutRetirer(tenantId);
  try {
    await deps.reglages.setRepondeur(tenantId, agentId);
  } catch (err) {
    const c = contrainteViolee(err);
    // Quelqu'un a rallumé l'agent de Meta entre l'extinction et l'écriture : le CHECK d'une seule voix a tenu.
    if (c?.code === '23514' && c.contrainte === 'tenant_settings_repondeur_une_voix_chk') return refus(409, DEUX_VOIX);
    // L'agent a été supprimé entre la lecture et l'écriture.
    if (c?.code === '23503') return refus(404, INTROUVABLE);
    throw err;
  }
  const libelle = `Répondeur de l’espace : ${agent.label}${agentDeMetaEteint ? ' (l’agent de Meta est éteint)' : ''}`;
  await journaliserLigne(deps, tenantId, agentId, libelle, avant, { repondeurAgentId: agentId, mbaEnabled: false, liste }, auteur);
  return { ok: true, valeur: { repondeurAgentId: agentId, agentDeMetaEteint, liste } };
}

/**
 * La ligne `repondeur` de l'historique, sur l'agent concerné. 🔴 Au mieux : le réglage est déjà écrit, et traiter un
 * échec de journal en échec ferait réessayer un geste passé (une seconde extinction chez Meta).
 */
async function journaliserLigne(
  deps: DepsReglageRepondeur, tenantId: string, agentId: string, libelle: string,
  avant: { mbaEnabled: boolean; repondeurAgentId: string | null }, apres: unknown, auteur: AuteurModification,
): Promise<void> {
  try {
    await deps.historique.ecrire(tenantId, {
      surface: 'agent', surfaceId: agentId, element: 'repondeur', operation: 'modification', cible: null, libelle,
      avant: { repondeurAgentId: avant.repondeurAgentId, mbaEnabled: avant.mbaEnabled }, apres,
      origine: auteur.origine, acteurEmail: null, acteurId: auteur.userId,
    });
  } catch (err) {
    journaliser('error', 'repondeur_non_journalise', { err, tenantId, agentId });
  }
}
