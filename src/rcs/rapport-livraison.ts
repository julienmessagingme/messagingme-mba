import type { RcsDlr } from './callback';
import type { DeliveryStatus } from '../webhooks/delivery';
import type { EchecEcrit, EchecMessageLibre, EchecSansMessage } from '../delivery/echecs-messages.pg';
import { messageDe } from '../lib/erreur';

/**
 * Le rapport de livraison d'un RCS (rappel smsmode), dans cet ordre : le destinataire de campagne et la
 * mesure par bloc ; l'échec d'un message libre et la joignabilité du numéro pour cet agent ; les deux sorties
 * du bloc RCS d'un scénario.
 *
 * smsmode ne sait pas dire la joignabilité avant l'envoi (`canCheckReachability = false`) : ce rapport est la
 * seule source qui l'apprend au cache. Best-effort sur l'échec libre, la mesure et la joignabilité : une
 * exception rendrait 5xx à smsmode, qui rejouerait le rappel et réappliquerait la livraison.
 */

/**
 * Le journal des échecs vu du rapport smsmode. Deux méthodes, parce que le rapport peut devancer
 * l'inscription du message dans le fil : `noterSansMessage` écrit alors ce que le rapport sait.
 */
export interface EchecsRcsSink {
  noter(e: EchecMessageLibre): Promise<EchecEcrit | null>;
  noterSansMessage(e: EchecSansMessage): Promise<EchecEcrit | null>;
}

export interface DepsRapportRcs {
  majLivraison(messageId: string, status: DeliveryStatus, detail: string | null): Promise<number>;
  mesureBloc(messageId: string, status: 'delivered' | 'read' | 'failed'): Promise<unknown>;
  echecs: EchecsRcsSink;
  joignabilite: { put(agentId: string, e164: string, reachable: boolean, atMs: number): Promise<void> };
  rcsInjoignable(tenantId: string, to: string, messageId: string): Promise<unknown>;
  rcsDelivre(tenantId: string, to: string, messageId: string): Promise<unknown>;
  maintenant(): number;
}

export async function traiterRapportRcs(deps: DepsRapportRcs, tenantId: string, dlr: RcsDlr): Promise<void> {
  // 1. Le destinataire de campagne, par identifiant de message. Même chemin que les accusés Meta : une seule
  //    échelle de statuts dans le produit, donc un seul écran de résultats à lire.
  if (dlr.status !== null) {
    const touches = await deps.majLivraison(dlr.messageId, dlr.status, dlr.detail);
    // 1 bis. La mesure par bloc, best-effort : une mesure ne doit pas faire échouer le traitement du rapport.
    if (dlr.status !== 'sent') {
      try {
        await deps.mesureBloc(dlr.messageId, dlr.status);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('mesure de bloc RCS (statut) ignorée:', messageDe(err));
      }
    }
    // 1 ter. L'échec d'un message libre, seulement s'il n'a touché aucun destinataire de campagne. L'espace est
    //        connu ici (le code de l'URL), donc il filtre.
    if (dlr.echecDefinitif && touches === 0) {
      try {
        const ecrit = await deps.echecs.noter({ messageId: dlr.messageId, code: null, motif: dlr.detail, tenantId });
        // Le rapport peut devancer l'inscription du message (l'API et l'Inbox l'inscrivent après l'envoi) : sans ce
        // repli, le premier RCS vers un numéro sans RCS échouerait en silence.
        if (ecrit === null && dlr.to !== '') {
          await deps.echecs.noterSansMessage({ messageId: dlr.messageId, tenantId, waId: dlr.to, canal: 'rcs', code: null, motif: dlr.detail });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('échec de RCS libre non journalisé:', messageDe(err));
      }
    }
  }
  // 1 quater. La joignabilité, pour l'agent qui a envoyé (`channelId`, déjà vérifié par la route de rappel)
  //           et en E.164, la clé du cache.
  if (dlr.to !== '' && dlr.channelId !== null) {
    const joignable = dlr.echecDefinitif ? false : dlr.status === 'delivered' ? true : null;
    if (joignable !== null) {
      try {
        await deps.joignabilite.put(dlr.channelId, `+${dlr.to}`, joignable, deps.maintenant());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('joignabilité RCS non enregistrée:', messageDe(err));
      }
    }
  }
  // 2. Les deux sorties du bloc RCS s'allument ici et nulle part ailleurs : chez smsmode le sort d'un message
  //    se constate après, sur un rapport. Échec définitif : repli WhatsApp. Remis : la suite du parcours (sauf
  //    si le bloc attend encore un clic).
  if (dlr.to !== '') {
    if (dlr.echecDefinitif) await deps.rcsInjoignable(tenantId, dlr.to, dlr.messageId);
    else if (dlr.status === 'delivered') await deps.rcsDelivre(tenantId, dlr.to, dlr.messageId);
  }
}
