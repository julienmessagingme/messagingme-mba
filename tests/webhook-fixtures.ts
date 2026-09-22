import type { TarifsMetaSink } from '../src/webhooks/tarif-meta';
import type { ArriveesPubDeps } from '../src/webhooks/arrivees-pub';

/**
 * Les deux dépendances que `WebhookJobDeps` rend obligatoires (lot 1 des publicités Click-to-WhatsApp), pour
 * les tests qui ne parlent ni de coût ni de publicité. Elles DISENT l'hypothèse au lieu de la cacher, comme
 * `jamaisDesabonne` (`tests/consentement.ts`).
 */
export const aucunTarif: TarifsMetaSink = { enregistrer: async () => {} };
export const aucuneArriveePub: ArriveesPubDeps = { phoneNumberTenant: async () => null, enregistrer: async () => 'ecrite' };
