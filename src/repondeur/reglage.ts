import type { AgentComplet } from '../agent/agent-store';
import type { AuteurModification } from '../agent/gestion';
import {
  agentDeMetaConfigurable, appliquerActivation, EtatMetaIllisible, MetaARefuse, type ActivationDeps, type ResultatActivation,
} from '../mba/activation';
import type { ListeDeLAgent } from '../mba/liste';
import type { HistoriqueStore } from '../reglages/historique';
import type { ControleDuFil } from '../inbox/fil';
import type { ChoixRepondeurEcrit } from '../settings/store.pg';
import type { WorkflowResumeRow, WorkflowRow } from '../workflow/store.pg';
import { estUuid } from '../http/scope';
import { refus, type Issue } from '../lib/issue';
import { journaliser } from '../lib/journal';
import {
  DELAI_SCENARIO_MAX_S, DELAI_SCENARIO_MIN_S, modeEffectif, type ModeRepondeur, type ReglageDuRepondeur,
} from './mode';

/**
 * LE RÉGLAGE « QUI RÉPOND AU CLIENT » (RC6, plan `docs/superpowers/plans/2026-10-06-rc6-qui-repond.md`, A2 ; le lot 5
 * en posait la première moitié, `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`). Quatre modes
 * (`src/repondeur/mode.ts`), et ce module est leur SEUL écrivain, pour ses deux portes : la carte de l'Accueil
 * (`PUT /tenants/:tenantId/repondeur`, et l'ancienne `PUT .../agents/repondeur`) et l'outil MCP `set_default_responder`.
 *
 * Ce que chaque choix fait, dans cet ordre, et rien d'écrit sur un refus :
 *  - `mba` : l'agent de Meta doit être configurable (un numéro, et Meta l'a ouvert sur ce numéro) ; éteint, il est
 *    allumé par le chemin de l'Accueil (`appliquerActivation(true)`, Meta d'abord, puis le drapeau).
 *  - `agent` : un agent ACTIF de l'espace, et le modèle configuré sur l'instance (les règles du lot 5). 🔴 Il n'éteint
 *    PLUS l'agent de Meta : allumé, celui-ci reste disponible, en veille (la contrainte d'une seule voix est levée).
 *  - `scenario` : un scénario PUBLIÉ de l'espace (le magasin cache le scénario système), et un délai de 1 h à 30 jours.
 *  - `equipe` : rien à vérifier.
 * Puis le réglage s'écrit, EN PREMIER parmi les effets : une fois écrit, la remise ne confie plus rien à l'agent de
 * Meta. Puis, si l'espace QUITTE le mode `mba`, les contacts qu'il tenait sont retirés de sa liste (`toutRetirer`) et
 * les fils que notre colonne lui donnait reviennent aux robots (`reprendreLesFilsDeMeta`) : sans eux, il continuerait
 * de parler aux contacts de sa liste. Dans l'ordre inverse, une remise passée entre le retrait et l'écriture lirait
 * encore le mode `mba` et remettrait le contact sur la liste. Enfin la ligne `repondeur` de l'historique.
 */

/** Ce que demande la personne qui règle. `delaiS` absent : le délai déjà réglé (24 h pour un espace qui n'en a pas). */
export type ChoixRepondeur =
  | { mode: 'mba' }
  | { mode: 'agent'; agentId: string }
  | { mode: 'scenario'; workflowId: string; delaiS?: number }
  | { mode: 'equipe' };

export interface DepsReglageRepondeur {
  /** La fiche, scopée espace : `null` = inconnu (supprimé, ou d'un autre espace). */
  agents: { complet(tenantId: string, id: string): Promise<Pick<AgentComplet, 'id' | 'label' | 'status'> | null> };
  /**
   * Les scénarios, scopés espace, système exclu (`PgWorkflowStore`) : `getById` rend `null` pour un inconnu ici ;
   * `listResume` sert la liste des scénarios publiés de la carte (`nodeCount` : les blocs du graphe EN LIGNE).
   */
  scenarios: {
    getById(id: string, tenantId: string): Promise<Pick<WorkflowRow, 'id' | 'name' | 'graph'> | null>;
    listResume(tenantId: string): Promise<Array<Pick<WorkflowResumeRow, 'id' | 'name' | 'nodeCount'>>>;
  };
  reglages: {
    get(tenantId: string): Promise<ReglageDuRepondeur & { repondeurDelaiScenarioS: number }>;
    setRepondeur(tenantId: string, choix: ChoixRepondeurEcrit): Promise<void>;
  };
  /**
   * Le modèle est-il configuré sur cette instance (`AI_GATEWAY_API_KEY`) ? Sans lui, la file des tours d'agent n'est
   * pas consommée : un agent répondeur laisserait chaque contact muet derrière un parcours qui attend pour toujours.
   */
  gatewayDisponible: boolean;
  /**
   * L'allumage et l'éligibilité de l'agent de Meta, par le chemin de l'Accueil (`activationPour`, `src/http/mba.ts`) :
   * une seconde construction écrirait un jour chez Meta autrement que l'interrupteur.
   */
  activation: ActivationDeps;
  /** La liste de l'agent de Meta (`src/mba/liste.ts`), le seul module qui la touche. */
  liste: Pick<ListeDeLAgent, 'toutRetirer'>;
  /** L'historique des réglages : le changement de répondeur y laisse sa ligne, avec son auteur et sa porte. */
  historique: Pick<HistoriqueStore, 'ecrire'>;
  /** Le contrôle du fil (`src/inbox/fil.ts`), le seul qui écrit le détenteur d'une conversation. */
  fils: Pick<ControleDuFil, 'reprendreLesFilsDeMeta'>;
}

/** Ce que le geste a fait, rendu tel quel à l'écran et à l'outil MCP. */
export interface ReglageRepondeur {
  mode: ModeRepondeur;
  agentId: string | null;
  workflowId: string | null;
  delaiS: number;
  /** Ce geste vient d'allumer l'agent de Meta (mode `mba` choisi alors qu'il était éteint). */
  agentDeMetaAllume: boolean;
  /**
   * Les contacts retirés de la liste de l'agent de Meta, et ceux que Meta a refusé de retirer (ils y restent), quand
   * l'espace a quitté le mode `mba`. Zéro sinon.
   */
  liste: { retires: number; refuses: number };
}

const AGENT_INTROUVABLE = 'agent introuvable';
const SCENARIO_INTROUVABLE = 'scénario introuvable';
const PAS_DE_MODELE = 'les agents IA ne peuvent pas répondre sur cette instance (aucun modèle configuré) : choisissez un autre répondeur.';
const PAS_ACTIF = 'seul un agent actif peut répondre au client : activez-le d’abord.';
const PAS_PUBLIE = 'seul un scénario publié peut répondre au client : publiez-le d’abord.';
const MBA_NON_CONFIGURE = 'l’agent de Meta n’est pas disponible sur cet espace : reliez un numéro WhatsApp et configurez l’agent d’abord.';
const DELAI_HORS_BORNES = `le délai du scénario va de ${DELAI_SCENARIO_MIN_S / 3600} h à ${DELAI_SCENARIO_MAX_S / 86400} jours.`;
const ILLISIBLE = 'L’état de l’agent de Meta n’a pas pu être lu. Rien n’a été changé, réessayez dans un instant.';
const META_REFUSE = 'Meta a refusé d’allumer son agent. Rien n’a été changé de notre côté.';

/**
 * Ce que la carte « Qui répond au client » de l'Accueil lit, en un appel (`GET /tenants/:tenantId/repondeur`).
 * `mode` est le mode ÉCRIT, `modeEffectif` celui qui s'applique : quand ils diffèrent, la cible a disparu (agent
 * désactivé ou supprimé, scénario supprimé, agent de Meta éteint) et l'écran le dit.
 */
export interface EtatRepondeur {
  mode: ModeRepondeur;
  modeEffectif: ModeRepondeur;
  agentId: string | null;
  workflowId: string | null;
  delaiS: number;
  /** L'agent de Meta est allumé (disponible), répondeur ou en veille. */
  mbaAllume: boolean;
  /** Il peut l'être : un numéro, et Meta l'a ouvert. Une lecture de Meta en échec vaut `false` (la position est grisée). */
  mbaConfigurable: boolean;
  /** Le modèle est configuré sur l'instance : sans lui, la position « Agent IA » est grisée. */
  modeleDisponible: boolean;
  agentsActifs: Array<{ id: string; label: string }>;
  scenariosPublies: Array<{ id: string; name: string }>;
}

export async function lireRepondeur(
  deps: Pick<DepsReglageRepondeur, 'reglages' | 'activation' | 'scenarios' | 'gatewayDisponible'>,
  tenantId: string,
  agentsActifs: (tenantId: string) => Promise<Array<{ id: string; label: string }>>,
): Promise<EtatRepondeur> {
  const [r, configurable, agents, scenarios] = await Promise.all([
    deps.reglages.get(tenantId),
    // Une panne de lecture chez Meta grise la position : c'est un affichage, l'écran ne doit pas tomber pour lui.
    // Le choix lui-même, s'il est tenté, redemande et refuse lisiblement.
    agentDeMetaConfigurable(deps.activation, tenantId).catch(() => false),
    agentsActifs(tenantId),
    deps.scenarios.listResume(tenantId),
  ]);
  return {
    mode: r.repondeurMode,
    modeEffectif: modeEffectif(r),
    agentId: r.repondeurAgentId,
    workflowId: r.repondeurWorkflowId,
    delaiS: r.repondeurDelaiScenarioS,
    mbaAllume: r.mbaEnabled,
    // Allumé, il l'est forcément : la lecture de Meta ne grise pas une position déjà en service.
    mbaConfigurable: r.mbaEnabled || configurable,
    modeleDisponible: deps.gatewayDisponible,
    agentsActifs: agents.map((a) => ({ id: a.id, label: a.label })),
    scenariosPublies: scenarios.filter((s) => s.nodeCount > 0).map((s) => ({ id: s.id, name: s.name })),
  };
}

/**
 * L'ancienne forme du réglage (lot 5 : un agent, ou `null`), encore acceptée par l'outil MCP `set_default_responder` et
 * par `PUT .../agents/repondeur` : un agent = le mode `agent` ; `null` = « aucun agent IA », donc l'agent de Meta s'il
 * est allumé (ce qu'il était, une fois l'agent IA retiré, avant RC6), sinon l'équipe.
 */
export function choixDeLAncienneForme(agentId: string | null, mbaAllume: boolean): ChoixRepondeur {
  if (agentId !== null) return { mode: 'agent', agentId };
  return mbaAllume ? { mode: 'mba' } : { mode: 'equipe' };
}

/** L'erreur Postgres d'une contrainte, lue sans `as` sur sa forme. */
function codeSql(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null;
  const { code } = err as Record<string, unknown>;
  return typeof code === 'string' ? code : null;
}

/**
 * Règle qui répond au client. Refuse une cible inconnue (404), un agent inactif ou un scénario non publié (422), une
 * instance sans modèle (422), un délai hors bornes (400), un agent de Meta qui n'est pas configurable (422) ; un état
 * de Meta illisible ou un refus de Meta à l'allumage (409) n'écrit rien.
 */
export async function choisirRepondeur(
  deps: DepsReglageRepondeur, tenantId: string, choix: ChoixRepondeur, auteur: AuteurModification,
): Promise<Issue<ReglageRepondeur>> {
  const avant = await deps.reglages.get(tenantId);
  let ecrit: ChoixRepondeurEcrit;
  let libelle: string;
  switch (choix.mode) {
    case 'equipe':
      ecrit = { mode: 'equipe' };
      libelle = 'l’équipe';
      break;
    case 'agent': {
      // Identifiant mal formé : 404, sinon Postgres lèverait sur la colonne `uuid` (donc un 500).
      if (!estUuid(choix.agentId)) return refus(404, AGENT_INTROUVABLE);
      if (!deps.gatewayDisponible) return refus(422, PAS_DE_MODELE);
      const agent = await deps.agents.complet(tenantId, choix.agentId);
      if (!agent) return refus(404, AGENT_INTROUVABLE);
      if (agent.status !== 'active') return refus(422, PAS_ACTIF);
      ecrit = { mode: 'agent', agentId: agent.id };
      libelle = `l’agent IA ${agent.label}`;
      break;
    }
    case 'scenario': {
      if (!estUuid(choix.workflowId)) return refus(404, SCENARIO_INTROUVABLE);
      const delaiS = choix.delaiS ?? avant.repondeurDelaiScenarioS;
      if (!Number.isInteger(delaiS) || delaiS < DELAI_SCENARIO_MIN_S || delaiS > DELAI_SCENARIO_MAX_S) return refus(400, DELAI_HORS_BORNES);
      const wf = await deps.scenarios.getById(choix.workflowId, tenantId);
      if (!wf) return refus(404, SCENARIO_INTROUVABLE);
      // « Publié » = le graphe en ligne porte au moins un bloc (la règle de `listPublies`) : sinon il ne jouerait rien.
      if (wf.graph.nodes.length === 0) return refus(422, PAS_PUBLIE);
      ecrit = { mode: 'scenario', workflowId: wf.id, delaiS };
      libelle = `le scénario ${wf.name} (au plus une fois toutes les ${heures(delaiS)} par contact)`;
      break;
    }
    case 'mba':
      ecrit = { mode: 'mba' };
      libelle = 'l’agent de Meta';
      break;
  }

  // Déjà le réglage en vigueur (agent de Meta allumé s'il est choisi) : rien à faire, rien à journaliser.
  if (memeReglage(avant, ecrit)) {
    return { ok: true, valeur: vue(ecrit, avant.repondeurDelaiScenarioS, false, { retires: 0, refuses: 0 }) };
  }

  // Le mode `mba` exige l'agent de Meta ALLUMÉ : on l'allume avant d'écrire, et un refus n'écrit rien.
  let agentDeMetaAllume = false;
  if (ecrit.mode === 'mba' && !avant.mbaEnabled) {
    try {
      if (!(await agentDeMetaConfigurable(deps.activation, tenantId))) return refus(422, MBA_NON_CONFIGURE);
      const r: ResultatActivation = await appliquerActivation(deps.activation, tenantId, true);
      // Configurable un instant plus tôt, plus maintenant (numéro délié, éligibilité retirée) : la course est fugace, et
      // l'Accueil en fait autant (le drapeau seul est écrit, `appliquerActivation`, donc `setMbaEnabled` et sa règle de
      // mode). On le dit plutôt que d'annoncer un répondeur que Meta ne fera pas parler.
      if (r.chezMeta !== 'applique') return refus(422, MBA_NON_CONFIGURE);
      agentDeMetaAllume = true;
    } catch (err) {
      // 4xx, jamais 5xx (Cloudflare remplacerait le corps). Rien n'a été écrit, ni chez Meta ni chez nous.
      if (err instanceof EtatMetaIllisible) return refus(409, ILLISIBLE);
      if (err instanceof MetaARefuse) return refus(409, META_REFUSE);
      throw err;
    }
  }

  try {
    await deps.reglages.setRepondeur(tenantId, ecrit);
  } catch (err) {
    // L'agent ou le scénario a été supprimé entre la lecture et l'écriture (clé étrangère).
    if (codeSql(err) === '23503') return refus(404, ecrit.mode === 'scenario' ? SCENARIO_INTROUVABLE : AGENT_INTROUVABLE);
    throw err;
  }

  // L'espace QUITTE le mode `mba` (écrit, même agent de Meta éteint : sa liste peut encore porter des contacts).
  let liste = { retires: 0, refuses: 0 };
  let fils: number | null = 0;
  if (avant.repondeurMode === 'mba' && ecrit.mode !== 'mba') {
    liste = await deps.liste.toutRetirer(tenantId);
    fils = await reprendreLesFils(deps, tenantId);
  }
  const delaiApres = ecrit.mode === 'scenario' ? ecrit.delaiS : avant.repondeurDelaiScenarioS;
  await journaliserLigne(deps, tenantId, avant, ecrit, `Qui répond au client : ${libelle}`, { liste, fils }, auteur);
  return { ok: true, valeur: vue(ecrit, delaiApres, agentDeMetaAllume, liste) };
}

/** Le même réglage que celui en vigueur ? Le délai ne compte qu'en mode `scenario`. */
function memeReglage(avant: ReglageDuRepondeur & { repondeurDelaiScenarioS: number }, ecrit: ChoixRepondeurEcrit): boolean {
  if (avant.repondeurMode !== ecrit.mode) return false;
  switch (ecrit.mode) {
    case 'mba': return avant.mbaEnabled;
    case 'equipe': return true;
    case 'agent': return avant.repondeurAgentId === ecrit.agentId;
    case 'scenario': return avant.repondeurWorkflowId === ecrit.workflowId && avant.repondeurDelaiScenarioS === ecrit.delaiS;
  }
}

function vue(ecrit: ChoixRepondeurEcrit, delaiS: number, agentDeMetaAllume: boolean, liste: { retires: number; refuses: number }): ReglageRepondeur {
  return {
    mode: ecrit.mode,
    agentId: ecrit.mode === 'agent' ? ecrit.agentId : null,
    workflowId: ecrit.mode === 'scenario' ? ecrit.workflowId : null,
    delaiS,
    agentDeMetaAllume,
    liste,
  };
}

/** « 24 h », « 3 jours » : le délai tel que l'historique le dit. */
function heures(s: number): string {
  return s % 86400 === 0 && s >= 86400 * 2 ? `${s / 86400} jours` : `${Math.round(s / 3600)} h`;
}

/**
 * Les fils encore donnés à l'agent de Meta reviennent aux robots, APRÈS le réglage : écrite avant, une conversation
 * reprise serait relue en mode `mba` et confiée de nouveau. 🔴 Au mieux, pour la même raison que le journal : le
 * réglage est écrit, un échec ici ne doit pas faire réessayer le geste. `null` = échec.
 */
async function reprendreLesFils(deps: DepsReglageRepondeur, tenantId: string): Promise<number | null> {
  try {
    return await deps.fils.reprendreLesFilsDeMeta(tenantId);
  } catch (err) {
    journaliser('error', 'repondeur_fils_de_meta_non_repris', { err, tenantId });
    return null;
  }
}

/**
 * La ligne `repondeur` de l'historique. Sur l'agent IA concerné (le nouveau, sinon celui qu'on quitte) : c'est sa page
 * qui la montre ; sinon sur l'agent de Meta, unique par espace, le seul autre écran d'historique. 🔴 Au mieux : le
 * réglage est déjà écrit, et traiter un échec de journal en échec ferait réessayer un geste passé (un second allumage
 * chez Meta).
 */
async function journaliserLigne(
  deps: DepsReglageRepondeur, tenantId: string, avant: ReglageDuRepondeur & { repondeurDelaiScenarioS: number },
  ecrit: ChoixRepondeurEcrit, libelle: string, effets: unknown, auteur: AuteurModification,
): Promise<void> {
  const agentConcerne = ecrit.mode === 'agent' ? ecrit.agentId : (avant.repondeurMode === 'agent' ? avant.repondeurAgentId : null);
  try {
    await deps.historique.ecrire(tenantId, {
      ...(agentConcerne !== null ? { surface: 'agent' as const, surfaceId: agentConcerne } : { surface: 'mba' as const, surfaceId: null }),
      element: 'repondeur', operation: 'modification', cible: null, libelle,
      avant: {
        mode: avant.repondeurMode, modeEffectif: modeEffectif(avant), agentId: avant.repondeurAgentId,
        workflowId: avant.repondeurWorkflowId, delaiS: avant.repondeurDelaiScenarioS, mbaEnabled: avant.mbaEnabled,
      },
      apres: { ...ecrit, effets },
      origine: auteur.origine, acteurEmail: null, acteurId: auteur.userId,
    });
  } catch (err) {
    journaliser('error', 'repondeur_non_journalise', { err, tenantId });
  }
}
