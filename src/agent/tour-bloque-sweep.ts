import type { TourBloque } from './session-store';

/**
 * LE BALAYAGE DES TOURS D'AGENT MORTS EN VOL (constat A1 de l'audit externe du 2026-09-02).
 *
 * 🔴 CE QU'IL FERME. `prendreLeTour` incrémente `tours` AVANT le travail, parce que c'est ce qui rend le
 * verrou optimiste atomique. Si le worker meurt entre les deux, pg-boss rejoue le job avec l'ANCIEN numéro de
 * tour, la réservation rend `null`, le rejeu est classé « doublon » et sort sans rien faire. Le tour est alors
 * perdu POUR TOUJOURS : la session reste `en_cours`, le run reste `waiting` sur le bloc agent SANS échéance
 * (l'échéance d'inactivité est posée à la FIN du tour, qui n'est jamais arrivée), et plus rien au monde ne
 * réveille cette conversation. Le contact n'a jamais de réponse.
 *
 * 🔴 ON NE REJOUE PAS, ON CLÔT. Le choix est tranché et il est le prudent : le worker a pu mourir APRÈS avoir
 * envoyé le message au contact, et rien en base ne permet de le savoir (l'envoi n'a pas de clé d'idempotence).
 * Rejouer risquerait un doublon chez le contact ; clore fait au pire emprunter la branche d'échec du scénario,
 * qui existe précisément pour ce cas et que le client a rédigée. Un rejeu correct viendrait plus tard, et
 * exigerait d'abord de rendre les effets d'un tour idempotents.
 *
 * Logique PURE, toute l'IO par les deps, comme `workflow/wake-sweep.ts` : testable sans base.
 */

/**
 * Âge au-delà duquel un tour en vol est réputé mort.
 *
 * Un tour légitime est borné par l'échéance du cerveau (30 s) plus ses appels d'outils, dont chacun porte son
 * propre plafond. Dix minutes ne sont donc jamais atteintes par un tour vivant, et laissent la marge qu'il
 * faut à une base lente ou à un connecteur qui traîne. Même ordre de grandeur que la durée maximale d'une
 * avance de scénario, pour la même raison : c'est un garde-fou d'anomalie, pas une limite de fonctionnement.
 */
export const AGE_TOUR_MORT_S = 10 * 60;

/** Nombre de sessions traitées par passage. Volontairement petit : c'est un filet, pas un traitement de masse. */
export const LOT_TOURS_BLOQUES = 20;

export interface TourBloqueSweepDeps {
  /**
   * RÉCLAME et clôt en UNE requête les sessions dont le tour est en vol depuis trop longtemps.
   *
   * La réclamation et la clôture ne se séparent pas : entre les deux, un second worker verrait la même
   * session et ferait sortir le parcours une seconde fois par sa branche d'échec.
   */
  reclamer(ageSecondes: number, limite: number): Promise<TourBloque[]>;
  /**
   * Fait SORTIR le parcours par la branche d'échec du bloc agent. Sans elle, la session serait close mais le
   * run resterait en attente sur le bloc : on aurait rangé la table sans rien rendre au contact.
   */
  sortir(tour: TourBloque): Promise<void>;
  ageSecondes?: number;
  limite?: number;
  /** Journalisation. Absente -> silence, ce que veulent les tests. */
  log?(message: string): void;
}

/**
 * Un passage. Rend le nombre de parcours effectivement remis en route.
 *
 * ⚠️ L'échec d'UNE sortie n'arrête pas les autres : les sessions sont déjà closes en base à ce stade, donc
 * s'arrêter au premier échec laisserait les suivantes closes ET bloquées, ce qui est pire que l'état de
 * départ. Chaque échec est journalisé, et le parcours concerné reste récupérable à la main.
 */
export async function runTourBloqueSweep(deps: TourBloqueSweepDeps): Promise<number> {
  const tours = await deps.reclamer(deps.ageSecondes ?? AGE_TOUR_MORT_S, deps.limite ?? LOT_TOURS_BLOQUES);
  if (tours.length === 0) return 0;

  let sortis = 0;
  for (const tour of tours) {
    try {
      await deps.sortir(tour);
      sortis += 1;
    } catch (err) {
      deps.log?.(
        `agent: sortie d'échec impossible pour la session ${tour.sessionId} (run ${tour.runId}) : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  deps.log?.(`agent: ${tours.length} tour(s) mort(s) en vol, ${sortis} parcours remis en route`);
  return sortis;
}
