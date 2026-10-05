/**
 * LE JOURNAL DES ÉVÉNEMENTS D'UNE CONVERSATION (migration 0192, panneau Détail de l'Inbox, cadrage du 2026-09-28).
 *
 * Ce qui est arrivé à une conversation, qui l'a fait, et pourquoi quand personne ne l'a fait : les assignations,
 * les prises et les rendus à l'agent de Meta, « Traité », « Archivé », « Signalé » et leurs inverses, la
 * rouverture par un message du contact, et depuis 0194 le passage d'un robot à l'équipe et le retour à un scénario.
 *
 * 🔴 DEUX RÈGLES D'ÉCRITURE, tenues par `PgInboxStore` et par lui seul :
 *  - l'événement s'écrit dans la MÊME requête que le changement qu'il décrit (une requête à CTE). Deux écritures
 *    laisseraient une fenêtre où l'un existe sans l'autre, et la frise mentirait sur l'état qu'elle raconte ;
 *  - seulement si la valeur a VRAIMENT changé. Réassigner à la même personne, archiver une conversation déjà
 *    archivée : aucun événement, sinon la frise se remplit de gestes sans effet.
 *
 * ⚠️ UNE LIGNE PORTE UN ACTEUR OU UNE CAUSE, et c'est ce qui permet de lire un acteur nul : un événement
 * automatique porte toujours sa cause (« automatique : campagne Rentrée »). Un acteur nul SANS cause est donc un
 * collaborateur supprimé depuis (`on delete set null`), que l'écran dit « ancien collaborateur ».
 */
import type { OrigineMessage } from './origine';

/**
 * Les types, dans l'ordre du cadrage. Miroir du CHECK en vigueur, celui de 0209, tenu par
 * `tests/migration-0209.test.ts` ; les douze premiers sont ceux de 0192, les deux suivants ceux de 0194.
 *
 * Les deux derniers (0194) datent ce que le Quantitatif > Performance mesure : `escaladee`, une demande s'ouvre pour
 * l'équipe, soit qu'un robot lui passe la main (un scénario ou un agent IA, drapeau d'escalade ou non, et la réponse à
 * une campagne dont le devenir est l'Inbox ; celle de l'agent de Meta est `passee_par_mba`, pas doublée), soit que le
 * contact rouvre une conversation « Traité » ou archivée qu'elle tient encore (`ControleDuFil.remettreSiPersonneNeSuit`,
 * sans bascule) ; `rendue_scenario`, l'équipe rend le fil à un scénario. Comment ils ouvrent et ferment une demande :
 * `src/stats/performance.ts`.
 *
 * Le dernier (0209) : `sortie_agent`, un agent IA a terminé par une règle d'arrêt, que sa cause nomme
 * (`PgInboxStore.noterSortieAgent`). Il n'ouvre ni ne ferme aucune demande : c'est la bascule qui suit, s'il y en a une.
 */
export const TYPES_EVENEMENT = [
  'assignee', 'desassignee', 'prise_mba', 'rendue_mba', 'passee_par_mba',
  'traitee', 'non_traitee', 'archivee', 'desarchivee', 'signalee', 'designalee', 'rouverte',
  'escaladee', 'rendue_scenario', 'sortie_agent',
] as const;
export type TypeEvenement = (typeof TYPES_EVENEMENT)[number];

/**
 * La cause des lignes amorcées par la migration depuis l'état qu'elle a trouvé. Recopiée dans le SQL de 0192
 * (une migration ne s'importe pas), et un test vérifie que les deux sont le même texte.
 */
export const CAUSE_AMORCAGE = 'état au déploiement';

/** La cause d'une rouverture : c'est le contact qui a écrit, pas quelqu'un de l'équipe. */
export const CAUSE_MESSAGE_DU_CONTACT = 'message du contact';

/**
 * Au-delà, une cause est coupée : elle porte parfois un nom saisi par le client (une campagne, un scénario), et
 * un CHECK de longueur ferait échouer le CHANGEMENT lui-même (une assignation perdue pour un nom trop long).
 */
export const CAUSE_MAX = 200;

/**
 * Qui demande un changement : un collaborateur de la console (son identifiant, `null` quand la session n'en porte
 * pas), ou une cause automatique dite en clair. Un paramètre REQUIS des écritures de `PgInboxStore` : un nouvel
 * appelant qui l'oublierait ne compile pas, et une frise où un changement arrive sans auteur ni cause ne dit rien.
 */
export type AuteurDuChangement = { collaborateur: string | null } | { cause: string };

/** La cause d'un changement automatique, telle que la frise l'affiche : « automatique : campagne Rentrée ». */
export function automatique(quoi: string): string {
  return `automatique : ${quoi}`;
}

/** Raccourci des chemins automatiques. */
export function parCause(quoi: string): AuteurDuChangement {
  return { cause: automatique(quoi) };
}

/**
 * Qui prend le fil en écrivant au client, d'après l'origine du message : l'opérateur qui signe, ou la machine qui
 * écrit (API publique, agent tiers par MCP). Un seul endroit pour les deux routes d'envoi qui prennent le fil.
 */
export function auteurDeLEnvoi(origine: OrigineMessage, auteur: string | null): AuteurDuChangement {
  if (origine === 'humain') return { collaborateur: auteur };
  if (origine === 'api') return parCause('envoi par l’API');
  if (origine === 'mcp') return parCause('envoi par un agent tiers (MCP)');
  return parCause(`envoi (${origine})`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ce que la frise dit d'un geste fait par une identité qui n'est PAS un collaborateur de l'espace : une clé d'API, ou
 * une session sans compte (l'observation de /ops, une session sans identifiant).
 */
export const CAUSE_CLE_API = 'par une clé d’API';
export const CAUSE_HORS_COMPTE = 'par un accès sans compte collaborateur';

/**
 * Les deux colonnes que l'auteur remplit. 🔴 Un identifiant qui n'est pas un uuid (clé d'API `apikey:...`,
 * identité d'observation de /ops) devient un acteur `null` ICI, avant la base : passé à `::uuid`, il ferait échouer la
 * requête entière, donc le changement que l'événement décrit, pour une ligne de journal.
 *
 * 🔴 ET IL PORTE ALORS UNE CAUSE (relecture du 2026-09-29). Sans elle, la ligne n'avait ni acteur ni cause, ce que la
 * lecture réserve au collaborateur SUPPRIMÉ depuis : une clé d'API s'affichait « ancien collaborateur ». La règle
 * « une ligne porte un acteur OU une cause » tient désormais pour toute identité.
 */
export function colonnesAuteur(a: AuteurDuChangement): { acteur: string | null; cause: string | null } {
  if ('cause' in a) return { acteur: null, cause: borner(a.cause) };
  if (a.collaborateur !== null && UUID_RE.test(a.collaborateur)) return { acteur: a.collaborateur, cause: null };
  return { acteur: null, cause: a.collaborateur?.startsWith('apikey:') ? CAUSE_CLE_API : CAUSE_HORS_COMPTE };
}

/** Coupe une cause trop longue ; `null` pour une cause vide. */
export function borner(cause: string): string | null {
  const c = cause.trim();
  if (c === '') return null;
  return c.length > CAUSE_MAX ? `${c.slice(0, CAUSE_MAX - 1)}…` : c;
}

/**
 * L'acteur d'un événement, résolu dans l'espace (`$acteur` = un uuid ou null, `$tenant` = l'espace). 🔴 Relu dans
 * `users` et pas écrit tel quel : un identifiant d'un autre espace n'est jamais inscrit dans ce journal, et un
 * compte inconnu donne `null` plutôt qu'une violation de clé étrangère qui ferait échouer le changement.
 */
export function acteurSql(paramActeur: string, paramTenant: string): string {
  return `(select u.id from users u where u.id = ${paramActeur}::uuid and u.tenant_id = ${paramTenant})`;
}

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

/** Combien d'événements le panneau montre. */
export const HISTORIQUE_MAX = 50;
