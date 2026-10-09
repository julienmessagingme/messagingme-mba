/**
 * Qui répond au client : les modes du répondeur, les bornes du délai du mode « Scénario » et le mode EFFECTIF d'un
 * réglage, PARTAGÉS par le serveur (`src/repondeur/mode.ts`, qui décide) et la console (`web/lib/repondeur.ts`, qui
 * l'affiche) : l'écran ne peut plus annoncer un autre répondeur que celui qui répondra. Fonctions pures.
 */

export const MODES_REPONDEUR = ['mba', 'agent', 'scenario', 'equipe', 'application'] as const;
export type ModeRepondeur = (typeof MODES_REPONDEUR)[number];

export function estModeRepondeur(v: unknown): v is ModeRepondeur {
  return typeof v === 'string' && (MODES_REPONDEUR as readonly string[]).includes(v);
}

/** Le délai du mode Scénario, en secondes : 24 h par défaut, de 1 h à 30 jours (bornes du CHECK de 0217). */
export const DELAI_SCENARIO_DEFAUT_S = 24 * 60 * 60;
export const DELAI_SCENARIO_MIN_S = 60 * 60;
export const DELAI_SCENARIO_MAX_S = 30 * 24 * 60 * 60;
/** Les mêmes, en heures : l'unité de l'écran et de l'outil MCP `set_default_responder`. */
export const DELAI_SCENARIO_HEURES_DEFAUT = DELAI_SCENARIO_DEFAUT_S / 3600;
export const DELAI_SCENARIO_HEURES_MIN = DELAI_SCENARIO_MIN_S / 3600;
export const DELAI_SCENARIO_HEURES_MAX = DELAI_SCENARIO_MAX_S / 3600;

/** Ce que le mode lit des réglages de l'espace (`TenantSettings`). */
export interface ReglageDuRepondeur {
  mbaEnabled: boolean;
  repondeurMode: ModeRepondeur;
  repondeurAgentId: string | null;
  repondeurWorkflowId: string | null;
  /** L'adresse désignée du mode `application` (0224), `null` si elle a été supprimée. En pause, elle reste désignée. */
  repondeurAdresseId: string | null;
}

/**
 * Le mode qui S'APPLIQUE, et pas celui qui est écrit. Trois états écrits sont atteignables sans être tenables, et
 * tous trois se lisent « Équipe » (l'écran le signale, `GET /tenants/:id/repondeur`) :
 *  - `agent` sans agent : l'agent a été supprimé après coup (clé étrangère en `on delete set null`) ;
 *  - `scenario` sans scénario : même chose pour le scénario ;
 *  - `mba` avec l'agent de Meta éteint : aucun chemin ne l'écrit (`setMbaEnabled` passe le mode à `equipe` dans la
 *    même instruction), c'est une ceinture.
 * 🔴 Un CHECK qui refuserait les deux premiers ferait ÉCHOUER la suppression d'un agent ou d'un scénario (leçon de
 * 0144) : la base ne tient que le sens inverse (une cible n'existe que dans son mode).
 */
export function modeEffectif(r: ReglageDuRepondeur): ModeRepondeur {
  switch (r.repondeurMode) {
    case 'mba': return r.mbaEnabled ? 'mba' : 'equipe';
    case 'agent': return r.repondeurAgentId !== null ? 'agent' : 'equipe';
    case 'scenario': return r.repondeurWorkflowId !== null ? 'scenario' : 'equipe';
    case 'equipe': return 'equipe';
    case 'application': return r.repondeurAdresseId !== null ? 'application' : 'equipe';
  }
}
