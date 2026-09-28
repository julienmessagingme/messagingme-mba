/**
 * Les verrous courts : une clé tenue jusqu'à une échéance, partagée par toutes les copies d'un processus (table
 * `verrous_courts`, migration 0185). Ce qui doit n'arriver qu'une fois pour tout le service, et pas une fois par
 * copie, se garde ici : un geste d'envoi de l'agent de Meta (`src/mba/anti-rejeu.ts`), une publication du relais
 * (`src/http/mba-publication.ts`).
 *
 * Trois règles, les mêmes pour l'adaptateur Postgres (`verrous-courts.pg.ts`) et pour le double des tests
 * (`tests/verrous.ts`) :
 * - une prise prend TOUTES ses clés ou AUCUNE : deux clés prises à moitié garderaient un geste qui n'est pas parti ;
 * - une clé échue se reprend : l'échéance est le bail, sans elle une copie tuée garderait la clé pour toujours ;
 * - on ne relâche que ce que sa prise tient encore (jeton de garde) : sans lui, le porteur d'une prise échue
 *   effacerait celle de la copie qui l'a reprise.
 */

/** Une clé demandée, et combien de temps la tenir (millisecondes). */
export type CleDemandee = readonly [cle: string, dureeMs: number];

/** Ce qu'une prise tient : son jeton de garde et ses clés. Seule elle peut les relâcher. */
export interface Prise {
  readonly jeton: string;
  readonly cles: readonly string[];
}

export interface VerrousCourts {
  /**
   * Prend toutes ces clés, ou aucune. Rend la prise, ou `null` quand l'une est tenue par une prise dont l'échéance
   * court. Atomique : de deux prises simultanées d'une même clé, une seule réussit.
   */
  prendre(cles: ReadonlyArray<CleDemandee>): Promise<Prise | null>;
  /** Relâche les clés de cette prise qui portent encore son jeton ; sans effet sur une clé reprise après échéance. */
  relacher(prise: Prise): Promise<void>;
  /**
   * Repousse l'échéance des clés de cette prise à `dureeMs` d'ici, tant qu'elles portent encore son jeton. Rend
   * `false` dès qu'une clé ne le porte plus (reprise par une autre copie après échéance, ou effacée par la purge) :
   * le travail que la prise gardait n'est alors plus seul, et il doit s'arrêter. Une clé échue que personne n'a
   * reprise se prolonge : son jeton prouve que personne d'autre ne l'a tenue entre-temps.
   */
  prolonger(prise: Prise, dureeMs: number): Promise<boolean>;
}

/**
 * Les clés telles qu'une prise les écrit : sans doublon (la plus longue durée gagne), triées. Le tri n'est pas
 * cosmétique : deux prises qui écrivent les mêmes clés dans des ordres différents s'interbloqueraient en base.
 * Une liste vide ou une durée qui n'est pas un nombre positif est une faute d'appel, jamais une prise.
 */
export function normaliserCles(demandees: ReadonlyArray<CleDemandee>): Array<[string, number]> {
  if (demandees.length === 0) throw new Error('verrous courts : aucune clé demandée');
  const parCle = new Map<string, number>();
  for (const [cle, duree] of demandees) {
    if (cle === '' || !Number.isFinite(duree) || duree <= 0) throw new Error(`verrous courts : clé ou durée invalide (${cle})`);
    parCle.set(cle, Math.max(duree, parCle.get(cle) ?? 0));
  }
  return [...parCle.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
