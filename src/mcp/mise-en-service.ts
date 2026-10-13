import type { NomOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import { ETAPES_CARTE_META } from '../../web/lib/partage/etapes-meta';
import { modeEffectif, sousLOffre, type ModeRepondeur, type ReglageDuRepondeur } from '../repondeur/mode';
import { manquesDeLAgent, type DepsGestionAgents } from '../agent/gestion';
import { eurosDepuisMicro } from '../agent/devise';
import type { AgentResume } from '../agent/agent-store';
import type { EtatConnexion } from '../otp/etat-connexion';
import type { VueOffre } from '../offres/vue';
import type { WidgetRow } from '../widgets/store.pg';
import { journaliser } from '../lib/journal';

/**
 * OÙ EN EST LA MISE EN SERVICE D'UN ESPACE (lot 10, outil `get_setup_state`). La skill de mise en service du plugin
 * Claude Code l'appelle en premier : elle saute ce qui est fait et reprend une session coupée là où elle s'était arrêtée.
 * La règle de l'étape suivante est écrite ICI, une fois ; la skill la décrit, elle ne la refait pas.
 *
 * 🔴 RIEN N'EST BLOQUÉ : l'outil lit et conseille, les autres outils marchent comme avant (décision de Julien du
 * 2026-10-12, la « troisième couche » du plan, qui refuserait un outil appelé trop tôt, est hors du lot).
 *
 * 🔴 UN RÉPONDEUR CHOISI N'EST JAMAIS DÉFAIT : l'agent de Meta, un scénario ou l'application de l'espace (le mode
 * ÉCRIT, même gelé par l'offre) sont des choix. Ils sautent les étapes de l'agent IA et du répondeur : l'outil ne pousse
 * ni à créer un agent dont personne n'a besoin, ni à quitter le mode « mba », qui retirerait à l'agent de Meta les
 * contacts qu'il tient. Un mode gelé par l'offre (l'agent de Meta en Free) le dit par `repondeur_gele_par_l_offre`.
 */

/** Les étapes, dans l'ordre du parcours, et les outils qui les font. Un nom d'outil inconnu ne compile pas. */
export const OUTILS_DE_L_ETAPE = {
  connecter_numero: ['start_whatsapp_connection', 'watch_whatsapp_connection'],
  // Relié, mais Meta ne l'a pas encore activé : la vérification se finit dans l'Accueil de la console, aucun outil.
  activer_numero: [],
  creer_agent: ['create_agent'],
  completer_agent: [
    'get_agent', 'update_agent', 'preview_site', 'import_site', 'add_knowledge', 'import_document_text', 'set_agent_tools',
    'set_business_hours', 'set_transfer_mode',
  ],
  activer_agent: ['activate_agent'],
  choisir_repondeur: ['set_default_responder'],
  poser_bulle: ['create_widget'],
  pret: [],
} as const satisfies Record<string, readonly NomOutilMcp[]>;

export type EtapeMiseEnService = keyof typeof OUTILS_DE_L_ETAPE;

/** Les avertissements que l'outil peut rendre ; `lecture_manquee` porte la source après un deux-points. */
export const AVERTISSEMENTS = [
  'numero_a_activer', 'credit_epuise', 'repondeur_gele_par_l_offre', 'carte_meta_a_regler', 'lecture_manquee',
] as const;

/** Ce que l'outil lit, une source par champ ; `null` = la lecture a échoué. */
export interface LecturesMiseEnService {
  offre: Pick<VueOffre, 'offre' | 'fonctions'> | null;
  soldeMicroEur: number | null;
  numero: EtatConnexion | null;
  /** `nbManques` : pour un brouillon, ce qui bloque encore son activation (`null` = non lu). */
  agents: Array<Pick<AgentResume, 'id' | 'label' | 'status'> & { nbManques: number | null }> | null;
  reglages: ReglageDuRepondeur | null;
  widgets: Array<Pick<WidgetRow, 'id' | 'nom' | 'actif'>> | null;
}

export interface EtatMiseEnService {
  offre: VueOffre['offre'] | null;
  credit_eur: number | null;
  numero: { connecte: boolean; a_activer: boolean; chiffres: string | null; fourni: string | null; abonnement: string | null } | null;
  agents: {
    actifs: Array<{ id: string; label: string }>;
    a_completer: Array<{ id: string; label: string; nb_manques: number | null }>;
    desactives: Array<{ id: string; label: string }>;
  } | null;
  /** `mode` : qui répond vraiment, tel que l'offre le laisse jouer ; `mode_choisi` : le réglage de l'espace. */
  repondeur: { mode: ModeRepondeur; mode_choisi: ModeRepondeur; agent_id: string | null } | null;
  bulles: { actives: number; total: number } | null;
  etape_suivante: EtapeMiseEnService;
  outils_suggeres: readonly NomOutilMcp[];
  /** Ceux d'`AVERTISSEMENTS`, `lecture_manquee:<source>` pour une lecture qui a échoué. */
  avertissements: string[];
  /** Avec `carte_meta_a_regler` seulement : le chemin chez Meta, la même source que l'Accueil (`ETAPES_CARTE_META`). */
  etapes_carte_meta?: string[];
}

export function etatMiseEnService(l: LecturesMiseEnService): EtatMiseEnService {
  const avertissements: string[] = [];
  for (const [source, valeur] of [['offre', l.offre], ['credit', l.soldeMicroEur], ['numero', l.numero], ['agents', l.agents],
    ['repondeur', l.reglages], ['bulles', l.widgets]] as const) {
    if (valeur === null) avertissements.push(`lecture_manquee:${source}`);
  }

  const numero = l.numero === null ? null : {
    connecte: l.numero.connecte !== null && !l.numero.connecte.aActiver,
    a_activer: l.numero.connecte?.aActiver ?? false,
    chiffres: l.numero.connecte?.chiffres || null,
    fourni: l.numero.fourni,
    abonnement: l.numero.abonnement?.statut ?? null,
  };
  if (numero?.a_activer) avertissements.push('numero_a_activer');
  // Connecté mais bloqué chez Meta pour sa carte : les modèles ne partent pas (erreur 141006, guide « compte Meta »).
  const carteARegler = numero?.connecte === true && l.numero?.connecte?.paiementBloque === true;
  if (carteARegler) avertissements.push('carte_meta_a_regler');

  const agents = l.agents === null ? null : {
    actifs: l.agents.filter((a) => a.status === 'active').map((a) => ({ id: a.id, label: a.label })),
    a_completer: l.agents.filter((a) => a.status === 'draft').map((a) => ({ id: a.id, label: a.label, nb_manques: a.nbManques })),
    desactives: l.agents.filter((a) => a.status === 'disabled').map((a) => ({ id: a.id, label: a.label })),
  };

  // Le mode que l'offre laisse jouer (`sousLOffre`), le même que le contrôle du fil ; et le mode CHOISI, celui que
  // l'espace a réglé, qui décide des étapes (un choix gelé par l'offre reste un choix).
  const reglages = l.reglages === null ? null : l.offre === null ? l.reglages : sousLOffre(l.reglages, new Set(l.offre.fonctions));
  const repondeur = l.reglages === null || reglages === null ? null : {
    mode: modeEffectif(reglages),
    mode_choisi: modeEffectif(l.reglages),
    agent_id: modeEffectif(reglages) === 'agent' ? reglages.repondeurAgentId : null,
  };
  if (repondeur !== null && repondeur.mode !== repondeur.mode_choisi) avertissements.push('repondeur_gele_par_l_offre');
  const repondeurChoisi = repondeur !== null && ['mba', 'scenario', 'application'].includes(repondeur.mode_choisi);

  const bulles = l.widgets === null ? null : { actives: l.widgets.filter((w) => w.actif).length, total: l.widgets.length };

  if (l.soldeMicroEur !== null && l.soldeMicroEur <= 0) avertissements.push('credit_epuise');

  const etape = ((): EtapeMiseEnService => {
    if (numero !== null && numero.a_activer) return 'activer_numero';
    if (numero !== null && !numero.connecte) return 'connecter_numero';
    if (!repondeurChoisi && agents !== null && agents.actifs.length === 0) {
      // Le brouillon en cours d'abord : c'est lui qu'une session coupée construisait, pas l'agent qu'on avait désactivé.
      if (agents.a_completer.length > 0) return agents.a_completer.some((a) => a.nb_manques === 0) ? 'activer_agent' : 'completer_agent';
      return agents.desactives.length > 0 ? 'activer_agent' : 'creer_agent';
    }
    if (!repondeurChoisi && repondeur !== null && repondeur.mode === 'equipe' && (agents === null || agents.actifs.length > 0)) {
      return 'choisir_repondeur';
    }
    if (bulles !== null && bulles.actives === 0) return 'poser_bulle';
    return 'pret';
  })();

  return {
    offre: l.offre?.offre ?? null,
    credit_eur: l.soldeMicroEur === null ? null : eurosDepuisMicro(l.soldeMicroEur),
    numero,
    agents,
    repondeur,
    bulles,
    etape_suivante: etape,
    outils_suggeres: OUTILS_DE_L_ETAPE[etape],
    avertissements,
    ...(carteARegler ? { etapes_carte_meta: ETAPES_CARTE_META.map((e) => e.fr) } : {}),
  };
}

/** Ce que la lecture demande au câblage du serveur MCP : un sous-ensemble de `DepsMcp`, rien de neuf. */
export interface DepsMiseEnService {
  offre: { vue(tenantId: string): Promise<Pick<VueOffre, 'offre' | 'fonctions'>> };
  numero: { etat(tenantId: string): Promise<EtatConnexion> };
  agentIa: {
    gestion: Pick<DepsGestionAgents, 'etatPourLint'> & {
      agents: { listToutes(tenantId: string): Promise<AgentResume[]> };
      credits: { solde(tenantId: string): Promise<number> };
    };
    repondeur: { reglages: { get(tenantId: string): Promise<ReglageDuRepondeur> } };
  };
  widgets: { gestion: { widgets: { lister(tenantId: string): Promise<WidgetRow[]> } } };
}

/**
 * Une source en panne rend `null` (dit par `lecture_manquee:<source>`) au lieu de faire échouer tout l'outil, et laisse
 * une trace : une panne durable se verrait sinon chez le client seulement.
 */
function ou<T>(p: Promise<T>, tenantId: string, source: string): Promise<T | null> {
  return p.catch((err: unknown) => {
    journaliser('warn', 'mise_en_service_lecture_manquee', { tenantId, source, err: err instanceof Error ? err.message : String(err) });
    return null;
  });
}

export async function lireMiseEnService(deps: DepsMiseEnService, tenantId: string): Promise<EtatMiseEnService> {
  const g = deps.agentIa.gestion;
  const [offre, soldeMicroEur, numero, liste, reglages, widgets] = await Promise.all([
    ou(deps.offre.vue(tenantId), tenantId, 'offre'),
    ou(g.credits.solde(tenantId), tenantId, 'credit'),
    ou(deps.numero.etat(tenantId), tenantId, 'numero'),
    ou(g.agents.listToutes(tenantId), tenantId, 'agents'),
    ou(deps.agentIa.repondeur.reglages.get(tenantId), tenantId, 'repondeur'),
    ou(deps.widgets.gestion.widgets.lister(tenantId), tenantId, 'bulles'),
  ]);
  // Les manques, pour les brouillons seulement (la lecture de la console, `/manques`) : un espace en porte quelques-uns.
  const agents = liste === null ? null : await Promise.all(liste.map(async (a) => ({
    id: a.id, label: a.label, status: a.status,
    nbManques: a.status === 'draft' ? ((await ou(manquesDeLAgent(g, tenantId, a.id), tenantId, 'manques'))?.manques.length ?? null) : null,
  })));
  return etatMiseEnService({ offre, soldeMicroEur, numero, agents, reglages, widgets });
}
