import type { ControlOwner } from './store.pg';

/**
 * LE DÉLAI DE REPRISE D'UN FIL TENU, une seule règle pour ses deux lecteurs : le balayage (`./control-sweep.ts`), qui
 * rend les fils que plus personne ne traite, et la remise « personne ne suit » (`ControleDuFil.remettreSiPersonneNeSuit`,
 * `./fil.ts`), qui confie à l'agent de Meta le message d'un client écrivant dans un fil que l'équipe ne tient plus.
 * Deux copies dériveraient : l'une rendrait un fil que l'autre croirait encore tenu.
 *
 * Ce que la règle ne porte pas, délibérément : la fenêtre de service de Meta. Le balayage saute un fil dont la
 * fenêtre est fermée (l'agent ne prendrait rien) ; la remise, elle, part d'un message du client, qui vient de
 * l'ouvrir.
 */

/**
 * Le délai de l'équipe d'un espace, en millisecondes : son réglage (`tenant_settings.control_handback_seconds`, en
 * secondes), sinon le défaut du serveur (`CONTROL_HUMAN_TIMEOUT_MS`). 0 = la main ne revient jamais toute seule.
 */
export function delaiHumainMs(reglageSecondes: number | null, defautMs: number): number {
  return reglageSecondes === null ? defautMs : reglageSecondes * 1000;
}

/**
 * Le délai de ce fil est-il écoulé ? Jamais pour une escalade que personne n'a encore répondue (le client attend un
 * humain), ni pour un délai absent ou nul (l'espace garde la main). `depuisMs` : le temps écoulé depuis
 * `control_changed_at`, que la dernière réponse de l'équipe et son « Traité » remettent à maintenant ; `null` =
 * bascule ancienne, non datée, donc éligible (sinon bloquée pour toujours).
 */
export function repriseDue(
  fil: { owner: ControlOwner; depuisMs: number | null; escaladee: boolean },
  delaiMs: number | undefined,
): boolean {
  if (fil.owner === 'app_human' && fil.escaladee) return false;
  if (delaiMs === undefined || delaiMs <= 0) return false;
  return fil.depuisMs === null || fil.depuisMs >= delaiMs;
}
