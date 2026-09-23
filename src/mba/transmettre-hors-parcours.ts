import { traceReponse, destinataireAgentEvent, evenementHorsParcours, type EvenementAgent } from './evenement';

/**
 * LA RÉPONSE « À CÔTÉ » PART CHEZ L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 5), une fois le fil rendu.
 *
 * 🔴 LE MESSAGE TRANSMIS EST CELUI QUI VIENT DE FAIRE SORTIR LE PARCOURS, lu par son identifiant (revue finale du
 * 2026-09-22). La première version lisait « la dernière saisie du contact » : sur une réaction retirée, un entrant
 * sans texte, ou deux messages arrivés ensemble, elle transmettait un message PRÉCÉDENT, que l'agent de Meta
 * aurait traité comme une question fraîche. Un message sans texte ne se transmet pas.
 *
 * 🔴 SEULEMENT SI LE FIL EST VRAIMENT À LUI (`mba` chez nous) : une conversation de TEST, un release refusé ou un
 * marqueur en attente laissent un autre détenteur, et l'événement n'aurait personne pour y répondre.
 *
 * ⚠️ QUI APPELLE DÉCIDE DE CE QUI EST UN MESSAGE : la branche « il a écrit » d'`advance` reçoit aussi des
 * réactions et des rapports RCS, et elle ne transmet que sur un message WhatsApp sans charge de bouton.
 *
 * ⚠️ SORTI DU CÂBLAGE POUR ÊTRE TESTÉ : écrit dans `wiring.ts`, retirer la garde du détenteur ne faisait tomber
 * aucun test.
 */
export interface DepsTransmettre {
  detenteur(tenantId: string, waId: string): Promise<string>;
  numero(tenantId: string): Promise<string | null>;
  /** Le texte de CE message entrant (par son identifiant Meta, dans cet espace), ou `null`. */
  corpsDuMessage(tenantId: string, messageId: string): Promise<string | null>;
  envoyer(tenantId: string, phoneNumberId: string, to: string, event: EvenementAgent): Promise<unknown>;
  journal?(ligne: string): void;
}

export function creerTransmettreHorsParcours(deps: DepsTransmettre) {
  return async (tenantId: string, waId: string, messageId: string): Promise<void> => {
    if ((await deps.detenteur(tenantId, waId)) !== 'mba') {
      deps.journal?.(`agent_event non envoyé pour ${waId} : le fil n’est pas à l’agent de Meta`);
      return;
    }
    const pn = await deps.numero(tenantId);
    if (!pn) {
      deps.journal?.(`agent_event non envoyé pour ${waId} : aucun numéro connecté`);
      return;
    }
    const texte = (await deps.corpsDuMessage(tenantId, messageId))?.trim() ?? '';
    if (texte === '') {
      deps.journal?.(`agent_event non envoyé pour ${waId} : le message ${messageId} n’a pas de texte lisible`);
      return;
    }
    const reponse = await deps.envoyer(tenantId, pn, destinataireAgentEvent(waId), evenementHorsParcours(texte));
    // La réponse de Meta porte l'identifiant de l'événement : sans elle, impossible de lui demander ensuite s'il
    // l'a traité ou ignoré (`GET /{phone_number_id}/agent_event/{id}`), ce qui a manqué à l'essai du 2026-09-22.
    deps.journal?.(`agent_event hors parcours envoyé pour ${waId} : ${traceReponse(reponse)}`);
  };
}
