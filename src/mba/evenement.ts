/**
 * L'événement qui fait répondre l'agent de Meta à un client sorti d'un parcours : l'agent ne parle qu'au message
 * suivant du client, et la question posée « à côté » resterait sans réponse. `agent_event` lui passe le message.
 *
 * `payload` est une chaîne JSON (pas un objet), bornée à 4 096 caractères mesurés après échappement. Le type et la
 * description sont figés ici : l'agent s'appuie sur eux en langage naturel, un renommage changerait son
 * comportement sans signal. La consigne dit « reprends la conversation » et pas seulement « réponds » : un simple
 * accusé du client n'appellerait sinon aucune réponse, et le client resterait sans interlocuteur.
 */
export interface EvenementAgent { type: string; description: string; payload: string }

export const TYPE_HORS_PARCOURS = 'reponse_hors_parcours';
export const DESCRIPTION_HORS_PARCOURS =
  'Le client vient d’écrire en dehors du parcours automatique qu’on lui proposait : tu reprends la conversation avec lui. Réponds-lui maintenant, brièvement et naturellement, même si son message n’appelle pas de réponse précise (par exemple en lui proposant ton aide).';
const PAYLOAD_MAX = 4096;

/** `{ [cle]: texte }` en chaîne JSON d'au plus `PAYLOAD_MAX` caractères, échappement compris. */
function payloadBorne(cle: string, texteEntier: string): string {
  let texte = texteEntier;
  let payload = JSON.stringify({ [cle]: texte });
  // On raccourcit le texte, jamais la chaîne JSON (couper un échappement la rendrait illisible). Chaque tour
  // retire au moins l'excédent mesuré, donc la boucle termine.
  while (payload.length > PAYLOAD_MAX && texte.length > 0) {
    texte = texte.slice(0, Math.max(0, texte.length - (payload.length - PAYLOAD_MAX)));
    payload = JSON.stringify({ [cle]: texte });
  }
  return payload;
}

export function evenementHorsParcours(message: string): EvenementAgent {
  return { type: TYPE_HORS_PARCOURS, description: DESCRIPTION_HORS_PARCOURS, payload: payloadBorne('message', message) };
}

/**
 * L'envoi demandé par l'agent de Meta a échoué après sa réponse : le relais n'attend un envoi que 1,5 s
 * (`DELAI_REPONSE_ENVOI_MS`), et l'agent resterait muet. La raison part dans le payload : des textes écrits pour
 * lui (`gestes-envoi.ts`, `erreurDePanne`).
 */
export const TYPE_ENVOI_ECHOUE = 'envoi_echoue';
export const DESCRIPTION_ENVOI_ECHOUE =
  'L’envoi que tu as demandé pour ce client n’a finalement pas abouti, après ta réponse. Dis-le-lui simplement, sans détail technique, et propose-lui une autre solution.';

export function evenementEnvoiEchoue(raison: string): EvenementAgent {
  return { type: TYPE_ENVOI_ECHOUE, description: DESCRIPTION_ENVOI_ECHOUE, payload: payloadBorne('raison', raison) };
}

/**
 * La réponse de Meta à un `agent_event`, en une ligne de journal bornée. Elle porte l'identifiant qui permet de lui
 * demander ensuite ce que l'événement est devenu (`sent`, `skipped` et sa raison, `failed`). Aucune donnée du client
 * n'y figure : Meta ne renvoie pas le contenu.
 */
export function traceReponse(reponse: unknown): string {
  try {
    return (JSON.stringify(reponse) ?? String(reponse)).slice(0, 300);
  } catch {
    return String(reponse).slice(0, 300);
  }
}

/** Le format de `to` qu'attend Meta : E.164 avec « + ». */
export function destinataireAgentEvent(waId: string): string {
  return `+${waId.replace(/^\+/, '')}`;
}
