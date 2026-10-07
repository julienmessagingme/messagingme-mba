import type { TarifsMetaSink } from '../src/webhooks/tarif-meta';
import type { EchecsLibresSink } from '../src/webhooks/delivery';
import type { ArriveesPubDeps } from '../src/webhooks/arrivees-pub';
import type { RoutagePubDeps } from '../src/webhooks/routage-pub';
import type { SignalAccuse } from '../src/webhooks/delivery';
import type { DetenteurDuFil, SignalReponse } from '../src/webhooks/inbound';
import type { NumerosDelies } from '../src/webhooks/numeros-delies';
import type { ListeALArrivee } from '../src/webhooks/standby-hors-liste';
import { extractInbound } from '../src/webhooks/inbound';
import { rattacherLesEntrants, type EntrantRattache, type EspaceDuNumero } from '../src/webhooks/rattachement';

/**
 * Les dépendances que `WebhookJobDeps` rend obligatoires (lot 1 des publicités Click-to-WhatsApp, puis le
 * lot 3), pour les tests qui ne parlent ni de coût ni de publicité. Elles DISENT l'hypothèse au lieu de la
 * cacher, comme `jamaisDesabonne` (`tests/consentement.ts`).
 */
export const aucunTarif: TarifsMetaSink = { enregistrer: async () => {} };

/** Aucun journal des échecs de messages libres (lot 3 de l'API publique) : le puits est inerte et le DIT. */
export const aucunEchecLibre: EchecsLibresSink = { noter: async () => null };

/** Aucun signal remonté : le test ne porte pas sur les signaux, et le DIT (lot 6 de l'API publique). */
export const aucunSignalAccuse: SignalAccuse = async () => {};
export const aucunSignalReponse: SignalReponse = async () => {};
export const aucuneArriveePub: ArriveesPubDeps = { enregistrer: async () => 'ecrite' };
/**
 * L'agent de Meta est éteint pour tous les espaces : aucun `standby` n'est réécrit à l'arrivée, chacun reste un
 * `standby` que le reste du code ignore (le comportement d'avant le mode liste). Les tests qui ne parlent pas de la
 * liste de l'agent le disent en la passant ; un test qui la VÉRIFIE câble la vraie liste
 * (`bancDuFil(...).liste`, `tests/banc-du-fil.ts`).
 */
export const agentEteintALArrivee: ListeALArrivee = {
  standbyPourNous: async () => false,
  presents: () => { throw new Error('agentEteintALArrivee : la liste ne se lit pas quand l’agent est éteint'); },
};

/** Aucun numéro délié (migration 0180) : le test ne porte pas sur le geste de l'Accueil, et le DIT. */
export const aucunNumeroDelie: NumerosDelies = async () => new Set();

/**
 * Aucune correction du détenteur du fil : le test ne porte pas sur le `field` d'un entrant, et le DIT. Requise
 * avec `inbox` depuis la relecture du lot 4 ; un test qui VÉRIFIE la correction câble le vrai geste
 * (`bancDuFil(...).fil`, `tests/banc-du-fil.ts`).
 */
export const aucuneCorrectionDuDetenteur: DetenteurDuFil = { entrantEnStandby: async () => {} };

/**
 * Aucun routage publicitaire : les payloads des tests qui le passent ne portent aucun `referral`, donc aucune
 * dépendance n'est jamais appelée.
 *
 * ⚠️ ELLES LÈVENT PLUTÔT QUE DE RENDRE UNE VALEUR INERTE, et c'est la différence entre un faux qui DIT
 * son hypothèse et un faux qui la cache. Un test qui finirait par les atteindre a changé de sujet sans le
 * savoir. ⚠️ Le routage rattrape ses erreurs message par message : l'atteindre avec un `referral` ne produit
 * qu'une ligne d'erreur au journal, pas un test rouge. Un test qui passe un `referral` affirme lui-même ce qu'il attend.
 */
export const aucunRoutagePub: RoutagePubDeps = {
  campagneConnue: () => { throw new Error('aucunRoutagePub : campagneConnue ne devrait pas être appelée'); },
  resoudreChezMeta: () => { throw new Error('aucunRoutagePub : resoudreChezMeta ne devrait pas être appelée'); },
  publiciteDeLaCampagne: () => { throw new Error('aucunRoutagePub : publiciteDeLaCampagne ne devrait pas être appelée'); },
  contactBloque: () => { throw new Error('aucunRoutagePub : contactBloque ne devrait pas être appelée'); },
  estDesabonne: () => { throw new Error('aucunRoutagePub : estDesabonne ne devrait pas être appelée'); },
  offres: { offreDe: () => { throw new Error('aucunRoutagePub : offres.offreDe ne devrait pas être appelée'); } },
  reprendreLeFil: () => { throw new Error('aucunRoutagePub : reprendreLeFil ne devrait pas être appelée'); },
  rendreLeFil: () => { throw new Error('aucunRoutagePub : rendreLeFil ne devrait pas être appelée'); },
  noterIssue: () => { throw new Error('aucunRoutagePub : noterIssue ne devrait pas être appelée'); },
};

/**
 * Les entrants d'un payload rattachés comme le fait `handleWebhookJob`, pour appeler une étape seule. `espace` :
 * l'espace de tous les numéros, ou la lecture à faire par numéro.
 */
export function entrantsDe(payload: unknown, espace: string | null | EspaceDuNumero = 't1'): Promise<EntrantRattache[]> {
  return rattacherLesEntrants(extractInbound(payload), typeof espace === 'function' ? espace : async () => espace);
}
