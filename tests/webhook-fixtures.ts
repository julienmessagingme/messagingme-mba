import type { TarifsMetaSink } from '../src/webhooks/tarif-meta';
import type { EchecsLibresSink } from '../src/webhooks/delivery';
import type { ArriveesPubDeps } from '../src/webhooks/arrivees-pub';
import type { RoutagePubDeps } from '../src/webhooks/routage-pub';
import type { SignalAccuse } from '../src/webhooks/delivery';
import type { SignalReponse } from '../src/webhooks/inbound';
import type { NumerosDelies } from '../src/webhooks/numeros-delies';
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

/** Aucun numéro délié (migration 0180) : le test ne porte pas sur le geste de l'Accueil, et le DIT. */
export const aucunNumeroDelie: NumerosDelies = async () => new Set();

/**
 * Aucun routage publicitaire : les payloads des tests qui le passent ne portent aucun `referral`, donc aucune
 * dépendance n'est jamais appelée.
 *
 * ⚠️ ELLES LÈVENT PLUTÔT QUE DE RENDRE UNE VALEUR INERTE, et c'est la différence entre un faux qui DIT
 * son hypothèse et un faux qui la cache. Un test qui finirait par les atteindre a changé de sujet sans le
 * savoir : mieux vaut qu'il le dise bruyamment que de router sur des faits inventés ici.
 */
export const aucunRoutagePub: RoutagePubDeps = {
  campagneConnue: () => { throw new Error('aucunRoutagePub : campagneConnue ne devrait pas être appelée'); },
  resoudreChezMeta: () => { throw new Error('aucunRoutagePub : resoudreChezMeta ne devrait pas être appelée'); },
  publiciteDeLaCampagne: () => { throw new Error('aucunRoutagePub : publiciteDeLaCampagne ne devrait pas être appelée'); },
  contactBloque: () => { throw new Error('aucunRoutagePub : contactBloque ne devrait pas être appelée'); },
  estDesabonne: () => { throw new Error('aucunRoutagePub : estDesabonne ne devrait pas être appelée'); },
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
