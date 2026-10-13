/**
 * Les sorties du bloc agent d'un scénario. Une sortie écrite en littéral qui diverge d'une lettre ne correspond à
 * aucune arête, et le parcours part par la première arête venue, sans erreur nulle part : le tour, les outils maison et
 * le builder lisent donc tous ces valeurs-ci.
 */

/**
 * Le contact ne répond plus. Sans préfixe `sortie:` : c'est le handle du bloc Question, réemprunté pour qu'il
 * n'y ait qu'un seul vocabulaire dans le builder.
 */
export const SORTIE_TIMEOUT = 'timeout';

/** Tours, appels d'outils ou budget épuisés. */
export const SORTIE_PLAFOND = 'plafond';

/**
 * L'agent passe la main à un humain (outil `mba_escalader_humain`). Le client câble ce handle vers ce qu'il
 * veut voir après une escalade : un message d'attente, un tag, une fin de parcours.
 */
export const SORTIE_HUMAIN = 'humain';

/** Repli : le modèle a échoué, l'envoi a été refusé, la fiche d'agent est introuvable. */
export const SORTIE_ECHEC = 'echec';

/**
 * L'agent n'a aucune source pour répondre : le garde-fou anti-hallucination. Il est déterministe (score de
 * recherche comparé à un seuil, en code), jamais laissé au jugement du modèle.
 */
export const SORTIE_SANS_SOURCE = 'sans_source';

/**
 * Le code d'une règle d'arrêt, que le client déclare sur la fiche de son agent. Même alphabet que les noms d'outils,
 * parce qu'il finit dans un handle d'arête `sortie:<code>` du builder. Ni souligné en tête ni en queue :
 * `normaliserCodeSortie` ne peut pas en produire, donc un tel code serait impossible à taper ou à reproduire.
 */
export const CODE_SORTIE_RE = /^[a-z0-9](?:[a-z0-9_]{0,30}[a-z0-9])?$/;

/** La longueur maximale d'un code de sortie : celle que `CODE_SORTIE_RE` laisse passer. */
export const LONGUEUR_CODE_SORTIE = 32;

/** Plafond de règles d'arrêt. Au-delà, le bloc devient illisible dans le builder, et le modèle choisit mal dans une
 *  énumération trop large. */
export const MAX_SORTIES = 12;

/**
 * Ramène une saisie libre vers ce que `CODE_SORTIE_RE` accepte. Rend une chaîne VIDE quand il ne reste rien
 * d'exploitable : l'appelant écarte l'entrée, ou désactive son bouton plutôt que d'ajouter une sortie nommée « _ ».
 * La console l'applique sous les yeux du client ; l'assistant de construction s'en sert pour ramener un code proposé
 * dans l'alphabet au lieu de refuser toute la proposition.
 *
 * ⚠️ Un code DÉJÀ valide ressort inchangé. Sinon rouvrir une fiche déplacerait ses codes, et les arêtes déjà tirées
 * dans le builder désigneraient des sorties qui n'existent plus.
 */
export function normaliserCodeSortie(brut: string): string {
  return brut
    // Retrait des marques diacritiques : un accent ne passe pas dans un handle d'arête, la lettre qui le porte, si.
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, LONGUEUR_CODE_SORTIE)
    // Le `slice` peut laisser un souligné final : on le retire APRÈS, sinon un code tronqué sortirait avec une
    // terminaison que personne n'a écrite.
    .replace(/_+$/g, '');
}
