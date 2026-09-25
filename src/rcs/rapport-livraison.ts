import type { RcsDlr } from './callback';
import type { DeliveryStatus } from '../webhooks/delivery';
import type { EchecEcrit, EchecMessageLibre, EchecSansMessage } from '../delivery/echecs-messages.pg';
import { messageDe } from '../lib/erreur';

/**
 * LE RAPPORT DE LIVRAISON D'UN RCS (rappel smsmode), extrait de `onDlr` (`src/index.ts`) pour être testé.
 *
 * Trois choses dans cet ordre, les deux premières étant celles d'avant ce lot :
 *   1. le destinataire de campagne, par identifiant de message, et la mesure par bloc ;
 *   2. les DEUX sorties du bloc RCS d'un scénario ;
 *   et, depuis le lot 3 de l'API publique (spec 2026-09-24, § 5) :
 *   3. l'échec d'un message LIBRE, noté quand il n'a touché aucun destinataire de campagne ; et la
 *      joignabilité RCS du numéro pour CET agent, apprise sur tout rapport qui la dit.
 *
 * 🔴 SMSMODE NE SAIT PAS DIRE LA JOIGNABILITÉ AVANT L'ENVOI (`canCheckReachability = false`). Le rapport est
 * donc la SEULE source : sans lui, le cache ne l'apprenait jamais, et le second RCS libre vers un numéro non
 * RCS partait comme le premier.
 *
 * ⚠️ BEST-EFFORT sur tout ce que ce lot ajoute : une exception rendrait 5xx à smsmode, qui rejouerait le
 * rappel, donc réappliquerait la livraison pour un motif secondaire.
 * ⚠️ UNE LIVRAISON COÛTE UNE ÉCRITURE PAR CLÉ PRIMAIRE dans le cache : c'est ce qui fait qu'un numéro
 * redevenu joignable cesse d'être refusé. Un statut « envoyé » ou « lu » ne coûte rien.
 */

/**
 * Le journal des échecs vu du rapport smsmode (`PgEchecsMessagesStore`). Deux méthodes, parce que le rapport
 * peut DEVANCER l'inscription du message dans le fil : `noter` ne le trouve alors pas, et `noterSansMessage`
 * écrit quand même ce que le rapport sait.
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
    // 1 bis. La MESURE PAR BLOC (Analytics > Mes tableaux), best-effort comme côté Meta : smsmode remonte bien
    //        DELIVERED et READ, et l'envoi RCS écrit son identifiant dans workflow_node_events. Une mesure ne
    //        doit pas faire échouer le traitement d'un rapport de livraison.
    if (dlr.status !== 'sent') {
      try {
        await deps.mesureBloc(dlr.messageId, dlr.status);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('mesure de bloc RCS (statut) ignorée:', messageDe(err));
      }
    }
    // 1 ter. L'échec d'un message LIBRE (défaut 4) : seulement s'il n'a touché aucun destinataire de campagne.
    //        L'espace est CONNU ici (le code de l'URL), donc il filtre.
    if (dlr.echecDefinitif && touches === 0) {
      try {
        const ecrit = await deps.echecs.noter({ messageId: dlr.messageId, code: null, motif: dlr.detail, tenantId });
        // 🔴 LE RAPPORT PEUT DEVANCER L'INSCRIPTION DU MESSAGE : la route de l'API et l'Inbox l'inscrivent dans
        // le fil APRÈS l'envoi, et un UNDELIVERABLE de smsmode (numéro sans RCS) peut arriver entre les deux.
        // `noter` ne trouve alors rien ; sans ce repli, l'échec retombait dans le silence (défaut 4), et c'est
        // justement le premier RCS vers un numéro sans RCS, celui que l'essai réel du lot envoie.
        if (ecrit === null && dlr.to !== '') {
          await deps.echecs.noterSansMessage({ messageId: dlr.messageId, tenantId, waId: dlr.to, canal: 'rcs', code: null, motif: dlr.detail });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('échec de RCS libre non journalisé:', messageDe(err));
      }
    }
  }
  // 1 quater. La JOIGNABILITÉ, pour l'agent qui a envoyé (le `channelId`, déjà vérifié égal à l'agent de
  //           l'espace par la route de rappel) et en E.164, la clé du cache (`documentation.md` § 5).
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
  // 2. Les DEUX sorties du bloc RCS. C'est ICI, et nulle part ailleurs, qu'elles s'allument : chez smsmode le
  //    sort d'un message ne se sait pas avant l'envoi, il se constate APRÈS, sur un rapport. Échec définitif
  //    -> repli WhatsApp. Remis -> la suite du parcours (sauf si le bloc attend encore un clic).
  if (dlr.to !== '') {
    if (dlr.echecDefinitif) await deps.rcsInjoignable(tenantId, dlr.to, dlr.messageId);
    else if (dlr.status === 'delivered') await deps.rcsDelivre(tenantId, dlr.to, dlr.messageId);
  }
}
