import type { TourBloque } from './session-store';
import { texteDe } from '../lib/erreur';

/**
 * Le balayage des tours d'agent morts en vol.
 *
 * `prendreLeTour` incrémente `tours` avant le travail (verrou optimiste atomique). Si le worker meurt entre
 * les deux, pg-boss rejoue le job avec l'ancien numéro, le rejeu est classé doublon, et la session reste
 * `en_cours` sur un run `waiting` sans échéance : plus rien ne réveille la conversation.
 *
 * On ne rejoue pas, on clôt : le worker a pu mourir après avoir envoyé le message (l'envoi n'a pas de clé
 * d'idempotence), et rejouer risquerait un doublon chez le contact. Clore emprunte au pire la branche d'échec
 * du scénario. Logique pure, toute l'IO par les deps.
 */

/**
 * Âge au-delà duquel un tour en vol est réputé mort. Un tour vivant est borné par l'échéance du cerveau
 * (30 s) plus ses outils : quinze minutes est un garde-fou d'anomalie.
 *
 * Doit rester au-dessus de `DUREE_MAX_AVANCE_MS` (lien tenu par `tests/agent-tour-bloque.test.ts`) : à
 * égalité, une avance qui va au bout de son temps rend sa ligne réclamable à l'instant où elle abandonne,
 * et `sortieAppliquee`, sans jeton de garde, pourrait effacer le bail du balayage qui l'a reprise. L'écart
 * rend cette course inatteignable.
 */
export const AGE_TOUR_MORT_S = 15 * 60;

/** Nombre de sessions traitées par passage. Volontairement petit : c'est un filet, pas un traitement de masse. */
export const LOT_TOURS_BLOQUES = 20;

export interface TourBloqueSweepDeps {
  /**
   * Réclame et clôt en une requête les sessions dont le tour est en vol depuis trop longtemps : séparées, un
   * second worker ferait sortir le parcours une seconde fois.
   *
   * La réclamation pose un bail, elle n'efface pas la marque : tant que la sortie n'est pas appliquée, la ligne
   * reste réclamable. Elle ramasse donc aussi les sessions closes dont la sortie est restée due.
   */
  reclamer(ageSecondes: number, limite: number): Promise<TourBloque[]>;
  /**
   * Fait sortir le parcours par la branche réellement due, `tour.sortie`, jamais un code en dur. Sans elle, la
   * session serait close mais le run resterait en attente sur le bloc.
   */
  sortir(tour: TourBloque): Promise<void>;
  /**
   * La sortie est appliquée : la marque tombe, et la ligne cesse d'être réclamable. Optionnelle : sans elle,
   * le balayage repasse sur la même session, sans dommage puisque la sortie est idempotente.
   */
  sortieAppliquee?(tour: TourBloque): Promise<void>;
  ageSecondes?: number;
  limite?: number;
  /** Journalisation. Absente -> silence, ce que veulent les tests. */
  log?(message: string): void;
}

/**
 * Un passage. Rend le nombre de parcours effectivement remis en route.
 *
 * L'échec d'une sortie n'arrête pas les autres (les sessions sont déjà closes en base) et laisse sa ligne
 * réclamable : la marque n'est effacée que par `sortieAppliquee`, donc le balayage suivant réessaie.
 */
export async function runTourBloqueSweep(deps: TourBloqueSweepDeps): Promise<number> {
  const tours = await deps.reclamer(deps.ageSecondes ?? AGE_TOUR_MORT_S, deps.limite ?? LOT_TOURS_BLOQUES);
  if (tours.length === 0) return 0;

  let sortis = 0;
  for (const tour of tours) {
    try {
      await deps.sortir(tour);
      // La marque tombe seulement ici : c'est ce qui distingue une sortie appliquée d'une sortie due.
      await deps.sortieAppliquee?.(tour);
      sortis += 1;
    } catch (err) {
      deps.log?.(
        `agent: sortie d'échec impossible pour la session ${tour.sessionId} (run ${tour.runId}) : ${texteDe(err)}`,
      );
    }
  }
  deps.log?.(`agent: ${tours.length} tour(s) mort(s) en vol, ${sortis} parcours remis en route`);
  return sortis;
}
