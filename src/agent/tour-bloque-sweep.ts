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
 * Âge au-delà duquel un tour en vol est réputé mort. **QUINZE minutes, et la valeur est CONTRAINTE.**
 *
 * Un tour légitime est borné par l'échéance du cerveau (30 s) plus ses appels d'outils, dont chacun porte son
 * propre plafond. Un quart d'heure n'est donc jamais atteint par un tour vivant, et laisse la marge qu'il
 * faut à une base lente ou à un connecteur qui traîne : c'est un garde-fou d'anomalie, pas une limite de
 * fonctionnement.
 *
 * 🔴 IL DOIT DÉPASSER `DUREE_MAX_AVANCE_MS`, ET IL VALAIT EXACTEMENT SA VALEUR (corrigé le 2026-09-03). Les
 * deux faisaient dix minutes, ce qui se lisait comme une coïncidence et était en fait une COURSE : une avance
 * qui va au bout de son temps rend sa ligne réclamable à l'instant précis où elle abandonne, donc un deuxième
 * porteur démarre pendant que le premier finit. **Deux constantes qui doivent être ordonnées se règlent par
 * une valeur, pas par une architecture.** Le lien est tenu par `tests/agent-tour-bloque.test.ts`, parce qu'il
 * n'est visible dans aucun des deux fichiers pris séparément.
 *
 * Ce que l'écart ferme aussi, et c'est la vraie raison : `sortieAppliquee` n'a PAS de jeton de garde, elle
 * efface la marque quelle que soit sa valeur. Un porteur en retard pouvait donc effacer le BAIL du balayage
 * qui venait de reprendre sa session, et si la sortie du balayage échouait ensuite, la ligne n'était plus
 * réclamable par personne. C'est la troisième pièce de verrou que le CLAUDE.md exige, absente ici. Un jeton
 * coûterait de faire remonter l'instant de marque à travers `clore` puis `cloreEtSortir`, donc deux
 * signatures ; l'écart entre les deux constantes rend la course INATTEIGNABLE pour rien. Le prix est cinq
 * minutes de plus avant qu'un tour vraiment mort ne soit ramassé, ce qui ne coûte à personne.
 */
export const AGE_TOUR_MORT_S = 15 * 60;

/** Nombre de sessions traitées par passage. Volontairement petit : c'est un filet, pas un traitement de masse. */
export const LOT_TOURS_BLOQUES = 20;

export interface TourBloqueSweepDeps {
  /**
   * RÉCLAME et clôt en UNE requête les sessions dont le tour est en vol depuis trop longtemps.
   *
   * La réclamation et la clôture ne se séparent pas : entre les deux, un second worker verrait la même
   * session et ferait sortir le parcours une seconde fois par la branche que porte sa ligne.
   *
   * ⚠️ La réclamation POSE UN BAIL, elle n'efface pas la marque (contre-audit du 2026-09-03) : tant que la
   * sortie n'a pas été appliquée, la ligne doit rester réclamable par le passage suivant. Elle ramasse donc
   * aussi les sessions déjà closes dont la sortie est restée due, celles qu'un `runTurn` interrompu entre sa
   * clôture et sa sortie a laissées derrière lui.
   */
  reclamer(ageSecondes: number, limite: number): Promise<TourBloque[]>;
  /**
   * Fait SORTIR le parcours par la branche RÉELLEMENT DUE, celle que porte `tour.sortie`. Sans elle, la
   * session serait close mais le run resterait en attente sur le bloc : on aurait rangé la table sans rien
   * rendre au contact.
   *
   * ⚠️ L'implémentation DOIT utiliser `tour.sortie`, jamais un code en dur. Ce JSDoc a dit « la branche
   * d'échec » pendant une journée, alors que la ligne juste en dessous disait l'inverse : un lecteur qui
   * l'aurait cru pouvait recâbler `SORTIE_ECHEC` et réintroduire le défaut de la veille. Un commentaire qui
   * contredit sa propre note est plus dangereux qu'un commentaire absent.
   */
  sortir(tour: TourBloque): Promise<void>;
  /**
   * La sortie est appliquée : la marque tombe, et la ligne cesse d'être réclamable.
   *
   * OPTIONNELLE, comme partout ailleurs sur ce marqueur : un câblage de test qui ne la fournit pas garde le
   * comportement d'avant, à ceci près qu'il fera repasser le balayage sur la même session. Sans dommage, la
   * sortie étant idempotente.
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
 * ⚠️ L'échec d'UNE sortie n'arrête pas les autres : les sessions sont déjà closes en base à ce stade, donc
 * s'arrêter au premier échec laisserait les suivantes closes ET bloquées, ce qui est pire que l'état de
 * départ. Chaque échec est journalisé.
 *
 * 🔴 ET IL EST DÉSORMAIS RATTRAPÉ TOUT SEUL (contre-audit du 2026-09-03). Ce commentaire disait « récupérable
 * à la main », ce qui était l'aveu du défaut : une sortie qui échouait condamnait le parcours, la réclamation
 * ayant effacé la marque qui l'aurait désigné au passage suivant. La marque n'est plus effacée que par
 * `sortieAppliquee`, une fois la sortie réellement passée : un échec laisse donc la ligne réclamable, et le
 * balayage suivant réessaie. La sortie étant idempotente, réessayer ne coûte rien au contact.
 */
export async function runTourBloqueSweep(deps: TourBloqueSweepDeps): Promise<number> {
  const tours = await deps.reclamer(deps.ageSecondes ?? AGE_TOUR_MORT_S, deps.limite ?? LOT_TOURS_BLOQUES);
  if (tours.length === 0) return 0;

  let sortis = 0;
  for (const tour of tours) {
    try {
      await deps.sortir(tour);
      // La marque tombe SEULEMENT ici : c'est ce qui distingue une sortie appliquée d'une sortie due.
      await deps.sortieAppliquee?.(tour);
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
