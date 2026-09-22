/**
 * L'ÉVÉNEMENT QUI FAIT RÉPONDRE L'AGENT DE META à un client sorti d'un parcours (spec
 * docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md, § 5).
 *
 * Un scénario pose une question à boutons ; le client répond « à côté » (« vous êtes ouverts dimanche ? »). Le
 * parcours s'arrête et rend le fil à l'agent de Meta, mais celui-ci ne parle qu'au message SUIVANT du client : sans
 * cet événement, la question posée resterait sans réponse. `agent_event` lui passe le message, et il y répond
 * (mesuré le 2026-09-21 : 11 secondes, `docs/MBA-API-REFERENCE.md`).
 *
 * ⚠️ `payload` EST UNE CHAÎNE JSON, pas un objet (documentation de Meta), bornée à 4 096 caractères : la borne se
 * mesure APRÈS échappement, sinon un message plein de guillemets passerait la coupe et serait refusé. Le type et
 * la description sont figés ici : l'agent s'appuie sur eux en langage naturel, et un renommage changerait son
 * comportement sans aucun signal.
 */
export interface EvenementAgent { type: string; description: string; payload: string }

export const TYPE_HORS_PARCOURS = 'reponse_hors_parcours';
export const DESCRIPTION_HORS_PARCOURS =
  'Le client vient d’écrire en dehors du parcours automatique qu’on lui proposait. Réponds à son message.';
const PAYLOAD_MAX = 4096;

export function evenementHorsParcours(message: string): EvenementAgent {
  let texte = message;
  let payload = JSON.stringify({ message: texte });
  // On raccourcit le TEXTE, jamais la chaîne JSON : couper celle-ci au milieu d'un échappement la rendrait
  // illisible. Chaque tour retire au moins l'excédent mesuré, donc la boucle termine.
  while (payload.length > PAYLOAD_MAX && texte.length > 0) {
    texte = texte.slice(0, Math.max(0, texte.length - (payload.length - PAYLOAD_MAX)));
    payload = JSON.stringify({ message: texte });
  }
  return { type: TYPE_HORS_PARCOURS, description: DESCRIPTION_HORS_PARCOURS, payload };
}

/** Le format de `to`, MESURÉ le 2026-09-21 (plan 2026-09-21-outils-maison-mba, Task 1) : E.164 avec « + ». */
export function destinataireAgentEvent(waId: string): string {
  return `+${waId.replace(/^\+/, '')}`;
}
