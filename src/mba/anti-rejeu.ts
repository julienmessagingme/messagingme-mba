import type { CleDemandee } from '../db/verrous-courts';

/**
 * Un geste qui envoie ne se rejoue pas pour le même client, le temps d'une demande : l'agent de Meta peut appeler le
 * même outil plusieurs fois dans un tour, et le client recevrait chaque fois le premier message.
 * Les clés vivent dans les verrous courts, partagés par toutes les copies de l'API (`src/db/verrous-courts.ts`) : un
 * rappel qui tombe sur une autre copie que le premier appel est refusé comme s'il tombait sur la même.
 */

/** Deux minutes : bien plus qu'un tour de l'agent de Meta (quelques secondes), bien moins qu'une vraie redemande. */
export const DUREE_ANTI_REJEU_MS = 2 * 60_000;

/**
 * Le plancher : un même outil, pour un même client, ne repart pas avant 30 s, quel que soit son dernier message.
 * La clé par message ne suffit pas : une réaction ou une demande coupée en deux change le dernier message, et un
 * rappel de l'agent relancerait le scénario. Au-delà, c'est le message qui départage. Doit rester au-dessus de
 * l'attente de fin de tour et sous le délai d'une vraie redemande (un test tient les deux bornes).
 */
export const PLANCHER_ANTI_REJEU_MS = 30_000;

/**
 * Les deux clés d'un geste d'envoi, à prendre d'un seul geste (toutes ou aucune) : le plancher (client et outil) et
 * la demande (client, outil et dernier message du client, `-` quand il n'y en a pas). Le préfixe les sépare des
 * autres usages des verrous courts.
 */
export function clesAntiRejeu(tenantId: string, waId: string, outilId: string, dernierMessage: string | null): CleDemandee[] {
  const plancher = `mba-envoi:${tenantId}:${waId}:${outilId}`;
  return [[plancher, PLANCHER_ANTI_REJEU_MS], [`${plancher}:${dernierMessage ?? '-'}`, DUREE_ANTI_REJEU_MS]];
}
