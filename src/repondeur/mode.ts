/**
 * QUI RÉPOND AU CLIENT (RC6, plan `docs/superpowers/plans/2026-10-06-rc6-qui-repond.md`) : le réglage unique de
 * l'Accueil qui décide qui répond à un nouveau contact, ou à un message que personne ne tient.
 *
 *  - `mba` : l'agent de Meta. Il est alors le RÉPONDEUR, et lui seul reçoit les contacts que personne ne tient.
 *  - `agent` : un agent IA de la console (`tenant_settings.repondeur_agent_id`).
 *  - `scenario` : un scénario publié (`tenant_settings.repondeur_workflow_id`), relancé au plus une fois par délai pour
 *    un même contact (`repondeur_delai_scenario_s`) ; entre-temps, l'équipe.
 *  - `equipe` : personne ne répond automatiquement, la conversation entre dans « À traiter ».
 *
 * 🔴 ALLUMÉ N'EST PLUS RÉPONDEUR. L'agent de Meta allumé (`mba_enabled`) est DISPONIBLE : hors du mode `mba`, il est en
 * veille, et ni une remise, ni une fin de parcours, ni le balayage ne lui confie rien. Il ne prend un contact que par
 * le bloc « Envoyer au MBA » d'un scénario. La contrainte « une seule voix » de 0209 est levée (0217).
 *
 * 🔴 CETTE LISTE EST LA SEULE DU DÉPÔT, miroir du CHECK `tenant_settings_repondeur_mode_chk` (0217, tenu par
 * `tests/migration-0217.test.ts`). Un mode ajouté demain (« mon application répond ») s'ajoute ICI et dans le CHECK, et
 * chaque `switch` sur le mode refuse de compiler tant qu'il n'a pas sa branche (`modeEffectif`,
 * `standbyPourNous`, la remise de `src/inbox/fil.ts`).
 */
export const MODES_REPONDEUR = ['mba', 'agent', 'scenario', 'equipe'] as const;
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
  }
}

/**
 * L'agent de Meta est-il le RÉPONDEUR de l'espace ? La seule question que se posent la remise « personne ne suit »,
 * la fin d'un parcours, « Rendre la main » et le balayage avant de lui confier un contact. Allumé en veille : non.
 */
export function leMbaRepond(r: ReglageDuRepondeur): boolean {
  return modeEffectif(r) === 'mba';
}

/**
 * Un `standby` d'un contact ABSENT de la liste de l'agent de Meta est-il pour nous (`src/webhooks/standby-hors-liste.ts`) ?
 * Meta range en `standby` tout message d'un fil qu'il croit tenu par son agent (après un modèle, après un `release`),
 * mais son agent ne parle qu'aux contacts de sa liste : pour un absent, personne chez Meta ne répond.
 *
 * Dans les quatre modes, c'est nous qui devons la réponse : l'agent de Meta répondeur ne parle qu'à sa liste, un agent
 * IA ou un scénario de la console répond, et l'équipe doit voir le message dans « À traiter ». Avant RC6, un espace
 * sans répondeur ne requalifiait rien (un `standby` y voulait dire « une autre application tient le fil ») : ces
 * espaces sont en `equipe`, et un message laissé en `standby` y disparaissait, hors d'« À traiter ».
 * ⚠️ Le `switch` est là pour le mode à venir « mon application répond » : il devra dire si un `standby` est pour lui.
 */
export function standbyPourNous(mode: ModeRepondeur): boolean {
  switch (mode) {
    case 'mba':
    case 'agent':
    case 'scenario':
    case 'equipe':
      return true;
  }
}
