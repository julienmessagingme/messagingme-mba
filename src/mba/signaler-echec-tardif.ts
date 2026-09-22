import { traceReponse, destinataireAgentEvent, evenementEnvoiEchoue, type EvenementAgent } from './evenement';

/**
 * DIRE À L'AGENT DE META QU'UN ENVOI A ÉCHOUÉ APRÈS SA RÉPONSE (revue du 2026-09-22).
 *
 * Le relais répond « C'est parti » au bout de `DELAI_REPONSE_ENVOI_MS`, parce que Meta coupe un outil vers trois
 * secondes. Un scénario, lui, reprend le fil AVANT ses autres refus (`runFrom`) : Meta qui refuse de rendre le fil,
 * contact désabonné, envoi refusé, panne. Ces refus tombent donc souvent APRÈS la réponse, et l'agent, qui a lu
 * « n'écris rien de plus », se taisait : le client restait sans réponse. `gestes-envoi.ts` a déjà rendu le fil ; cet
 * événement fait parler l'agent.
 *
 * 🔴 SEULEMENT SI LE FIL EST VRAIMENT À LUI (`mba` chez nous), même garde que la réponse « à côté »
 * (`transmettre-hors-parcours.ts`) : un opérateur qui a pris la conversation entre-temps, ou un envoi PARTIEL qui
 * attend son accusé (0149), laissent un autre détenteur, et l'événement ferait parler l'agent par-dessus.
 */
export interface DepsSignalerEchec {
  detenteur(tenantId: string, waId: string): Promise<string>;
  numero(tenantId: string): Promise<string | null>;
  envoyer(tenantId: string, phoneNumberId: string, to: string, event: EvenementAgent): Promise<unknown>;
  journal?(ligne: string): void;
}

export function creerSignalerEchecTardif(deps: DepsSignalerEchec) {
  return async (tenantId: string, waId: string, raison: string): Promise<void> => {
    if ((await deps.detenteur(tenantId, waId)) !== 'mba') {
      deps.journal?.(`agent_event d'échec non envoyé pour ${waId} : le fil n’est pas à l’agent de Meta`);
      return;
    }
    const pn = await deps.numero(tenantId);
    if (!pn) return;
    const reponse = await deps.envoyer(tenantId, pn, destinataireAgentEvent(waId), evenementEnvoiEchoue(raison));
    deps.journal?.(`agent_event d'échec envoyé pour ${waId} : ${traceReponse(reponse)}`);
  };
}
