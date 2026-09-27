import { traceReponse, destinataireAgentEvent, evenementEnvoiEchoue, type EvenementAgent } from './evenement';

/**
 * Dire à l'agent de Meta qu'un envoi a échoué après sa réponse. Le relais répond « C'est parti » avant la fin de
 * l'envoi (Meta coupe un outil vers trois secondes), et un scénario reprend le fil avant ses autres refus : ces
 * refus tombent souvent après la réponse, et l'agent se tairait. `gestes-envoi.ts` a déjà rendu le fil ; cet
 * événement fait parler l'agent.
 * Seulement si le fil est vraiment à lui (`mba` chez nous) : un opérateur qui a pris la conversation, ou un envoi
 * partiel qui attend son accusé, laissent un autre détenteur, et l'agent parlerait par-dessus.
 */
export interface DepsSignalerEchec {
  inbox: { getControlOwner(tenantId: string, waId: string): Promise<string> };
  numeros: { getTenantPhoneNumberId(tenantId: string): Promise<string | null> };
  envoyer(tenantId: string, phoneNumberId: string, to: string, event: EvenementAgent): Promise<unknown>;
  journal?(ligne: string): void;
}

export function creerSignalerEchecTardif(deps: DepsSignalerEchec) {
  return async (tenantId: string, waId: string, raison: string): Promise<void> => {
    if ((await deps.inbox.getControlOwner(tenantId, waId)) !== 'mba') {
      deps.journal?.(`agent_event d'échec non envoyé pour ${waId} : le fil n’est pas à l’agent de Meta`);
      return;
    }
    const pn = await deps.numeros.getTenantPhoneNumberId(tenantId);
    if (!pn) return;
    const reponse = await deps.envoyer(tenantId, pn, destinataireAgentEvent(waId), evenementEnvoiEchoue(raison));
    deps.journal?.(`agent_event d'échec envoyé pour ${waId} : ${traceReponse(reponse)}`);
  };
}
