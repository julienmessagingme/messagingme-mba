/**
 * QUI RÉPOND AU CLIENT (RC6, plan `docs/superpowers/plans/2026-10-06-rc6-qui-repond.md`) : le réglage unique de
 * l'Accueil qui décide qui répond à un nouveau contact, ou à un message que personne ne tient.
 *
 *  - `mba` : l'agent de Meta. Il est alors le RÉPONDEUR, et lui seul reçoit les contacts que personne ne tient.
 *  - `agent` : un agent IA de la console (`tenant_settings.repondeur_agent_id`).
 *  - `scenario` : un scénario publié (`tenant_settings.repondeur_workflow_id`), relancé au plus une fois par délai pour
 *    un même contact (`repondeur_delai_scenario_s`) ; entre-temps, l'équipe.
 *  - `equipe` : personne ne répond automatiquement, la conversation entre dans « À traiter ».
 *  - `application` (lot 12, livraison B) : l'application du client, par l'événement `conversation.needs_reply` envoyé à
 *    une adresse désignée de webhooks sortants (`tenant_settings.repondeur_adresse_id`) ; elle répond par l'API. Aucun
 *    repli (décision de Julien du 2026-10-08) : sans réponse, rien ne se passe, et l'échec se lit au journal.
 *
 * 🔴 ALLUMÉ N'EST PLUS RÉPONDEUR. L'agent de Meta allumé (`mba_enabled`) est DISPONIBLE : hors du mode `mba`, il est en
 * veille, et ni une remise, ni une fin de parcours, ni le balayage ne lui confie rien. Il ne prend un contact que par
 * le bloc « Envoyer au MBA » d'un scénario. La contrainte « une seule voix » de 0209 est levée (0217).
 *
 * 🔴 LA LISTE DES MODES EST LA SEULE DU DÉPÔT, dans `web/lib/partage/repondeur-modes.ts` (partagée avec la console), miroir
 * du CHECK `tenant_settings_repondeur_mode_chk` (reposé par 0224, tenu par `tests/migration-0224.test.ts`). Un mode
 * ajouté s'ajoute LÀ et dans le CHECK, et chaque `switch` sur le mode refuse de
 * compiler tant qu'il n'a pas sa branche (`modeEffectif`, `standbyPourNous`, la remise de `src/inbox/fil.ts`).
 */
import type { Fonction } from '../offres/offres';
import { modeEffectif, type ModeRepondeur, type ReglageDuRepondeur } from '../../web/lib/partage/repondeur-modes';
// Partagés avec la console (`web/lib/partage/repondeur-modes.ts`) : les modes, les bornes du délai, le mode effectif.
export {
  MODES_REPONDEUR, estModeRepondeur, modeEffectif,
  DELAI_SCENARIO_DEFAUT_S, DELAI_SCENARIO_MIN_S, DELAI_SCENARIO_MAX_S,
  DELAI_SCENARIO_HEURES_DEFAUT, DELAI_SCENARIO_HEURES_MIN, DELAI_SCENARIO_HEURES_MAX,
  type ModeRepondeur, type ReglageDuRepondeur,
} from '../../web/lib/partage/repondeur-modes';
/**
 * 🔴 LES RÉGLAGES TELS QUE L'OFFRE LES LAISSE JOUER (lot 6, livraison B2a, spec § 7, décision de Julien du 2026-10-07) :
 * le gel au retour en Base. Sans `agent_meta`, l'agent de Meta se lit éteint (il ne reçoit plus aucun contact neuf, et le
 * mode « MBA » se lit « Équipe ») ; sans `scenarios`, le scénario répondeur se lit absent (le mode « Scénario » se lit
 * « Équipe »). Rien n'est écrit : les réglages de l'espace restent tels quels, et tout revient au réabonnement.
 * Le seul calcul du dépôt : chaque endroit qui confie un contact (le contrôle du fil, la fin d'un parcours, le balayage des
 * fils) lit `modeEffectif` ou `leMbaRepond` sur CE résultat, ce qui évite une seconde règle à tenir alignée.
 */
export function sousLOffre<T extends ReglageDuRepondeur>(r: T, fonctions: ReadonlySet<Fonction>): T {
  return {
    ...r,
    mbaEnabled: r.mbaEnabled && fonctions.has('agent_meta'),
    repondeurWorkflowId: fonctions.has('scenarios') ? r.repondeurWorkflowId : null,
  };
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
 * Le mode `application` aussi : l'application du client répond par l'API, et elle doit recevoir le message.
 */
export function standbyPourNous(mode: ModeRepondeur): boolean {
  switch (mode) {
    case 'mba':
    case 'agent':
    case 'scenario':
    case 'equipe':
    case 'application':
      return true;
  }
}
