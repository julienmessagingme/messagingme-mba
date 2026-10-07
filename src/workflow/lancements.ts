import type { WorkflowGraph } from './graph';
import type { StartOutcome, WorkflowExecutor } from './executor';
import { grapheEditable, type WorkflowRow } from './store.pg';
import { blocDesigne } from './test-token';
import type { SourceOffres } from '../offres/offre.pg';

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
  /**
   * Un agent IA lance le scénario fixé de son outil « Lancer un scénario » (RC4, `src/agent/gestes-envoi.ts`) : le
   * scénario prend la conversation et l'agent se retire. Le parcours qui portait l'agent est remplacé ici, comme par
   * tout démarrage, et sa session close en `sortie` (`sessionRemplacee: 'retiree'`).
   */
  'agent_ia_scenario',
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
  /**
   * Le scénario répondeur de l'espace (RC6, mode `scenario`, `src/repondeur/scenario.ts`) : le scénario publié choisi
   * sur l'Accueil prend le message que personne ne tient, au plus une fois par délai pour un même contact.
   */
  'repondeur_scenario',
  /**
   * Un bloc « Aller à » (RC5) mène à un bloc d'un AUTRE scénario : le parcours d'origine est clos et un parcours du
   * scénario visé démarre SUR le bloc visé. Lancé par l'exécuteur lui-même (`WorkflowExecutor.sauter`), jamais par un
   * câblage : il n'a donc pas de demande dans `DemandeDeLancement`. Depuis un chemin UNITAIRE (une réponse, un réveil,
   * un démarrage qui publie ses étiquettes).
   */
  'aller_a',
  /**
   * Le même saut, franchi pendant le démarrage d'un chemin de MASSE (une campagne, qui ne publie pas ses étiquettes) :
   * le parcours d'arrivée hérite de cette retenue. 🔴 Sans cette ligne, le saut d'une campagne de 5 000 destinataires
   * publierait 5 000 « tag ajouté », donc autant de scénarios et de messages facturés.
   */
  'aller_a_masse',
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
  /**
   * La session d'agent IA du parcours que ce démarrage REMPLACE (`runFrom` clôt tout parcours en cours du contact).
   * - `interrompue` : close en `erreur`, l'agent a été coupé par un démarrage venu d'ailleurs (le comportement d'avant
   *   RC4, pour tous les autres types).
   * - `retiree` : close en `sortie`, motif `MOTIF_SCENARIO_LANCE` : c'est l'agent IA lui-même qui a lancé ce scénario
   *   par son outil, et il s'est retiré. Seul `agent_ia_scenario`.
   * Aucune sortie du bloc agent n'est empruntée dans les deux cas : le parcours remplacé est clos, pas avancé.
   */
  sessionRemplacee: 'interrompue' | 'retiree';
  /**
   * Le gel au retour en Base (lot 6, livraison B2a, spec § 7, décision de Julien du 2026-10-07) : un espace dont l'offre
   * n'ouvre pas la fonction `scenarios` ne démarre plus de scénario du client par ce chemin.
   * - `gele` : refusé (`REFUS_SCENARIOS_HORS_OFFRE`) avant même de lire le scénario.
   * - `continue` : démarre comme avant. Les automations (le déclencheur ne laisse tirer que les plus anciennes dans la
   *   limite de l'offre, `src/automation/runner.ts`), le répondeur agent IA (un scénario système), et les sauts « Aller
   *   à », qui CONTINUENT un parcours en cours (ceux-là finissent, dit la spec).
   */
  horsOffre: 'gele' | 'continue';
}

/**
 * La raison d'un démarrage refusé par le gel : la chaîne remonte telle quelle à l'appelant (l'outil d'un agent IA, le
 * destinataire d'une campagne, le scénario répondeur qui retombe sur l'équipe).
 */
export const REFUS_SCENARIOS_HORS_OFFRE = 'offre Base : les scénarios du client ne démarrent plus (offre Pro requise)';

/**
 * Le motif d'une session d'agent IA close parce que l'agent a lancé un scénario (RC4). Écrit dans
 * `agent_sessions.sortie`, mais PAS un handle du bloc : aucune arête ne part par lui, d'où sa place ici et non dans
 * `src/agent/sorties.ts`.
 */
export const MOTIF_SCENARIO_LANCE = 'scenario_lance';

/**
 * 🔴 LA TABLE. Une ligne par type, et chaque ligne reproduit À L'IDENTIQUE ce que faisait le câblage d'avant
 * (décision de Julien du 2026-10-04) ; `tests/workflow-lancements.test.ts` l'exécute ligne par ligne sur le vrai
 * exécuteur. Changer une valeur change le comportement de chaque scénario lancé par ce chemin en production.
 */
export const POLITIQUE_DE_LANCEMENT = {
  inbox: { reprise: 'oui', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'selon_preuve', sessionRemplacee: 'interrompue', horsOffre: 'gele' },
  agent_meta_scenario: { reprise: 'oui', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'selon_preuve', sessionRemplacee: 'interrompue', horsOffre: 'gele' },
  /**
   * L'outil « Lancer un scénario » d'un agent IA (RC4) : calqué sur celui de l'agent de Meta (un contact ici et
   * maintenant, le publié, la fenêtre prouvée par la conversation en cours), et la session de l'agent qu'il remplace se
   * clôt comme un retrait, pas comme une panne. 🔴 Mais il ne reprend PAS le fil à un opérateur : un humain peut prendre
   * la main pendant que le modèle réfléchit, et le scénario lui écrirait alors par-dessus (relecture de RC4). C'est la
   * fenêtre que `run-turn` ferme en `main_perdue` pour un message écrit ; le lancement la ferme de la même façon que le
   * répondeur.
   */
  agent_ia_scenario: { reprise: 'sauf_operateur', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'selon_preuve', sessionRemplacee: 'retiree', horsOffre: 'gele' },
  agent_meta_bloc: { reprise: 'oui', publieLesEtiquettes: false, graphe: 'fourni', fenetre: 'levee', sessionRemplacee: 'interrompue', horsOffre: 'gele' },
  automatisme_ordinaire: { reprise: 'non', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'bloc_ou_preuve', sessionRemplacee: 'interrompue', horsOffre: 'continue' },
  automatisme_chaine: { reprise: 'oui', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'bloc_ou_preuve', sessionRemplacee: 'interrompue', horsOffre: 'continue' },
  automatisme_publicite_ou_widget: { reprise: 'sauf_operateur', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'bloc_ou_preuve', sessionRemplacee: 'interrompue', horsOffre: 'continue' },
  lien_de_test: { reprise: 'oui', publieLesEtiquettes: true, graphe: 'brouillon_fige', fenetre: 'levee', sessionRemplacee: 'interrompue', horsOffre: 'gele' },
  campagne_scenario: { reprise: 'oui', publieLesEtiquettes: false, graphe: 'publie', fenetre: 'gardee', sessionRemplacee: 'interrompue', horsOffre: 'gele' },
  campagne_bloc: { reprise: 'oui', publieLesEtiquettes: false, graphe: 'publie', fenetre: 'levee', sessionRemplacee: 'interrompue', horsOffre: 'gele' },
  /**
   * Le répondeur (lot 5, spec `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`) : jamais à un
   * opérateur qui tient le fil (c'est le client qui écrit, comme un clic sur une publicité) ; ses étiquettes publient
   * (un contact, ici et maintenant) ; la fenêtre est prouvée par l'entrant qui le démarre.
   */
  repondeur: { reprise: 'sauf_operateur', publieLesEtiquettes: true, graphe: 'fourni_fige', fenetre: 'selon_preuve', sessionRemplacee: 'interrompue', horsOffre: 'continue' },
  /**
   * Le scénario répondeur (RC6, plan `docs/superpowers/plans/2026-10-06-rc6-qui-repond.md`) : la politique de l'agent IA
   * répondeur, sur le graphe PUBLIÉ du scénario choisi (un contact réel ne tombe jamais dans un brouillon, et rien n'est
   * à figer : la ligne de scénario est la vraie). `sessionRemplacee: 'interrompue'` : la remise ne démarre rien quand un
   * parcours attend ce contact, donc ce qu'il remplacerait (un parcours endormi et sa session) vient d'ailleurs, et
   * s'interrompt comme pour tout démarrage.
   */
  repondeur_scenario: { reprise: 'sauf_operateur', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'selon_preuve', sessionRemplacee: 'interrompue', horsOffre: 'gele' },
  /**
   * « Aller à » vers un autre scénario (RC5, plan `docs/superpowers/plans/2026-10-06-rc5-blocs-condition-aller-a.md`) :
   * - `reprise: 'oui'` (décision du plan) : le saut CONTINUE un parcours qui avait déjà le droit d'écrire, à l'instant
   *   même ; il n'a personne à qui demander la permission, et un refus laisserait le contact sans suite.
   * - `graphe: 'publie'` : un autre scénario se lit dans sa version publiée, même depuis un test (le brouillon figé
   *   d'un lien de test ne vaut que pour SON scénario, et `walk` y suit les sauts internes).
   * - `fenetre: 'selon_preuve'` : la preuve voyage avec le saut (`DepartDuParcours` `saut`) : la même que le
   *   démarrage qui l'a franchi, l'entrant qui l'a déclenché, ou l'état réel de la fenêtre au réveil.
   * - `sessionRemplacee: 'interrompue'` : le parcours d'origine est clos AVANT le saut (son état est écrit, ou son
   *   démarrage a déjà remplacé le parcours en cours), donc le saut ne remplace jamais une session d'agent vivante qui
   *   serait la sienne. Ce qu'il remplacerait encore viendrait d'ailleurs : une interruption, comme pour tout démarrage.
   */
  aller_a: { reprise: 'oui', publieLesEtiquettes: true, graphe: 'publie', fenetre: 'selon_preuve', sessionRemplacee: 'interrompue', horsOffre: 'continue' },
  aller_a_masse: { reprise: 'oui', publieLesEtiquettes: false, graphe: 'publie', fenetre: 'selon_preuve', sessionRemplacee: 'interrompue', horsOffre: 'continue' },
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
  | { depuis: 'bloc'; noeudId: string }
  /**
   * Au bloc visé par un « Aller à » (RC5), le seul départ des types `aller_a` et `aller_a_masse`. À part de `bloc`,
   * délibérément : il porte une preuve de fenêtre (`bloc` n'en porte aucune, et la lui ajouter changerait la règle des
   * automations), le compteur de sauts sans pause (`MAX_SAUTS_SANS_PAUSE`, `src/workflow/aller-a.ts`), et le message
   * qui a déclenché le saut (inscrit comme déjà reçu, sans quoi sa redélivrance par Meta ferait avancer le parcours
   * neuf comme une réponse).
   */
  | { depuis: 'saut'; noeudId: string; fenetreOuverte: boolean; sauts: number; messageDeclencheur?: string };

/**
 * La garde de fenêtre est-elle levée pour ce lancement ? Seul endroit où la politique et le départ se croisent.
 * Un `switch` sans `default` : une règle ajoutée demain ne compile pas tant qu'elle n'a pas sa branche.
 */
export function fenetreLevee(politique: PolitiqueDeLancement, depart: DepartDuParcours): boolean {
  const prouvee = (depart.depuis === 'entree' || depart.depuis === 'saut') && depart.fenetreOuverte === true;
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
  | (DemandeDeBase & { type: 'inbox' | 'agent_meta_scenario' | 'agent_ia_scenario'; waId: string; fenetreOuverte: boolean })
  /**
   * Le scénario répondeur (RC6) : seul un message entrant le démarre, la fenêtre est donc toujours prouvée.
   * `messageDeclencheur` : le dernier message du contact, inscrit comme déjà reçu ; `null` = inconnu.
   */
  | (DemandeDeBase & { type: 'repondeur_scenario'; waId: string; fenetreOuverte: true; messageDeclencheur: string | null })
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
  /**
   * L'offre de l'espace (`OffresEnCache`, lot 6) : le gel au retour en Base (`horsOffre`). Une offre illisible se lit
   * Entreprise, donc ne gèle rien : une panne de lecture ne coupe aucun scénario.
   */
  offres: SourceOffres;
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
    case 'agent_ia_scenario':
      return { depuis: 'entree', fenetreOuverte: demande.fenetreOuverte };
    case 'repondeur_scenario':
      return {
        depuis: 'entree', fenetreOuverte: demande.fenetreOuverte,
        ...(demande.messageDeclencheur !== null ? { messageDeclencheur: demande.messageDeclencheur } : {}),
      };
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
    if (POLITIQUE_DE_LANCEMENT[demande.type].horsOffre === 'gele'
      && !(await deps.offres.offreDe(demande.tenantId)).droits.fonctions.has('scenarios')) {
      return REFUS_SCENARIOS_HORS_OFFRE;
    }
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
