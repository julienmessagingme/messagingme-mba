import { traceReponse, destinataireAgentEvent, evenementHorsParcours, type EvenementAgent } from './evenement';

/**
 * La réponse « à côté » part chez l'agent de Meta, une fois le fil rendu. Le message transmis est celui qui vient
 * de faire sortir le parcours, lu par son identifiant : « la dernière saisie » pourrait être un message précédent,
 * que l'agent traiterait comme une question fraîche. Un message sans texte ne se transmet pas.
 * Seulement si le fil est vraiment à lui (`mba` chez nous) : un test, un release refusé ou un marqueur en attente
 * laissent un autre détenteur. L'appelant décide de ce qui est un message (pas les réactions ni les rapports RCS).
 */
export interface DepsTransmettre {
  detenteur(tenantId: string, waId: string): Promise<string>;
  numero(tenantId: string): Promise<string | null>;
  /** Le texte de ce message entrant (par son identifiant Meta, dans cet espace), ou `null`. */
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
    // La réponse de Meta porte l'identifiant de l'événement, seul moyen de lui demander ensuite s'il l'a traité
    // ou ignoré (`GET /{phone_number_id}/agent_event/{id}`).
    deps.journal?.(`agent_event hors parcours envoyé pour ${waId} : ${traceReponse(reponse)}`);
  };
}
