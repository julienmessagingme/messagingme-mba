import type { WorkflowGraph } from './graph';
import type { StartOutcome, WorkflowExecutor } from './executor';
import { grapheEditable, type WorkflowRow } from './store.pg';
import { blocDesigne } from './test-token';

/**
 * UN POINT D'ENTRÉE PAR TYPE DE LANCEMENT DE SCÉNARIO (piste 4 du rapport d'architecture du 2026-10-02, plan
 * `docs/superpowers/plans/2026-10-04-lancements-de-scenario.md`).
 *
 * 🔴 POURQUOI CE MODULE EXISTE. Sept lancements choisissaient chacun, dans une flèche de `src/index.ts` ou de
 * `src/worker.ts`, les réglages de l'exécuteur : reprendre le fil, publier les étiquettes posées, jouer le
 * brouillon figé, lever la garde de fenêtre. Ces choix n'étaient gardés que par des tests qui lisaient le TEXTE
 * des câblages, et l'un d'eux (l'exception de l'opérateur des leads publicitaires, 2026-09-27) avait déjà atterri
 * dans la racine. Ils vivent désormais dans UNE table, que l'exécuteur lit lui-même (`WorkflowExecutor.demarrer`)
 * et qu'un test exécute type par type (`tests/workflow-lancements.test.ts`). Un câblage ne choisit plus qu'un
 * TYPE ; un lancement ajouté demain en choisit un, ou en ajoute un ici, dans la table, sous les yeux du relecteur.
 *
 * ⚠️ CE QUE LA TABLE NE DÉCIDE PAS : les gardes de `runFrom` (fil d'un opérateur, bloc absent, fenêtre, numéro
 * délié, désabonnement) s'appliquent à TOUS les types, la table ne dit que lesquelles sont levées et comment.
 */

/** Les types de lancement, liste FERMÉE : un type inconnu ne compile pas, il n'a pas de politique par défaut. */
export const TYPES_DE_LANCEMENT = [
  /** Un opérateur lance un scénario depuis l'Inbox. */
  'inbox',
  /** L'agent de Meta lance un scénario par son outil « Lancer un scénario » (le chemin du bouton de l'Inbox). */
  'agent_meta_scenario',
  /** L'agent de Meta envoie un bloc par son outil « Envoyer un bloc », dans un graphe réduit à ce bloc. */
  'agent_meta_bloc',
  /** Une automation ordinaire : mot-clé, étiquette posée, date, analyse, webhook, risque. */
  'automatisme_ordinaire',
  /** L'automation d'un bouton de lien de chaîne (`POSSESSEUR_LIEN_CHAINE`). */
  'automatisme_chaine',
  /** L'automation d'une publicité Click-to-WhatsApp ou d'un widget (`POSSESSEUR_PUBLICITE`, `POSSESSEUR_WIDGET`). */
  'automatisme_publicite_ou_widget',
  /** Le lien de test d'un scénario (jeton wa.me, éventuellement suffixé d'un bloc). */
  'lien_de_test',
  /** Une campagne à scénario, destinataire par destinataire. */
  'campagne_scenario',
  /** Une campagne qui démarre à un bloc (cible `node` de `/v1/sends`). */
  'campagne_bloc',
  /**
   * Le répondeur de l'espace : un agent IA désigné prend le message que personne ne tient
   * (`src/repondeur/demarrer.ts`), dans le scénario système caché de l'espace, sur un graphe construit au démarrage.
   */
  'repondeur',
] as const;
export type TypeDeLancement = (typeof TYPES_DE_LANCEMENT)[number];

/**
 * Les types qu'une automation peut porter (`typeDeLancementDe`, `src/automation/match.ts`, en choisit un), dérivés de
 * la liste fermée : un type d'automatisme ajouté plus haut entre ici sans seconde liste à tenir.
 */
export type TypeDeLancementAutomatisme = Extract<TypeDeLancement, `automatisme_${string}`>;

/** Ce que décide le type d'un lancement, et rien d'autre. */
export interface PolitiqueDeLancement {
  /**
   * Le fil tenu par quelqu'un d'autre.
   * - `non` : le démarrage s'arrête devant un fil tenu par un opérateur ou par l'agent de Meta (`mayAct`). Un
   *   mot-clé ordinaire écrirait sinon par-dessus l'opérateur en train de répondre.
   * - `oui` : il reprend la conduite du fil pour l'app, même à un opérateur (`reclaimControl`). Réservé aux
   *   gestes explicites : un opérateur qui lance, un abonné qui clique un bouton de chaîne, un testeur.
   * - `sauf_operateur` : il la reprend à l'agent de Meta, jamais à un opérateur qui la tient. C'est le client qui
   *   déclenche (un clic payé, un clic sur la bulle), et l'opérateur en train de lui répondre garde la conversation.
   */
  reprise: 'non' | 'oui' | 'sauf_operateur';
  /**
   * Les étiquettes posées par le parcours publient « tag ajouté » (démarrage unitaire : un contact, ici et
   * maintenant). 🔴 Jamais un chemin de masse : une campagne de 5 000 destinataires dont le scénario pose une
   * étiquette publierait 5 000 événements, donc autant de scénarios et de messages facturés.
   */
  publieLesEtiquettes: boolean;
  /**
   * Le graphe joué.
   * - `publie` : celui que l'entrée lit (`row.graph`), celui de tout contact réel.
   * - `fourni` : celui de l'appelant (l'envoi d'un bloc de l'agent de Meta, réduit au bloc par `blocSeul`).
   * - `brouillon_fige` : le brouillon (`grapheEditable`), figé dans le parcours, sinon les points de reprise
   *   reliraient le publié. 🔴 Seul le lien de test : un contact réel ne tombe jamais dans un brouillon, et figer
   *   le graphe de chaque destinataire d'une campagne le recopierait des milliers de fois.
   * - `fourni_fige` : celui de l'appelant, figé dans le parcours. Le répondeur : sa ligne de scénario n'est qu'une
   *   ancre au graphe vide (`assurerScenarioSysteme`), et le parcours doit garder le graphe avec lequel il a commencé
   *   même si l'agent désigné change entre-temps. Un parcours par conversation, pas par destinataire de masse.
   * Qu'un graphe se fige ne se décide qu'à un endroit : `grapheAFiger`.
   */
  graphe: 'publie' | 'fourni' | 'brouillon_fige' | 'fourni_fige';
  /**
   * La garde de fenêtre 24 h de `runFrom` (un message de session en ouverture, refusé par Meta en 131047).
   * - `gardee` : toujours posée (une campagne écrit à froid).
   * - `selon_preuve` : levée si l'appelant prouve la fenêtre ouverte (le contact vient d'écrire), posée sinon.
   * - `bloc_ou_preuve` : comme `selon_preuve`, et levée aussi quand l'automation désigne un bloc de départ (la
   *   règle de l'ancien `startFromNode`, que ces automations empruntaient ; aucune vérification de fenêtre n'y a
   *   lieu, écart connu et non corrigé ici).
   * - `levee` : jamais posée, parce que l'appelant l'a vérifiée (bloc de l'agent de Meta, envoi `/v1/sends`) ou
   *   parce que le testeur vient d'écrire son jeton.
   */
  fenetre: 'gardee' | 'selon_preuve' | 'bloc_ou_preuve' | 'levee';
}

/**
 * 🔴 LA TABLE. Une ligne par type, et chaque ligne reproduit À L'IDENTIQUE ce que faisait le câblage d'avant
 * (décision de Julien du 2026-10-04) ; `tests/workflow-lancements.test.ts` l'exécute ligne par ligne sur le vrai
 * exécuteur. Changer une valeur change le comportement de chaque scénario lancé par ce chemin en production.
 */
export const POLITIQUE_DE_LANCEMENT = {
  inbox: { reprise: 'oui', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'selon_preuve' },
  agent_meta_scenario: { reprise: 'oui', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'selon_preuve' },
  agent_meta_bloc: { reprise: 'oui', publieLesEtiquettes: false, graphe: 'fourni', fenetre: 'levee' },
  automatisme_ordinaire: { reprise: 'non', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'bloc_ou_preuve' },
  automatisme_chaine: { reprise: 'oui', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'bloc_ou_preuve' },
  automatisme_publicite_ou_widget: { reprise: 'sauf_operateur', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'bloc_ou_preuve' },
  lien_de_test: { reprise: 'oui', publieLesEtiquettes: true, graphe: 'brouillon_fige', fenetre: 'levee' },
  campagne_scenario: { reprise: 'oui', publieLesEtiquettes: false, graphe: 'publie', fenetre: 'gardee' },
  campagne_bloc: { reprise: 'oui', publieLesEtiquettes: false, graphe: 'publie', fenetre: 'levee' },
  /**
   * Le répondeur (lot 5, spec `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`) : jamais à un
   * opérateur qui tient le fil (c'est le client qui écrit, comme un clic sur une publicité) ; ses étiquettes publient
   * (un contact, ici et maintenant) ; la fenêtre est prouvée par l'entrant qui le démarre.
   */
  repondeur: { reprise: 'sauf_operateur', publieLesEtiquettes: true, graphe: 'fourni_fige', fenetre: 'selon_preuve' },
} as const satisfies Record<TypeDeLancement, PolitiqueDeLancement>;

/**
 * Le graphe de ce lancement se fige-t-il dans le parcours (`workflow_runs.graphe_fige`) ? La SEULE réponse du dépôt :
 * l'exécuteur la lit à la création du parcours. Deux comparaisons écrites chacune ailleurs finiraient par diverger, et
 * un parcours non figé relirait la ligne de scénario (le publié) à sa première reprise.
 */
export function grapheAFiger(politique: PolitiqueDeLancement): boolean {
  return politique.graphe === 'brouillon_fige' || politique.graphe === 'fourni_fige';
}

/** Où le parcours commence. Une donnée du lancement, pas un réglage : c'est la politique qui dit ce qu'elle lève. */
export type DepartDuParcours =
  /**
   * À l'entrée du graphe. `fenetreOuverte` : le contact vient d'écrire, lue seulement par une fenêtre
   * `selon_preuve` ou `bloc_ou_preuve`. `firstTemplateParams` : les variables du premier modèle, déjà résolues par
   * la campagne à la construction de ses destinataires (pas de re-résolution à l'envoi). `messageDeclencheur` : le
   * message entrant qui démarre le parcours, inscrit comme déjà reçu (`last_message_id`) : redélivré par Meta, il
   * n'est pas pris pour une réponse du contact par `advance`, qui enfilerait un second tour d'agent.
   */
  | { depuis: 'entree'; fenetreOuverte?: boolean; firstTemplateParams?: string[]; messageDeclencheur?: string }
  /** À un bloc désigné du graphe. Un bloc absent est refusé lisiblement par `runFrom`. */
  | { depuis: 'bloc'; noeudId: string };

/**
 * La garde de fenêtre est-elle levée pour ce lancement ? Seul endroit où la politique et le départ se croisent.
 * Un `switch` sans `default` : une règle ajoutée demain ne compile pas tant qu'elle n'a pas sa branche.
 */
export function fenetreLevee(politique: PolitiqueDeLancement, depart: DepartDuParcours): boolean {
  const prouvee = depart.depuis === 'entree' && depart.fenetreOuverte === true;
  switch (politique.fenetre) {
    case 'gardee': return false;
    case 'selon_preuve': return prouvee;
    case 'bloc_ou_preuve': return depart.depuis === 'bloc' || prouvee;
    case 'levee': return true;
  }
}

/** Les champs que toute demande porte : l'espace et le scénario. */
interface DemandeDeBase {
  tenantId: string;
  workflowId: string;
}

/** L'envoi d'un bloc par l'agent de Meta : le seul type qui fournit son graphe et sa fiche, et ne lit rien. */
export interface DemandeEnvoiDeBloc extends DemandeDeBase {
  type: 'agent_meta_bloc';
  /** Le graphe PUBLIÉ réduit au bloc (`blocSeul`) : ce qui le suit dans le scénario ne peut pas partir. */
  graphe: WorkflowGraph;
  contact: { waId: string; contactId: string | null };
  noeudId: string;
}

/**
 * Le répondeur de l'espace (`src/repondeur/demarrer.ts`) : le graphe est fourni (construit depuis le réglage par
 * `grapheDuRepondeur`) et figé ; la ligne de scénario n'est que l'ancre, jamais lue. La fenêtre est toujours prouvée :
 * seul un message entrant démarre le répondeur.
 */
export interface DemandeRepondeur extends DemandeDeBase {
  type: 'repondeur';
  waId: string;
  graphe: WorkflowGraph;
  fenetreOuverte: true;
  /** Le dernier message du contact qui le démarre ; `null` = inconnu (aucune déduplication possible). */
  messageDeclencheur: string | null;
}

/** Ce qu'une automation demande : le runner la construit (`src/automation/runner.ts`), le worker la transmet telle quelle. */
export interface DemandeAutomatisme extends DemandeDeBase {
  type: TypeDeLancementAutomatisme;
  waId: string;
  /** Le bloc de départ réglé sur l'automation, `null` = l'entrée du scénario. */
  blocDeDepart: string | null;
  /** La fenêtre est prouvée ouverte : l'événement est un message WhatsApp entrant. */
  fenetreOuverte: boolean;
}

/**
 * La demande, typée PAR TYPE : chaque type ne porte que ce qui le concerne (`firstTemplateParams` n'existe que
 * pour la campagne à scénario, le graphe fourni que pour l'envoi d'un bloc, la preuve de fenêtre que là où elle
 * est lue). Un câblage ne peut donc pas passer une donnée qu'aucune politique ne lira.
 */
export type DemandeDeLancement =
  | (DemandeDeBase & { type: 'inbox' | 'agent_meta_scenario'; waId: string; fenetreOuverte: boolean })
  | DemandeEnvoiDeBloc
  | DemandeAutomatisme
  /** `blocDuJeton` : le suffixe du jeton, tel que le testeur l'a écrit (casse tolérée par `blocDesigne`), ou `null`. */
  | (DemandeDeBase & { type: 'lien_de_test'; waId: string; blocDuJeton: string | null })
  /** La fiche est connue : la campagne l'a lue en construisant ses destinataires, on ne la recherche pas. */
  | (DemandeDeBase & { type: 'campagne_scenario'; waId: string; contactId: string | null; firstTemplateParams?: string[] })
  | (DemandeDeBase & { type: 'campagne_bloc'; waId: string; contactId: string | null; noeudId: string })
  | DemandeRepondeur;

export interface DepsLancements {
  /** L'exécuteur du processus, celui que `buildWorkflowRuntime` construit : jamais un second exemplaire. */
  executor: Pick<WorkflowExecutor, 'demarrer'>;
  /** Le scénario, scopé espace. `null` = inconnu (supprimé, ou d'un autre espace). */
  scenarios: { getById(workflowId: string, tenantId: string): Promise<Pick<WorkflowRow, 'graph' | 'draftGraph'> | null> };
  /** La fiche du contact, pour relier le parcours à elle. Le contact existe déjà (l'entrant ou l'Inbox l'a créé). */
  contacts: { findIdByWaId(tenantId: string, waId: string): Promise<string | null> };
}

export interface Lancements {
  /**
   * Lance un scénario. `true` = parti ; une chaîne = pas parti, avec la raison exacte (fil tenu, bloc absent,
   * fenêtre, désabonnement) ; `null` = scénario inconnu, que chaque appelant traduit comme il le faisait (l'Inbox
   * et l'agent de Meta le disent, l'automation, la campagne et le lien de test rendent `false`). L'envoi d'un bloc
   * et le répondeur ne lisent aucun scénario, donc ne rendent jamais `null`.
   */
  lancer(demande: DemandeEnvoiDeBloc | DemandeRepondeur): Promise<StartOutcome>;
  lancer(demande: DemandeDeLancement): Promise<StartOutcome | null>;
}

/** Le départ que chaque type tire de sa demande. Le graphe est déjà choisi : le lien de test y cherche son bloc. */
function departDe(demande: Exclude<DemandeDeLancement, DemandeEnvoiDeBloc | DemandeRepondeur>, graphe: WorkflowGraph): DepartDuParcours {
  switch (demande.type) {
    case 'inbox':
    case 'agent_meta_scenario':
      return { depuis: 'entree', fenetreOuverte: demande.fenetreOuverte };
    case 'automatisme_ordinaire':
    case 'automatisme_chaine':
    case 'automatisme_publicite_ou_widget':
      // Vérité JS et pas `!== null`, comme le câblage d'avant : un bloc de départ vide vaut « l'entrée ».
      return demande.blocDeDepart
        ? { depuis: 'bloc', noeudId: demande.blocDeDepart }
        : { depuis: 'entree', fenetreOuverte: demande.fenetreOuverte };
    case 'lien_de_test':
      // `blocDesigne` rend l'identifiant exact du bloc, en tolérant la casse ; sinon le suffixe tel quel, que
      // `runFrom` refuse lisiblement. Pas de garde « ce bloc existe-t-il ? » ici : `runFrom` la porte déjà.
      return demande.blocDuJeton === null
        ? { depuis: 'entree' }
        : { depuis: 'bloc', noeudId: blocDesigne(graphe, demande.blocDuJeton) };
    case 'campagne_scenario':
      return { depuis: 'entree', firstTemplateParams: demande.firstTemplateParams };
    case 'campagne_bloc':
      return { depuis: 'bloc', noeudId: demande.noeudId };
  }
}

/**
 * L'entrée de lancement, construite une fois par processus par `buildWorkflowRuntime` sur SON exécuteur : l'API
 * (Inbox, relais de l'agent de Meta) et le worker (automations, lien de test, campagnes) ont donc le même. Elle lit
 * le scénario, choisit le graphe que la politique désigne, trouve la fiche et le bloc de départ, puis démarre ; les
 * réglages, l'exécuteur les tire lui-même du type.
 */
export function creerLancements(deps: DepsLancements): Lancements {
  function lancer(demande: DemandeEnvoiDeBloc | DemandeRepondeur): Promise<StartOutcome>;
  function lancer(demande: DemandeDeLancement): Promise<StartOutcome | null>;
  async function lancer(demande: DemandeDeLancement): Promise<StartOutcome | null> {
    if (demande.type === 'agent_meta_bloc') {
      return deps.executor.demarrer(demande.type, demande.tenantId, demande.workflowId, demande.graphe, demande.contact,
        { depuis: 'bloc', noeudId: demande.noeudId });
    }
    if (demande.type === 'repondeur') {
      // La ligne de scénario n'est pas lue : son graphe est vide par construction, le joué est celui de la demande.
      const contactId = await deps.contacts.findIdByWaId(demande.tenantId, demande.waId);
      return deps.executor.demarrer(demande.type, demande.tenantId, demande.workflowId, demande.graphe,
        { waId: demande.waId, contactId },
        {
          depuis: 'entree', fenetreOuverte: demande.fenetreOuverte,
          ...(demande.messageDeclencheur !== null ? { messageDeclencheur: demande.messageDeclencheur } : {}),
        });
    }
    const wf = await deps.scenarios.getById(demande.workflowId, demande.tenantId);
    if (!wf) return null;
    const graphe = POLITIQUE_DE_LANCEMENT[demande.type].graphe === 'brouillon_fige' ? grapheEditable(wf) : wf.graph;
    // La campagne connaît la fiche ; ailleurs, le contact existe déjà (l'entrant l'a créé juste avant, ou
    // l'opérateur le regarde) et on relie le parcours à elle.
    const contactId = demande.type === 'campagne_scenario' || demande.type === 'campagne_bloc'
      ? demande.contactId
      : await deps.contacts.findIdByWaId(demande.tenantId, demande.waId);
    return deps.executor.demarrer(demande.type, demande.tenantId, demande.workflowId, graphe,
      { waId: demande.waId, contactId }, departDe(demande, graphe));
  }
  return { lancer };
}
