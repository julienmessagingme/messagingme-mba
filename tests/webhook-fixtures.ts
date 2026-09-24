import type { TarifsMetaSink } from '../src/webhooks/tarif-meta';
import type { EchecsLibresSink } from '../src/webhooks/delivery';
import type { ArriveesPubDeps } from '../src/webhooks/arrivees-pub';
import type { RoutagePubDeps } from '../src/webhooks/routage-pub';

/**
 * Les dépendances que `WebhookJobDeps` rend obligatoires (lot 1 des publicités Click-to-WhatsApp, puis le
 * lot 3), pour les tests qui ne parlent ni de coût ni de publicité. Elles DISENT l'hypothèse au lieu de la
 * cacher, comme `jamaisDesabonne` (`tests/consentement.ts`).
 */
export const aucunTarif: TarifsMetaSink = { enregistrer: async () => {} };

/** Aucun journal des échecs de messages libres (lot 3 de l'API publique) : le puits est inerte et le DIT. */
export const aucunEchecLibre: EchecsLibresSink = { noter: async () => null };
export const aucuneArriveePub: ArriveesPubDeps = { phoneNumberTenant: async () => null, enregistrer: async () => 'ecrite' };

/**
 * Aucun routage publicitaire : `phoneNumberTenant` rend `null`, donc la boucle s'arrête au premier message
 * et aucune autre dépendance n'est jamais appelée.
 *
 * ⚠️ LES AUTRES LÈVENT PLUTÔT QUE DE RENDRE UNE VALEUR INERTE, et c'est la différence entre un faux qui DIT
 * son hypothèse et un faux qui la cache. Un test qui finirait par les atteindre a changé de sujet sans le
 * savoir : mieux vaut qu'il le dise bruyamment que de router sur des faits inventés ici.
 */
export const aucunRoutagePub: RoutagePubDeps = {
  phoneNumberTenant: async () => null,
  campagneConnue: () => { throw new Error('aucunRoutagePub : campagneConnue ne devrait pas être appelée'); },
  resoudreChezMeta: () => { throw new Error('aucunRoutagePub : resoudreChezMeta ne devrait pas être appelée'); },
  publiciteDeLaCampagne: () => { throw new Error('aucunRoutagePub : publiciteDeLaCampagne ne devrait pas être appelée'); },
  contactBloque: () => { throw new Error('aucunRoutagePub : contactBloque ne devrait pas être appelée'); },
  estDesabonne: () => { throw new Error('aucunRoutagePub : estDesabonne ne devrait pas être appelée'); },
  reprendreLeFil: () => { throw new Error('aucunRoutagePub : reprendreLeFil ne devrait pas être appelée'); },
  rendreLeFil: () => { throw new Error('aucunRoutagePub : rendreLeFil ne devrait pas être appelée'); },
  noterIssue: () => { throw new Error('aucunRoutagePub : noterIssue ne devrait pas être appelée'); },
};
