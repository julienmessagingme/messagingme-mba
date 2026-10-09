/**
 * Les événements d'une conversation (la frise du panneau détail de l'Inbox) : la liste des types et la forme de ce que
 * rend `GET /tenants/:tenantId/conversations/:id/detail`, PARTAGÉES par le serveur (`src/inbox/evenements.ts`) et la
 * console (`web/lib/inbox-detail.ts`). Un type ajouté ici arrive à l'écran dans le même commit que dans l'API : la
 * console ne peut plus écarter en silence un type qu'elle ne connaîtrait pas encore.
 */

/**
 * Les types, dans l'ordre du cadrage. Miroir du CHECK en vigueur, celui de 0217, tenu par
 * `tests/migration-0217.test.ts` ; les douze premiers sont ceux de 0192, les deux suivants ceux de 0194.
 *
 * Les deux derniers (0194) datent ce que le Quantitatif > Performance mesure : `escaladee`, une demande s'ouvre pour
 * l'équipe, soit qu'un robot lui passe la main (un scénario ou un agent IA, drapeau d'escalade ou non, et la réponse à
 * une campagne dont le devenir est l'Inbox ; celle de l'agent de Meta est `passee_par_mba`, pas doublée), soit que le
 * contact rouvre une conversation « Traité » ou archivée qu'elle tient encore (`ControleDuFil.remettreSiPersonneNeSuit`,
 * sans bascule) ; `rendue_scenario`, l'équipe rend le fil à un scénario. Comment ils ouvrent et ferment une demande :
 * `src/stats/performance.ts`.
 *
 * Celui de 0209 : `sortie_agent`, un agent IA a terminé par une règle d'arrêt, que sa cause nomme
 * (`PgInboxStore.noterSortieAgent`). Il n'ouvre ni ne ferme aucune demande : c'est la bascule qui suit, s'il y en a une.
 *
 * Les deux derniers (0216) : `urgente` et `urgence_levee`, la conversation marquée urgente (par un collaborateur, ou par
 * un agent IA dont la cause dit le nom) et l'urgence retirée, à la main ou par « Traité » et l'archivage, qui la lèvent
 * dans leur propre requête (`PgInboxStore.basculerRangement`). Aucun n'ouvre ni ne ferme de demande.
 *
 * Celui de 0217 : `mba_indisponible`, le bloc « Envoyer au MBA » d'un scénario a trouvé l'agent de Meta éteint, et la
 * conversation est allée à l'équipe (`PgInboxStore.noterMbaIndisponible`). Il n'ouvre ni ne ferme de demande : c'est
 * la bascule qui suit.
 */
export const TYPES_EVENEMENT = [
  'assignee', 'desassignee', 'prise_mba', 'rendue_mba', 'passee_par_mba',
  'traitee', 'non_traitee', 'archivee', 'desarchivee', 'signalee', 'designalee', 'rouverte',
  'escaladee', 'rendue_scenario', 'sortie_agent', 'urgente', 'urgence_levee', 'mba_indisponible',
] as const;
export type TypeEvenement = (typeof TYPES_EVENEMENT)[number];

/**
 * La cause des lignes amorcées par la migration depuis l'état qu'elle a trouvé. Recopiée dans le SQL de 0192
 * (une migration ne s'importe pas), et un test vérifie que les deux sont le même texte.
 */
export const CAUSE_AMORCAGE = 'état au déploiement';

/** Un nom de la frise : un collaborateur, un collaborateur supprimé depuis, ou personne (changement automatique). */
export type QuiEvenement = { nom: string } | { ancien: true } | null;

export interface EvenementConversation {
  id: string;
  type: TypeEvenement;
  at: string;
  /** Qui a fait le geste. `null` = personne : la cause dit alors pourquoi. */
  acteur: QuiEvenement;
  /** Le collaborateur assigné (ou désassigné), pour les deux types d'assignation ; `null` sinon. */
  cible: QuiEvenement;
  cause: string | null;
  /** Une assignation qui en remplace une autre : l'écran dit « réassignée ». */
  reassignation: boolean;
  /**
   * Une assignation que le collaborateur s'est faite à lui-même (acteur = cible) : une PRISE, que l'écran dit
   * « Prise en charge » au lieu de « Assignée à Marie, par Marie ».
   */
  prise: boolean;
}

export interface DetailConversation {
  conversationId: string;
  identite: {
    /** La fiche du mini-CRM, `null` quand la conversation n'y est rattachée à aucune (ou à une fiche supprimée). */
    contactId: string | null;
    waId: string;
    /** Les champs système `name`, `prenom`, `phone`, `email` (`SYSTEM_FIELD_KEYS`, `src/crm/fields.ts`). */
    nom: string | null;
    prenom: string | null;
    telephone: string | null;
    email: string | null;
    tags: string[];
    desabonne: boolean;
    bloque: boolean;
  };
  /** Le résumé de l'analyse des conversations, `null` tant qu'elle n'est pas passée. */
  resume: string | null;
  /** À qui la conversation est confiée, `null` = personne. */
  assignation: { userId: string; nom: string } | null;
  /** Les 50 derniers événements, du plus récent au plus ancien. */
  historique: EvenementConversation[];
}
