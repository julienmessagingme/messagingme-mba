import { randomUUID } from 'node:crypto';
import { walk, entryNode, nextNode, nextNodeByHandle, nextNodeSansHandle, waitMode, problemeLienBouton } from './engine';
import type { WalkStep } from './engine';
import type { WorkflowAction, WalkRest, WorkflowButton, SendEmailAction, QuestionRow, LienBouton } from './engine';
import type { WorkflowGraph, WorkflowNode, WorkflowNodeType } from './graph';
import { CHAMP_MAINTENANT } from './fonction-js';
import { renderText } from '../crm/render';
import type { EvalContext } from './conditions';
import type { RunState, WorkflowRunRow, RunChannel, RunStatus } from './run-store.pg';
import type { RcsSender } from '../rcs/sender';
import type { RcsOutbound, RcsSuggestion } from '../rcs/types';
import { rcsSuggestionSchema, apercuRcsSortant } from '../rcs/schema';
import { aDesVariables, appliquerVariables } from '../rcs/variables';
import { aDesLiensTracables } from '../links/rcs-liens';
import type { AgentSessionStatus, AgentSessionStore } from '../agent/session-store';

import { BAIL_AVANCE_S, renouvelerLeBail, type GardeDuTour } from './bail-avance';
import { SORTIE_TIMEOUT } from '../agent/sorties';
import type { AgentTurnJob } from '../agent/turn-job';

/**
 * Résultat d'un démarrage : `true` = parti, une CHAÎNE = pas parti, avec la raison EXACTE. Le booléen seul
 * obligeait la campagne à afficher les trois causes possibles côte à côte, en laissant l'opérateur deviner
 * laquelle s'appliquait (vu en prod le 2026-08-15).
 */
export type StartOutcome = true | string;

/**
 * Ce que rend une dep d'envoi : `void` (parti) ou une CHAÎNE portant la raison d'un NON-envoi.
 *
 * Pourquoi ce canal existe : le refus décidé DANS le worker (carousel dont un visuel n'a pas pu être
 * re-téléversé, variable introuvable, template illisible) n'existait que dans les logs. La campagne, elle,
 * marquait le destinataire « envoyé » avec l'identifiant synthétique `wf-<id>` : succès à l'écran, rien sur
 * le téléphone (vécu trois fois en prod le 2026-08-15). La raison remonte maintenant jusqu'au destinataire.
 */
export type SendRefusal = void | string | { messageId: string };

/**
 * L'identifiant Meta d'un envoi réussi, quand la dépendance le remonte.
 *
 * Rétro-compatible À DESSEIN : `void` reste un succès (les câblages de test n'ont rien à remonter) et une
 * chaîne non vide reste un refus. Seule s'ajoute la forme `{ messageId }`, qui permet de rattacher plus tard
 * un accusé de livraison ou de lecture au BLOC qui a envoyé le message. Sans elle, « combien lus » resterait
 * immesurable par bloc : les statuts Meta ne parlent que d'un identifiant de message.
 */
export function messageIdDe(issue: SendRefusal): string | undefined {
  return typeof issue === 'object' && issue !== null && typeof issue.messageId === 'string' ? issue.messageId : undefined;
}

/**
 * LES ACTIONS QUI FONT PARTIR UN MESSAGE, et elles seules.
 *
 * 🔴 CETTE LISTE EST LA DÉFINITION DE « ENVOYER » POUR LA GARDE D'OPT-OUT. En oublier une rouvrirait le
 * trou pour ce canal-là, en silence : rien ne lèverait d'erreur, le message partirait simplement. Un test
 * la compare aux `kind` que le dispatch d'`apply` traite comme des envois.
 *
 * ⚠️ Le RCS n'y figure pas sous un nom propre : un bloc RCS est un `sendQuickMessage` que le CANAL du
 * parcours fait partir en RCS (cf. `envoyerQuickEnRcs`). Le couvrir vient donc avec `sendQuickMessage`.
 */
export const EST_UN_ENVOI: ReadonlySet<string> = new Set([
  'sendTemplate', 'sendQuickMessage', 'sendQuestion', 'sendFlow', 'sendEmail',
]);

/**
 * LE GRAPHE QUE CE PARCOURS JOUE : le sien s'il en porte un, le publié sinon.
 *
 * 🔴 UN SEUL POINT DE PASSAGE, ET C'EST TOUT L'INTÉRÊT. L'exécuteur demandait le graphe à TROIS endroits
 * (`resume`, `runEnAttenteSur`, `advance`) et recevait le publié aux trois, alors qu'un parcours de test
 * avait DÉMARRÉ sur le brouillon : il changeait donc de version en cours de route, en silence, et se figeait
 * sans un mot si son bloc courant n'existait pas dans le publié. Poser la préférence dans chacun des trois
 * serait trois endroits où l'oublier, et le quatrième point de reprise ajouté demain ne l'aurait pas.
 *
 * ⚠️ `grapheFige` À NULL EST LE CAS NORMAL, pas une exception : aucun parcours réel n'en porte, et la
 * lecture du publié reste alors exactement ce qu'elle était.
 *
 * ⚠️ Le parcours n'est lu QUE pour son graphe figé : déclarer ici son `workflowId` laisserait croire à une
 * recherche par identifiant qui n'a pas lieu, et le publié est justement ce que l'appelant va chercher.
 */
export async function grapheDuRun(
  run: { grapheFige: WorkflowGraph | null },
  lirePublie: () => Promise<WorkflowGraph | null>,
): Promise<WorkflowGraph | null> {
  return run.grapheFige ?? await lirePublie();
}

export interface WorkflowExecutorDeps {
  runs: {
    /**
     * Crée le parcours. `grapheFige` est un paramètre À PART, et pas un champ de `RunState` : il s'écrit UNE
     * SEULE FOIS, ici. Le poser dans `RunState` l'aurait rendu acceptable par les trois écritures d'état, qui
     * l'auraient silencieusement ignoré.
     */
    start(tenantId: string, workflowId: string, waId: string, contactId: string | null, state: RunState, grapheFige: WorkflowGraph | null): Promise<{ id: string }>;
    findWaitingByWaId(tenantId: string, waId: string): Promise<WorkflowRunRow | null>;
    setState(id: string, state: RunState): Promise<void>;
    /**
     * Clôt le parcours ACTIF du contact (`waiting` ou `sleeping`), et rend combien de lignes ont bougé.
     *
     * 🔴 REQUISE, JAMAIS OPTIONNELLE. C'est elle qui tient l'invariant « au plus un parcours actif par
     * contact ». Optionnelle, un câblage qui l'oublierait rendrait `undefined`, le démarrage se ferait quand
     * même, et on obtiendrait exactement le défaut qu'elle répare : deux parcours vivants, dont le plus
     * ancien invisible de `findWaitingByWaId` (qui ne rend que le plus récent) mais toujours réveillable par
     * `claimDueQuestions`. Le compilateur doit énumérer les fabriques à compléter, c'est tout son intérêt ici.
     */
    closeActiveByWaId(tenantId: string, waId: string): Promise<string[]>;
    /**
     * Écrit l'état SEULEMENT si le parcours vit encore. `false` = il a été clos entre-temps, donc l'écriture
     * l'aurait RESSUSCITÉ avec une échéance, et il aurait parlé au client depuis un scénario abandonné.
     *
     * OPTIONNELLE : absente -> `setState` inconditionnel, comportement d'avant (fixtures de test).
     */
    setStateSiVivant?(tenantId: string, id: string, state: RunState): Promise<boolean>;
    /**
     * Écriture CONDITIONNELLE : n'écrit que si le run attend TOUJOURS sur `nodeId`. `false` = il a bougé
     * entre-temps, donc quelqu'un d'autre l'a fait avancer, et notre écriture serait un retour en arrière.
     *
     * `token` clôture l'écriture par le JETON du tour : un porteur de bail périmé ne doit pas pouvoir écrire
     * par-dessus celui qui a repris le tour. `null` = aucune réservation n'a eu lieu, garde d'avant.
     *
     * OPTIONNELLE : absente -> `setState` inconditionnel, comportement d'avant (fixtures de test).
     */
    setStateSiEncoreSur?(tenantId: string, id: string, nodeId: string | null, state: RunState, token?: string | null): Promise<boolean>;
    /**
     * RÉSERVE le tour d'avance AVANT tout envoi (migration 0104). `null` = un autre traitement le tient,
     * l'appelant sort SANS RIEN FAIRE. C'est ce qui ferme le double envoi, que l'écriture conditionnelle ne
     * pouvait pas fermer puisqu'elle arrive après les envois.
     *
     * OPTIONNELLE : absente -> aucune réservation, comportement d'avant (fixtures de test, e2e).
     */
    reserverAvance?(tenantId: string, id: string, nodeId: string | null, bailSecondes: number): Promise<string | null>;
    /**
     * PROLONGE le bail tant que l'avance travaille. `false` = le tour a été repris par un autre, on cesse de
     * battre. C'est ce qui ferme la course LONGUE (le porteur lent, pas le porteur mort) : cf `bail-avance.ts`.
     *
     * OPTIONNELLE : absente -> aucun renouvellement, comportement d'avant.
     */
    prolongerAvance?(id: string, token: string, bailSecondes: number): Promise<boolean>;
    /** Rend le tour. Le jeton garantit qu'un porteur de bail périmé ne libère pas le verrou d'un autre. */
    libererAvance?(id: string, token: string): Promise<void>;
  };
  getGraph(workflowId: string, tenantId: string): Promise<WorkflowGraph | null>;
  /** Pose un tag. Renvoie idéalement `true` si le tag était RÉELLEMENT nouveau : c'est cette information qui
   *  décide d'émettre « tag ajouté » (reposer un tag déjà présent n'est pas un événement). `void` accepté
   *  (câblages/fakes qui ne le disent pas) et alors traité comme nouveau, comportement historique. */
  applyTag(tenantId: string, waId: string, tag: string): Promise<void | boolean>;
  setField(tenantId: string, waId: string, key: string, value: string): Promise<void>;
  /** Retire un tag du contact (bloc Action « retirer un tag »). */
  removeTag(tenantId: string, waId: string, tag: string): Promise<void>;
  /** Vide un champ du contact = retire la clé (bloc Action « vider un champ »). */
  clearField(tenantId: string, waId: string, key: string): Promise<void>;
  /**
   * Pose le consentement marketing du contact (bloc « Action » d'un scénario). Optionnelle : absente, le bloc
   * est un no-op silencieux plutôt qu'une erreur, comme les autres actions sur un câblage partiel.
   */
  setOptIn?(tenantId: string, waId: string, value: 'opted_in' | 'opted_out'): Promise<void>;
  /**
   * Enregistre une mesure par bloc (Analytics > Mes tableaux). Optionnelle : absente -> aucune mesure, et le
   * parcours se déroule exactement comme avant. Aucune donnée n'existait avant cette dep, donc rien ne peut
   * régresser en son absence.
   */
  recordNodeEvent?(e: {
    tenantId: string; workflowId: string; nodeId: string; waId: string;
    kind: 'sent' | 'failed' | 'reply_button' | 'reply_text'; handle?: string; metaMessageId?: string;
  }): Promise<void>;
  /**
   * `buttons` = boutons du template (pour poser un payload contrôlé sur les quick-reply : branche par bouton).
   * `explicitParams` (optionnel) = variables du corps DÉJÀ résolues (campagne workflow, 1er template) : si fourni,
   * l'envoi utilise ces valeurs directement au lieu de re-résoudre via les hints. Absent (advance/webhook) ->
   * comportement inchangé (hints stockés).
   *
   * Rendu : `void` = parti. Une CHAÎNE = RIEN n'est parti, et elle porte la raison exacte (carousel non
   * préparable, variable manquante, template illisible chez Meta). Voir `SendRefusal`.
   */
  sendTemplate(tenantId: string, waId: string, templateName: string, language: string, buttons: WorkflowButton[], explicitParams?: string[]): Promise<SendRefusal>;
  /**
   * CE CONTACT A-T-IL DEMANDÉ À NE PLUS ÊTRE CONTACTÉ ?
   *
   * 🔴 C'EST LA GARDE D'OPT-OUT DES ENVOIS QUI PASSENT PAR CET EXÉCUTEUR : le scénario et l'automation.
   *
   * ⚠️ CE TEXTE A DIT « scénario, automation ET AGENT IA », ET C'ÉTAIT FAUX. L'agent IA répond par
   * `envoyerTexteAgent`, donc par le client Meta en direct, jamais par `apply` : il porte sa PROPRE garde
   * (`src/agent/run-turn.ts`). C'est précisément ce que l'incident du 14 septembre a montré, la garde ayant
   * été posée ici en croyant couvrir les trois. La campagne et l'API publique, elles, filtrent en amont
   * (`optInAllows`), à la construction de leur liste.
   *
   * 🔴 REQUISE DEPUIS LE LOT 3 DU PLAN 2026-09-14. Elle était OPTIONNELLE « pour les câblages de test », et
   * c'était un défaut PERMISSIF : absente, rien n'était bloqué. La garde tenait donc sur un test de câblage
   * qui relisait le source, et ce test écrivait lui-même sa limite : « un inventaire prouve que la LISTE est
   * complète, jamais que les VERDICTS sont justes ». Un câblage qui l'oubliait compilait, se déployait, et
   * écrivait au contact qui avait répondu STOP. C'est arrivé deux fois en 48 heures, les 13 et 14 septembre.
   * Les tests passent désormais `jamaisDesabonne` (`tests/consentement.ts`), qui DIT leur hypothèse.
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /** Envoie un message hors template : interactif (texte + 2-3 réponses rapides, OU un bouton de lien),
   *  image légendée, ou simple texte, selon ce que porte le bloc. Atteint via `advance` (après réponse du
   *  contact) ou `startFromNode` (fenêtre vérifiée par l'appelant) : toujours EN fenêtre 24 h. */
  /** `mediaUrl` = visuel du bloc, hébergé chez nous. Le câblage le téléverse chez Meta et le pose en
   *  EN-TÊTE du message interactif (ou envoie une image légendée s'il n'y a aucun bouton).
   *
   *  `lien` = BOUTON DE LIEN, exclusif des réponses rapides (`button` et `cta_url` sont deux types de
   *  messages différents chez Meta). L'action arrive alors avec `buttons` vide. Absent = comportement
   *  d'avant, à l'identique.
   *
   *  🔴 SIXIÈME PARAMÈTRE, donc une implémentation qui n'en déclare que cinq compile ET AVALE LE LIEN EN
   *  SILENCE (le piège documenté du CLAUDE.md : une flèche à deux paramètres est assignable à un contrat qui
   *  en déclare trois). Le vrai câblage est tenu par `tests/workflow-lien-bouton.test.ts`, qui vérifie que
   *  c'est bien `sendCtaUrl` qui part, pas un faux monté pour le test. */
  sendQuickMessage(tenantId: string, waId: string, body: string, buttons: WorkflowButton[], mediaUrl?: string, lien?: LienBouton): Promise<SendRefusal>;
  /** Envoie un formulaire (message interactif type flow) hors template. Même contrainte de fenêtre 24 h que
   *  sendQuickMessage : la garde de `start` refuse un scénario qui OUVRE sur un flow/quick_message, et
   *  `startFromNode` n'est appelé qu'après vérification de la fenêtre destinataire par destinataire. */
  sendFlow(tenantId: string, waId: string, flowId: string, body: string, cta: string): Promise<SendRefusal>;
  /**
   * Envoie une QUESTION : une liste interactive WhatsApp (menu déroulant) quand `rows` porte au moins un
   * libellé, un simple texte sinon. Même contrainte de fenêtre 24 h que `sendQuickMessage`.
   *
   * ⚠️ `rows` arrive ENTIER, lignes vides comprises : le câblage filtre à l'envoi EN PRÉSERVANT l'index,
   * parce que l'index d'une ligne EST sa sortie de scénario (`row:<i>`).
   */
  sendQuestion(tenantId: string, waId: string, body: string, buttonLabel: string, rows: QuestionRow[]): Promise<SendRefusal>;
  /**
   * Envoie l'email du bloc « Envoi de mail » (résolution boîte SMTP + modèle + destinataire, rendu des
   * variables, envoi SMTP réel). Appelée en BEST-EFFORT par `apply` (try/catch autour de l'appel) : un échec
   * (boîte ou modèle supprimé, SMTP injoignable, destinataire vide) est journalisé et NE DOIT JAMAIS interrompre
   * le parcours, contrairement aux canaux WhatsApp/RCS ci-dessus qui peuvent refuser tout le run.
   *
   * Signature alignée sur les autres deps d'envoi (`tenantId, waId, action`), pas sur un `ResolvableContact`
   * déjà résolu : `apply` ne dispose que de `waId`, jamais d'un contact résolu (c'est `sendTemplate` qui
   * résout lui-même le contact dans `wiring.ts` pour ses variables ; `sendEmail` fait de même).
   *
   * OPTIONNELLE : absente, aucun envoi (no-op silencieux), comme les autres deps optionnelles de ce fichier.
   * Nécessaire pour ne pas casser les suites de tests à deps minimales (dont l'intégration Postgres) qui ne la
   * fournissent pas.
   */
  /** Rend la RAISON de l'échec (chaîne non vide) ou rien si le mail est parti. Le parcours n'en est jamais
   *  interrompu (best-effort strict), mais l'issue est MESURÉE : un bloc muet dans les deux cas laissait
   *  l'opérateur sans aucun moyen de savoir pourquoi il n'avait rien reçu (vécu le 2026-08-25). */
  sendEmail?(tenantId: string, waId: string, action: SendEmailAction): Promise<string | void>;
  /**
   * Canal RCS. ABSENT = un bloc `rcs_message` n'envoie rien et part TOUJOURS sur sa sortie « non joignable ».
   * Jamais d'envoi muet, jamais de parcours bloqué sur un canal non câblé.
   */
  rcs?: {
    sender: RcsSender;
    /** Agent RCS du tenant (`rcs_agents.agent_id`). null = tenant sans agent configuré. */
    agentIdFor(tenantId: string): Promise<string | null>;
    /**
     * Table de substitution des variables `{{champ}}` du contact. OPTIONNELLE : absente, un message part avec
     * ses accolades telles quelles, ce qui est visible tout de suite et donc préférable à un envoi bloqué.
     * Appelée SEULEMENT si le message porte au moins une variable : un bloc RCS sans variable (le cas courant)
     * ne paie aucune requête.
     */
    varsFor?(tenantId: string, waId: string): Promise<Record<string, string | null>>;
    /**
     * Journalise l'envoi RCS dans le FIL de conversation, comme le font déjà les envois WhatsApp d'un
     * scénario (`wiring.ts`). Sans elle, un message RCS parti par un scénario n'apparaissait nulle part dans
     * l'Inbox : l'opérateur voyait la réponse du contact sans jamais voir la question.
     *
     * Best-effort chez l'appelant : un échec de journal ne doit jamais faire échouer un envoi déjà parti.
     */
    recordOutbound?(tenantId: string, waId: string, msg: { body: string; messageId: string }): Promise<void>;
    /**
     * Jeton public du contact qui porte ce numéro, pour savoir QUI a cliqué sur un lien du message.
     *
     * OPTIONNELLE, et sans elle les liens partent tracés mais anonymes : c'est exactement l'état d'avant le
     * 2026-09-02. Un scénario envoie à UNE personne à la fois, donc une lecture unitaire est ici le bon
     * geste ; le chargement en un seul énoncé reste réservé au chemin de masse (les campagnes).
     */
    jetonPour?(tenantId: string, waId: string): Promise<string | null>;
  };
  /** Horloge (tests). Absente -> Date.now(). Sert à l'échéance d'un bloc Attente. */
  now?: () => number;
  /**
   * La fenêtre de service 24 h est-elle ouverte pour ce contact ? Utilisée à la REPRISE d'un parcours endormi :
   * la fenêtre court depuis le dernier message DU CONTACT, pas depuis notre dernière action, donc même une
   * attente courte peut la voir se fermer. Absente -> on considère la fenêtre fermée (fail-closed) : mieux
   * vaut ne pas envoyer que se faire refuser par Meta et compter l'envoi comme parti.
   */
  isWindowOpen?: (tenantId: string, waId: string) => Promise<boolean>;
  /**
   * REND la main à l'app sur un fil (inverse d'`escalateToHuman`). Appelé au lancement d'une campagne : c'est
   * un envoi VOULU par un opérateur, donc le scénario reprend la conduite du fil. Sans ça, le scénario
   * partirait et se bloquerait à la première réponse du contact.
   */
  /**
   * Reprend le fil pour l'app. Rend `false` quand la reprise a ÉCHOUÉ (Meta a refusé de nous rendre le fil),
   * `true` ou `void` quand elle a abouti.
   *
   * 🔴 LE BOOLÉEN A ÉTÉ AJOUTÉ LE 2026-09-14, ET IL PORTE TOUT LE CORRECTIF. Cette dépendance rendait `void`,
   * donc un échec de reprise était indiscernable d'un succès : le parcours démarrait quand même, puis se
   * faisait GELER à la première réponse du contact pendant que l'agent de Meta répondait à sa place. Un
   * démarrage qu'on sait condamné doit échouer TOUT DE SUITE, avec sa raison, plutôt que de produire un
   * parcours mort sans trace.
   *
   * ⚠️ `void` reste accepté pour les câblages qui ne savent pas le dire (tests, e2e) : traité comme un
   * succès, c'est-à-dire le comportement historique.
   */
  reclaimControl?: (tenantId: string, waId: string) => Promise<boolean | void>;
  /**
   * Le scénario a-t-il le droit d'écrire dans ce fil ? false dès qu'un opérateur (`app_human`) ou l'agent
   * de Meta (`mba`) le détient. OPTIONNEL : absent, tout est permis, ce qui préserve le comportement des
   * suites de tests qui construisent des deps minimales. En production il est toujours câblé.
   */
  mayAct?(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Construit le CONTEXTE d'évaluation d'un contact (état contact : fields/tags/opt-in/attributs + fuseau &
   * horaires du tenant + `now`) pour les blocs `condition` et le bloc `field` en mode NOW. OPTIONNEL : absent,
   * les conditions prennent la branche 'false' DÉTERMINISTE et un bloc field NOW pose une valeur vide -> préserve
   * les suites de tests à deps minimales. Renvoie null si le contact est introuvable -> même repli 'false'.
   */
  /**
   * Le contexte d'évaluation. `besoins` dit ce que le graphe réclame VRAIMENT, pour ne pas payer une lecture
   * dont personne ne se sert : la dernière saisie du contact coûte une requête, et l'immense majorité des
   * scénarios n'en a que faire. Même doctrine que `buildCtx`, qui ne construit ce contexte que si le graphe a
   * une condition ou un bloc de date.
   */
  evalContext?(tenantId: string, waId: string, besoins?: { derniereSaisie: boolean }): Promise<EvalContext | null>;
  /**
   * Le run vient d'atteindre un bloc `inbox` : la conversation passe à un humain (control_owner=app_human).
   * Sans ça, atteindre le bloc inbox n'était qu'un arrêt de run silencieux, et le badge d'inbox affichait encore
   * « le scénario répond » alors que plus rien n'avançait (trou A.5). OPTIONNEL : absent -> comportement historique.
   */
  /**
   * `assigneA` : le membre que le bloc « passer a un humain » designe, `null` = au pot commun.
   *
   * ⚠️ OPTIONNEL DANS LA SIGNATURE mais toujours passe par les appelants : un cablage qui l oublierait
   * laisserait la conversation non affectee, c est-a-dire le comportement d avant, qui ne casse rien.
   */
  escalateToHuman?(tenantId: string, waId: string, assigneA?: string | null): Promise<void>;
  /**
   * Joue un appel de la bibliothèque (Tools > Connecteurs API) pour ce contact, et rend ce qu'il faut ranger
   * dans un champ.
   *
   * 🔴 INJECTÉE, comme tout ce qui touche le réseau ici : un test de scénario ne doit pas dépendre d'un
   * serveur distant. Absente -> le bloc « Appel HTTP » ne fait RIEN et le parcours continue, exactement
   * comme un bloc mail sur une instance sans SMTP.
   *
   * `ok: false` = l'appel n'a pas abouti (connecteur inactif, variable manquante, adresse refusée, échéance).
   * L'exécuteur VIDE alors le champ cible : voir le commentaire du point d'application.
   */
  appelHttp?(tenantId: string, waId: string, requestId: string): Promise<{ ok: boolean; valeur: string }>;
  /**
   * Exécute le JavaScript d'un bloc « Fonction JS » sur une valeur, dans un bac à sable.
   *
   * 🔴 INJECTÉE, comme l'appel HTTP : elle charge un module WebAssembly, ce qu'une suite de tests de scénario
   * n'a aucune raison de payer. Absente -> le bloc ne fait RIEN et le parcours continue.
   */
  executerJs?(code: string, valeur: string, champSource?: string): Promise<{ ok: boolean; valeur: string }>;
  /**
   * Table de substitution des variables `{{champ}}` du contact, pour les messages WhatsApp d'un scénario
   * (message rapide, question).
   *
   * 🔴 LA MÊME QUE CELLE DU RCS ET DES MODÈLES D'E-MAIL (`contactVars`), et c'est le point : un client qui
   * écrit `{{prenom}}` dans un message rapide attend exactement ce qu'il obtient dans un mail ou un message
   * RCS. Trois grammaires pour la même accolade seraient trois choses à apprendre.
   *
   * ⚠️ OPTIONNELLE, et appelée SEULEMENT si le message porte au moins une accolade : un bloc sans variable
   * (le cas courant) ne paie aucune requête. Absente -> le message part avec ses accolades telles quelles,
   * ce qui se voit tout de suite et vaut mieux qu'un envoi bloqué.
   *
   * ⚠️ RIEN À VOIR avec les variables POSITIONNELLES `{{1}}` d'un template Meta, qui n'existent que parce que
   * Meta valide un gabarit. Un message rapide n'est soumis à personne.
   */
  varsFor?(tenantId: string, waId: string): Promise<Record<string, string | null>>;
  /**
   * État des conversations tenues par un bloc agent. OPTIONNEL, comme les autres deps de ce fichier : absent,
   * aucun bloc agent ne peut être servi, ce qui préserve les suites de tests à deps minimales et l'intégration.
   */
  agentSessions?: AgentSessionStore;
  /**
   * Enfile un tour d'agent. OPTIONNEL : absent -> no-op, le run reste simplement en attente sur le bloc.
   * Un tour est un appel modèle plus N appels d'outils (3 à 20 s), il ne peut donc pas se jouer dans le
   * handler de webhook, qui tiendrait la connexion Meta ouverte tout ce temps.
   */
  enqueueAgentTurn?(job: AgentTurnJob): Promise<void>;
  /**
   * L'agent de Meta est-il allumé sur le numéro de ce tenant ?
   *
   * Il décide de DEUX choses : qu'une étape sans choix cesse de bloquer le parcours (l'agent répond à la place,
   * les actions du scénario continuent), et qu'on rende le fil à Meta en fin de chaîne. ABSENT ou faux -> le
   * comportement historique est conservé au caractère près, ce qui est le cas de tous les clients aujourd'hui.
   */
  mbaActifPour?(tenantId: string): Promise<boolean>;
  /**
   * Rend le fil à l'agent de Meta (`thread_control` action `release`).
   *
   * Appelé quand le parcours se termine SANS attendre de choix du client : soit la chaîne est finie, soit le
   * contact a répondu à côté des boutons attendus. Dans les deux cas plus personne n'attend une réponse précise,
   * donc l'agent doit reprendre la parole.
   *
   * ⚠️ HYPOTHÈSE 1 du plan, invérifiable tant que MBA ne peut pas être allumé : tout envoi prend le contrôle du
   * fil, template compris. On relâche donc systématiquement. Si c'est faux pour les templates, on relâchera dans
   * le vide : une erreur journalisée, aucun dégât. Le pari inverse aurait laissé l'agent muet sur tous les
   * destinataires d'une campagne sans que personne le voie.
   *
   * ⚠️ Le message hors script qu'on vient de recevoir n'a PAS besoin d'un traitement particulier : « non lu » est
   * DÉRIVÉ en base (un entrant plus récent que la dernière ouverture du fil), donc il apparaît déjà dans l'Inbox.
   * C'était le repli prévu au plan, il existait déjà.
   *
   * ABSENT -> aucun release. Best-effort : un échec ne fait jamais échouer un parcours.
   */
  releaseToMba?(tenantId: string, waId: string): Promise<void>;
  /**
   * TRANSMET À L'AGENT DE META le message « à côté » du client, une fois le fil rendu (spec
   * 2026-09-21-outils-maison-mba, § 5) : sans lui, l'agent ne parlerait qu'au message SUIVANT du client, et la
   * question qu'il vient de poser resterait sans réponse. Appelée SEULEMENT par la branche « il a écrit » d'`advance`,
   * et seulement sur un vrai message WhatsApp : une fin normale n'a rien à transmettre, un bouton sans suite va à un
   * humain, et une réaction ou un rapport RCS ne sont pas des messages. `messageId` désigne le message à transmettre.
   *
   * ABSENT -> rien n'est transmis. Best-effort, comme le release : un échec ne fait jamais échouer un parcours.
   */
  transmettreHorsParcours?(tenantId: string, waId: string, messageId: string): Promise<void>;
  /**
   * Publie « ce tag vient d'être posé » pour les automations. Appelée UNIQUEMENT sur un démarrage unitaire
   * (réponse d'un contact, automation, test), jamais depuis une campagne : voir la note de `apply`.
   * Absente -> aucune publication (rétro-compatible).
   */
  emitTagAdded?(tenantId: string, waId: string, tag: string): Promise<void>;
}

/** Message RCS porté par un bloc. null = bloc NON configuré : on ne devine pas un contenu, on part en repli. */
function rcsOutboundOf(node: WorkflowNode | undefined): RcsOutbound | null {
  if (!node) return null;
  const text = String(node.data.text ?? '').trim();
  if (!text) return null;
  // Les boutons du bloc passent par le MÊME schéma que la bibliothèque et l'assistant de campagne. Un bouton
  // malformé (lien sans URL, libellé vide) est ÉCARTÉ ici plutôt qu'envoyé au provider qui le refuserait :
  // le message part quand même, amputé de ce bouton, au lieu de ne pas partir du tout.
  const boutons = Array.isArray(node.data.suggestions)
    ? node.data.suggestions.map((b) => rcsSuggestionSchema.safeParse(b)).filter((r) => r.success).map((r) => r.data)
    : [];
  // Visuel d'en-tête -> le message devient une CARTE, exactement comme dans la bibliothèque (`web/lib/rcs.ts`
  // fait la même bascule côté écran, `MAX_BOUTONS_CARTE` y porte la même limite de 4).
  //
  // 🔴 Et les boutons partent DANS la carte, ce qui décide de leur APPARENCE sur le téléphone : dans la carte
  // ils s'affichent en boutons pleine largeur empilés, sous le message ils s'affichent en petites pastilles
  // en ligne. Au-delà de quatre, le surplus retombe en pastilles plutôt que d'être perdu.
  const image = String(node.data.imageUrl ?? '').trim();
  if (image !== '') {
    const dansLaCarte = boutons.slice(0, 4);
    const enPastilles = boutons.slice(4);
    return {
      kind: 'card',
      card: {
        description: text,
        mediaUrl: image,
        mediaHeight: 'TALL',
        ...(dansLaCarte.length ? { suggestions: dansLaCarte } : {}),
      },
      ...(enPastilles.length ? { suggestions: enPastilles } : {}),
    };
  }
  return { kind: 'text', text, ...(boutons.length ? { suggestions: boutons } : {}) };
}

/** Anti-boucle de `walkResolved` : une chaîne de blocs RCS tous non joignables finit par s'arrêter. Le walk
 *  a déjà son propre `visited` par appel, ce plafond borne l'ENCHAÎNEMENT de walks. */
const MAX_RCS_ENCHAINES = 20;

export function restToState(rest: WalkRest, now: number): RunState {
  if (rest.status === 'waiting') {
    // Bloc QUESTION à échéance : le run reste `waiting`, parce qu'une réponse du contact doit pouvoir le
    // reprendre et que `findWaitingByWaId` ne voit QUE les runs `waiting`. Il porte EN PLUS un `resume_at`,
    // que le balayeur de réveil récupère à l'échéance. C'est le seul état du produit qui attend les deux.
    if (rest.timeoutInMs !== undefined) {
      return { currentNode: rest.nodeId, status: 'waiting', resumeAt: new Date(now + rest.timeoutInMs) };
    }
    return { currentNode: rest.nodeId, status: 'waiting' };
  }
  // Sommeil : on garde le bloc Attente comme position courante et on pose l'échéance. Le réveil repart de SON
  // successeur (le bloc Attente lui-même a déjà « joué », le repasser rendormirait le parcours en boucle).
  if (rest.status === 'sleeping') return { currentNode: rest.nodeId, status: 'sleeping', resumeAt: new Date(now + rest.resumeInMs) };
  if (rest.status === 'inbox') return { currentNode: null, status: 'inbox' };
  // Bloc AGENT : le run ATTEND sur le bloc agent, c'est ce qui permet à `findWaitingByWaId` de retrouver le
  // parcours au message suivant du contact. Cas EXPLICITE, parce que le `return` final ci-dessous avale tout
  // le reste en `done` : sans lui, le parcours serait clos en silence pile au moment où l'agent prend la main.
  if (rest.status === 'agent_turn') return { currentNode: rest.nodeId, status: 'waiting' };
  return { currentNode: null, status: 'done' };
}

/**
 * Orchestre l'exécution d'un workflow (applique les actions du moteur PUR + persiste l'état du run). IO
 * injectée (contact store, envoi Meta, run store) -> testable sans DB/réseau. `start` : démarre un run pour
 * un contact (PB3 : lancé par une campagne). `advance` : fait avancer le run en attente quand le contact
 * répond (branché sur le webhook). Idempotent par message (dédup at-least-once).
 */
export class WorkflowExecutor {
  constructor(private readonly deps: WorkflowExecutorDeps) {}

  /** Horloge injectable (tests). Sert au calcul de l'échéance d'un bloc Attente. */
  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Construit le contexte d'évaluation UNIQUEMENT si le graphe en a besoin (au moins un node `condition` ou un
   * bloc `field` en mode NOW) : évite 2 requêtes DB par étape pour les scénarios tag/template purs (l'immense
   * majorité, qui n'ont jamais de condition). Une erreur de `evalContext` (timeout pool, réseau Supabase) est
   * ABSORBÉE -> ctx undefined -> conditions 'false' (fail-closed) : un scénario qui n'utilise PAS la fonctionnalité
   * n'est jamais bloqué par une panne de sa plomberie.
   */
  private async buildCtx(tenantId: string, waId: string, graph: WorkflowGraph): Promise<EvalContext | undefined> {
    if (!this.deps.evalContext) return undefined;
    // Les valeurs DYNAMIQUES d'un bloc « poser un champ » : `maintenant` et `derniere_saisie`. Une valeur
    // fixe n'a besoin d'aucun contexte, donc d'aucune requête.
    const valeurDynamique = (n: { type: string; data: Record<string, unknown> }): string | null => {
      const dyn = n.data.valueKind === 'now' || n.data.valueKind === 'derniere_saisie';
      if (n.type === 'field' && dyn) return String(n.data.valueKind);
      if (n.type === 'action' && n.data.actionKind === 'set_field' && dyn) return String(n.data.valueKind);
      return null;
    };
    // 🔴 UN BLOC ATTENTE DATÉ EN A BESOIN AUSSI, et l'oublier ne casse rien de visible : `waitResumeInMs`
    // rend alors 0, le bloc devient un passe-plat, et « attendre jusqu'aux prochaines heures ouvrées »
    // envoie à 1 h du matin, silencieusement. C'est la seule ligne qui l'empêche.
    const needsCtx = graph.nodes.some((n) => n.type === 'condition' || valeurDynamique(n) !== null
      || (n.type === 'wait' && waitMode(n) !== 'delai'));
    if (!needsCtx) return undefined;
    // Une requête de plus SEULEMENT si un bloc réclame la dernière saisie. Sans ce tri, tout scénario portant
    // une condition la paierait, alors que presque aucun ne s'en sert.
    const derniereSaisie = graph.nodes.some((n) => valeurDynamique(n) === 'derniere_saisie');
    try {
      return (await this.deps.evalContext(tenantId, waId, { derniereSaisie })) ?? undefined;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`workflow: evalContext a échoué pour ${waId}, conditions -> 'false' (fail-closed)`, err);
      return undefined;
    }
  }

  /**
   * Applique les actions d'un parcours. `emitEvents` = ce démarrage est-il UNITAIRE (un contact, ici et
   * maintenant) ? Seuls ces chemins publient les événements d'automation (« tag ajouté »).
   *
   * ⚠️ Pourquoi ce n'est PAS la dep `applyTag` qui publie : le même exécuteur sert les CAMPAGNES. Une campagne
   * workflow sur 5 000 destinataires dont le graphe contient un bloc Action poserait 5 000 événements, donc
   * potentiellement 5 000 scénarios et autant de messages facturés que personne n'a demandés. Le défaut est
   * donc `false` : on n'émet que si l'appelant prouve qu'il est unitaire.
   *
   * `firstTemplateParams` (optionnel) : variables du corps déjà résolues, transmises à l'envoi de template. Un
   * `walk` depuis un seul point d'entrée s'arrête au 1er bloc template/flow (bloquant) -> il produit AU PLUS une
   * action `sendTemplate`, donc ces params ne s'appliquent qu'à ce 1er envoi (jamais à un template ultérieur).
   */
  /**
   * Un « message rapide » envoyé SUR LE CANAL RCS.
   *
   * 🔴 C'est le cœur du multicanal. Un message rapide est un texte avec des réponses en un tap : WhatsApp sait
   * le faire, le RCS aussi. Le bloc ne dit donc PAS le canal, il dit l'intention ; c'est le parcours qui porte
   * le canal. Sans ça, un message rapide branché derrière un bloc RCS partait en WhatsApp vers un contact qui
   * n'y avait jamais écrit, et Meta le refusait (fenêtre de 24 h).
   *
   * Les libellés deviennent des boutons RÉPONSE, dans le même ordre : c'est ce qui fait que le clic revient sur
   * la bonne sortie du bloc (`btn:<i>`, comme côté WhatsApp).
   */
  private async envoyerQuickEnRcs(
    tenantId: string,
    waId: string,
    a: { body: string; buttons: WorkflowButton[]; mediaUrl?: string; lien?: LienBouton },
  ): Promise<SendRefusal> {
    const rcs = this.deps.rcs;
    if (!rcs) return 'canal RCS non câblé sur ce serveur';
    const agentId = await rcs.agentIdFor(tenantId);
    if (!agentId) return "le canal RCS n'est pas activé sur cet espace";
    // 🔴 LE BOUTON DE LIEN A UN ÉQUIVALENT RCS NATIF (`openUrl`), et l'ignorer aurait fait partir le message
    // SANS son bouton sur un parcours RCS, en silence. C'est la même faute que le visuel perdu qu'on a
    // fermée juste en dessous. Le libellé est borné à 20 comme côté WhatsApp (le RCS en accepte 25 : garder
    // la borne la plus stricte fait qu'un même bloc part à l'identique sur les deux canaux).
    //
    // ⚠️ `postbackData` hors de l'espace `btn:<i>` : ces sorties-là sont celles des réponses rapides, et un
    // clic sur un lien ne doit correspondre à aucune branche du scénario.
    const probleme = a.lien ? problemeLienBouton(a.lien) : null;
    if (probleme) return probleme;
    const suggestions: RcsSuggestion[] = a.lien
      ? [{ kind: 'openUrl' as const, text: a.lien.texte.trim().slice(0, 20), url: a.lien.url.trim(), postbackData: 'lien' }]
      : a.buttons
        .filter((b) => b.type === 'QUICK_REPLY' && b.text.trim() !== '')
        .slice(0, 11)
        .map((b, i) => ({ kind: 'reply' as const, text: b.text.trim(), postbackData: `btn:${i}` }));
    // 🔴 Un visuel change la FORME du message RCS : le texte nu n'en porte pas, il faut une carte. Sans
    // ça, un bloc à visuel partirait en texte sur un parcours RCS et l'image disparaîtrait en silence, ce qui
    // est exactement le défaut qu'on vient de fermer ailleurs. Les boutons restent SOUS le message (11 max,
    // comme aujourd'hui) plutôt que dans la carte (4 max) : même rendu qu'avant pour les montages existants.
    const brut: RcsOutbound = a.mediaUrl
      ? { kind: 'card', card: { description: a.body, mediaUrl: a.mediaUrl }, ...(suggestions.length ? { suggestions } : {}) }
      : { kind: 'text', text: a.body, ...(suggestions.length ? { suggestions } : {}) };
    // Variables résolues comme pour un bloc RCS : le contact doit lire son prénom, pas des accolades.
    const msg = rcs.varsFor && aDesVariables(brut) ? appliquerVariables(brut, await rcs.varsFor(tenantId, waId)) : brut;
    const out = await rcs.sender.sendTo(tenantId, agentId, waId, msg, randomUUID(), await this.jetonRcs(tenantId, waId, msg));
    if (!('skipped' in out)) await this.journaliserRcs(tenantId, waId, msg, out.messageId);
    if ('skipped' in out) {
      return out.skipped === 'rcs_optout'
        ? 'le contact s’est désabonné du RCS'
        : "le contact n'est pas joignable en RCS";
    }
    return { messageId: out.messageId };
  }

  /**
   * Écrit l'envoi RCS dans le fil de conversation. Best-effort STRICT : le message est DÉJÀ parti chez
   * l'opérateur télécom quand on arrive ici, un incident de journal ne doit donc jamais le faire passer pour
   * un échec.
   */
  /**
   * Le jeton public du destinataire, pour attribuer les clics des liens de CE message.
   *
   * Lu SEULEMENT si le message porte un lien traçable : un bloc RCS sans lien, qui est le cas courant, ne
   * paie aucune requête, et surtout on ne fabrique pas d'identifiant public pour quelqu'un à qui on n'envoie
   * rien à cliquer. Best-effort : un échec de lecture rend un lien anonyme, jamais un envoi raté.
   */
  private async jetonRcs(tenantId: string, waId: string, msg: RcsOutbound): Promise<string | undefined> {
    const lire = this.deps.rcs?.jetonPour;
    if (!lire || !aDesLiensTracables(msg)) return undefined;
    return (await lire(tenantId, waId).catch(() => null)) ?? undefined;
  }

  private async journaliserRcs(tenantId: string, waId: string, msg: RcsOutbound, messageId: string): Promise<void> {
    if (!this.deps.rcs?.recordOutbound) return;
    try {
      await this.deps.rcs.recordOutbound(tenantId, waId, { body: apercuRcsSortant(msg), messageId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`journal du message RCS ignoré pour ${waId}:`, err instanceof Error ? err.message : err);
    }
  }

  private async apply(
    tenantId: string,
    waId: string,
    steps: WalkStep[],
    firstTemplateParams?: string[],
    emitEvents = false,
    workflowId?: string,
    /** Canal courant du parcours. Décide où part un message rapide, et évolue avec les envois. */
    canalEntrant: RunChannel = 'whatsapp',
    /**
     * 🔴 LE TOUR EST-IL ENCORE À NOUS ? Posée avant CHAQUE effet, pas une fois à l'entrée (lot A2 du plan du
     * 2026-09-02). Une liste d'effets peut durer plusieurs minutes : vérifier au départ ne dit rien de ce qui
     * est vrai au dixième envoi. Absente pour les chemins qui ne réservent pas de tour (`start`, `runFrom`).
     */
    garde?: GardeDuTour,
  ): Promise<{ refus: string | null; partis: number; canal: RunChannel }> {
    let canal: RunChannel = canalEntrant;
    const posedTags: string[] = [];
    // Un walk peut produire PLUSIEURS envois depuis qu'un message rapide sans bouton ne bloque plus (« message,
    // message, template »). On retient donc la PREMIÈRE raison de refus, et on compte ce qui est réellement
    // parti : un refus n'est décisif pour l'appelant que si RIEN n'est parti.
    let refus: string | null = null;
    let partis = 0;
    /** Réponse de la garde d'opt-out, lue au plus une fois par liste d'effets. `null` = pas encore posée. */
    let desabonne: boolean | null = null;
    for (const { nodeId, action: a } of steps) {
      // 🔴 On s'ARRÊTE si le tour n'est plus à nous, et on s'arrête ICI, entre deux effets. Le jeton clôture
      // l'écriture d'état, il n'a jamais rien pu contre un message déjà remis à Meta : sans ce point de
      // contrôle, un porteur déchu finissait tranquillement sa liste d'envois pendant que le nouveau porteur
      // faisait la sienne, et le contact recevait les deux. C'est exactement le trou que le battement du lot 1
      // avait rendu VISIBLE sans le fermer.
      const perdu = garde?.perduPourquoi() ?? null;
      if (perdu !== null) {
        // eslint-disable-next-line no-console
        console.warn(`workflow ${workflowId ?? '?'}: effets INTERROMPUS pour ${waId} au bloc ${nodeId} (${perdu}), ${partis} envoi(s) déjà partis`);
        refus ??= `tour perdu pendant les effets (${perdu})`;
        break;
      }
      /**
       * 🔴 UN CONTACT DÉSABONNÉ NE REÇOIT AUCUN ENVOI AUTOMATIQUE, et c'est vérifié ICI parce que c'est le
       * seul endroit que le scénario, l'automation et l'agent IA traversent tous les trois.
       *
       * ⚠️ ON SAUTE L'ENVOI, ON N'ARRÊTE PAS LE PARCOURS. Un scénario qui pose un tag « a dit stop » ou qui
       * range une information doit continuer à le faire : ce qu'on refuse est de lui PARLER, pas de tenir
       * sa fiche à jour. D'où `continue` et non `break`.
       *
       * ⚠️ LU UNE SEULE FOIS PAR LISTE D'EFFETS : un parcours peut enchaîner plusieurs envois, et poser la
       * question à chacun paierait une requête par message pour une réponse qui ne change pas pendant ces
       * quelques secondes.
       */
      if (EST_UN_ENVOI.has(a.kind)) {
        desabonne ??= await this.deps.estDesabonne(tenantId, waId);
        if (desabonne) {
          refus ??= 'contact désabonné : il a demandé à ne plus recevoir de messages';
          await this.mesurer(tenantId, workflowId, nodeId, waId, 'failed');
          continue;
        }
      }
      if (a.kind === 'tag') {
        const nouveau = await this.deps.applyTag(tenantId, waId, a.tag);
        // `false` = le contact portait déjà ce tag : rien n'a changé, donc rien à annoncer.
        if (nouveau !== false) posedTags.push(a.tag);
      }
      else if (a.kind === 'removeTag') await this.deps.removeTag(tenantId, waId, a.tag);
      else if (a.kind === 'field') await this.deps.setField(tenantId, waId, a.key, a.value);
      /**
       * 🔴 UN ÉCHEC VIDE LE CHAMP, il ne le laisse PAS tel quel. C'est la seule façon de rendre le bloc
       * utilisable dans un scénario : la suite branche une condition sur ce champ, et un reste de la veille
       * ferait prendre la bonne branche pour de mauvaises raisons, sans que rien ne le signale. Un champ vide
       * se teste (« si le champ est vide »), une valeur périmée ne se distingue de rien.
       *
       * ⚠️ BEST-EFFORT, comme l'envoi de mail : un connecteur en panne ne doit pas arrêter le parcours du
       * contact. L'échec est journalisé côté câblage, là où l'on sait ce qui a échoué.
       */
      else if (a.kind === 'appelHttp') {
        // 🔴 LE TEST DU `kind` D'ABORD, LA DÉPENDANCE ENSUITE, et le compilateur l'a prouvé nécessaire :
        // écrit `a.kind === 'appelHttp' && this.deps.appelHttp`, un appel HTTP sur une instance sans ce
        // câblage TOMBAIT DANS LA BRANCHE SUIVANTE et finissait par être traité comme un envoi de TEMPLATE.
        // Même forme que `sendEmail` juste en dessous, pour la même raison.
        if (this.deps.appelHttp) {
          const r = await this.deps.appelHttp(tenantId, waId, a.requestId);
          await this.deps.setField(tenantId, waId, a.champCible, r.ok ? r.valeur : '');
        }
      }
      /**
       * 🔴 LA VALEUR D'ENTRÉE EST RELUE ICI, pas prise au walk. C'est ce qui fait marcher l'enchaînement que
       * le client va écrire en premier : « Appel API » qui range une réponse dans un champ, puis « Fonction
       * JS » qui la transforme. Une photo prise au walk servirait la valeur d'AVANT l'appel.
       *
       * ⚠️ Un champ source ABSENT donne une chaîne vide, pas un refus : la fonction du client décide alors
       * quoi en faire, ce qu'elle est mieux placée que nous pour savoir.
       *
       * Même doctrine d'échec que le bloc « Appel API » : le champ cible est VIDÉ, jamais laissé tel quel.
       */
      else if (a.kind === 'fonctionJs') {
        if (this.deps.executerJs) {
          /**
           * 🔴 `now` EST L'INSTANT DU PASSAGE, ET IL NE VIENT PAS DE LA FICHE. Demandé par Julien le
           * 2026-09-14 : « dans la liste des champs à transformer, il faut qu'on puisse transformer aussi
           * le NOW, c'est l'heure et la date du bot au moment où on passe sur le node ». Aucun champ de
           * contact ne peut porter ça : la valeur change à chaque passage, et l'écrire sur la fiche pour
           * la relire aussitôt créerait une donnée que personne n'a demandée.
           *
           * ⚠️ EN ISO UTC, parce que c'est la seule forme que `new Date(valeur)` relit sans ambiguïté dans
           * le bac à sable. Mettre en forme est justement le travail que ce bloc existe pour faire.
           */
          // ⚠️ Le contexte n'est lu QUE pour un vrai champ : « maintenant » ne touche pas la base.
          const evalCtxFields = a.champSource === CHAMP_MAINTENANT || !this.deps.evalContext
            ? null
            : (await this.deps.evalContext(tenantId, waId))?.fields;
          const entree = a.champSource === CHAMP_MAINTENANT
            ? new Date().toISOString()
            : (() => {
              const brut = evalCtxFields?.[a.champSource];
              return brut === null || brut === undefined ? '' : String(brut);
            })();
          const r = await this.deps.executerJs(a.code, entree, a.champSource);
          await this.deps.setField(tenantId, waId, a.champCible, r.ok ? r.valeur : '');
        }
      }
      else if (a.kind === 'clearField') await this.deps.clearField(tenantId, waId, a.key);
      else if (a.kind === 'optIn') await this.deps.setOptIn?.(tenantId, waId, a.value);
      // Best-effort STRICT (contrairement aux canaux WhatsApp/RCS ci-dessous, qui peuvent refuser tout le run) :
      // un envoi email raté (boîte/modèle supprimé, SMTP injoignable, destinataire vide) est journalisé mais ne
      // doit JAMAIS arrêter le parcours ni compter comme un refus. `sendEmail` absente (deps minimales de test,
      // dont l'intégration Postgres) -> no-op silencieux via l'optional chaining, même contrat qu'une dep
      // optionnelle non câblée ailleurs dans ce fichier (ex. `setOptIn` ci-dessus).
      else if (a.kind === 'sendEmail') {
        // Dep absente (suites à deps minimales) : no-op TOTAL, on ne mesure rien non plus. Mesurer ici
        // inventerait un « envoyé » pour un câblage qui n'existe pas.
        if (this.deps.sendEmail) {
          let echec: string | null = null;
          try {
            const dit = await this.deps.sendEmail(tenantId, waId, a);
            if (typeof dit === 'string' && dit !== '') echec = dit;
          } catch (err) {
            echec = err instanceof Error ? err.message : String(err);
          }
          if (echec !== null) {
            // eslint-disable-next-line no-console
            console.error(`workflow sendEmail: ${echec} (${waId}), on continue le parcours`);
          }
          // Best-effort STRICT conservé : un mail raté ne devient JAMAIS un refus du parcours. Mais il ne
          // disparaît plus : il se MESURE comme tout autre bloc de message, « envoyé » ou « échec ».
          await this.mesurer(tenantId, workflowId, nodeId, waId, echec === null ? 'sent' : 'failed');
        }
      }
      else {
        /**
         * 🔴 LES VARIABLES `{{champ}}` DU CONTACT, résolues ICI et pour les deux blocs WhatsApp qui portent un
         * corps libre (message rapide, question). C'est la MÊME grammaire et la MÊME table que le RCS et les
         * modèles d'e-mail (`contactVars`) : un client qui écrit `{{prenom}}` attend la même chose partout, et
         * trois grammaires pour la même accolade seraient trois choses à apprendre.
         *
         * ⚠️ LA FICHE N'EST LUE QUE SI LE MESSAGE EN PORTE : un bloc sans variable, qui est le cas courant, ne
         * paie aucune requête. Même optimisation que le chemin RCS juste au-dessus.
         *
         * ⚠️ SEUL LE CORPS est substitué, pas les libellés de boutons : vingt caractères chez Meta, un prénom
         * un peu long ferait refuser le message ENTIER pour un gain nul. C'est la règle déjà posée côté RCS,
         * et la tenir identique est ce qui la rend explicable.
         */
        const corpsAvecVariables = async (texte: string): Promise<string> => {
          if (!this.deps.varsFor || !/\{\{\s*[\w.-]+\s*\}\}/.test(texte)) return texte;
          return renderText(texte, await this.deps.varsFor(tenantId, waId), { html: false });
        };
        // ⚠️ Jamais `refus ??= await …` : `??=` n'évalue pas sa droite quand la gauche est déjà remplie, donc
        // l'envoi lui-même serait SAUTÉ. On envoie toujours, on ne garde que la 1re raison.
        const dit = a.kind === 'sendQuickMessage'
          // Le canal du PARCOURS décide, pas le type du bloc. Voir `envoyerQuickEnRcs`.
          ? (canal === 'rcs'
            ? await this.envoyerQuickEnRcs(tenantId, waId, a)
            : await this.deps.sendQuickMessage(tenantId, waId, await corpsAvecVariables(a.body), a.buttons, a.mediaUrl, a.lien))
          // Une QUESTION part toujours en WhatsApp : la liste interactive n'a aucun équivalent RCS, et le
          // bloc est réservé à ce canal (décision de Julien du 2026-08-26). Pas de branche `canal === 'rcs'`
          // ici : elle promettrait un repli qui n'existe pas.
          : a.kind === 'sendQuestion'
            ? await this.deps.sendQuestion(tenantId, waId, await corpsAvecVariables(a.body), a.buttonLabel, a.rows)
            : a.kind === 'sendFlow'
              ? await this.deps.sendFlow(tenantId, waId, a.flowId, a.body, a.cta)
              : await this.deps.sendTemplate(tenantId, waId, a.templateName, a.language, a.buttons, firstTemplateParams);
        const rate = typeof dit === 'string' && dit !== '';
        // Un TEMPLATE (comme un formulaire) est WhatsApp par nature : le poser ramène volontairement le
        // parcours sur WhatsApp. C'est ainsi qu'on BASCULE de canal, en branchant un template après un RCS.
        //
        // 🔴 Une QUESTION aussi, et l'oublier gelait le parcours EN SILENCE : la liste part par WhatsApp quel
        // que soit le canal courant (le RCS n'a pas de liste), mais le run restait marqué `rcs`. La réponse
        // du contact arrivait alors par WhatsApp, la garde d'étanchéité la trouvait sur le mauvais canal et
        // l'ignorait. Le contact répondait, personne ne recevait rien.
        if (!rate && (a.kind === 'sendTemplate' || a.kind === 'sendFlow' || a.kind === 'sendQuestion')) canal = 'whatsapp';
        if (rate) {
          if (refus === null) refus = dit;
        } else {
          partis += 1;
        }
        // Mesure par bloc (Analytics > Mes tableaux). APRÈS l'envoi, sur son issue réelle : compter avant
        // gonflerait les « envoyés » de tout ce que Meta a refusé. L'identifiant du message, quand la
        // dépendance le remonte, est ce qui permettra à un accusé de lecture de retrouver ce bloc.
        await this.mesurer(tenantId, workflowId, nodeId, waId, rate ? 'failed' : 'sent', undefined, messageIdDe(dit));
      }
    }
    // Publication APRÈS toutes les actions, et seulement sur un chemin unitaire. Best-effort : la pose du tag
    // est acquise, un incident de file ne doit pas faire échouer le parcours en cours.
    if (emitEvents && posedTags.length > 0 && this.deps.emitTagAdded) {
      for (const tag of posedTags) {
        try { await this.deps.emitTagAdded(tenantId, waId, tag); } catch { /* best-effort */ }
      }
    }
    return { refus, partis, canal };
  }

  /**
   * Enregistre une mesure par bloc, si le câblage la fournit et si l'on sait de quel scénario il s'agit.
   *
   * BEST-EFFORT ABSOLU : une panne d'écriture de mesure ne doit jamais faire échouer un parcours ni renvoyer
   * un job en file d'échec. Un tableau de bord incomplet est un désagrément ; un message qui ne part pas
   * parce qu'un compteur a trébuché est un incident.
   */
  private async mesurer(
    tenantId: string,
    workflowId: string | undefined,
    nodeId: string,
    waId: string,
    kind: 'sent' | 'failed' | 'reply_button' | 'reply_text',
    handle?: string,
    metaMessageId?: string,
  ): Promise<void> {
    if (!this.deps.recordNodeEvent || !workflowId) return;
    try {
      await this.deps.recordNodeEvent({
        tenantId, workflowId, nodeId, waId, kind,
        ...(handle ? { handle } : {}),
        ...(metaMessageId ? { metaMessageId } : {}),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('mesure de bloc ignorée (best-effort):', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Réveille un parcours endormi (bloc Attente arrivé à échéance) et reprend au bloc SUIVANT.
   *
   * Gardes, dans l'ordre du code :
   *  1) `mayAct` : pendant le sommeil, un opérateur ou MBA a pu reprendre le fil. On ne lui écrit pas dessus.
   *  2) le graphe et le bloc suivant existent encore (scénario ou bloc supprimé pendant le sommeil) : c'est
   *     `nextNode` qui rend null, et on clôt le run plutôt que de le laisser dormant.
   *  3) la FENÊTRE de service, seulement si la suite envoie un message de SESSION : elle court depuis le
   *     dernier message DU CONTACT, donc on la RELIT (une attente courte peut la voir fermée, une longue peut
   *     la voir rouverte si le contact a écrit entre-temps). Fermée -> on n'envoie pas et on remonte à un
   *     humain, plutôt que de compter un envoi fantôme. Un TEMPLATE part hors fenêtre, il n'est pas concerné.
   *
   * Rendu : true si le parcours a repris, false s'il a été arrêté (le run est alors clos ou remonté en inbox,
   * jamais laissé dormant, sinon il serait repris à chaque balayage).
   */
  async resume(run: {
    id: string; workflowId: string; tenantId: string; waId: string;
    contactId?: string | null; currentNode: string | null;
    /**
     * Le graphe figé du parcours, `null` pour tout parcours réel. REQUIS et non optionnel : c'est ce qui
     * oblige le balayage des parcours endormis à le transporter jusqu'ici. Optionnel, un réveil l'aurait
     * perdu en silence et la reprise serait retombée sur le publié, c'est-à-dire sur le défaut réparé.
     */
    grapheFige: WorkflowGraph | null;
    /** Canal courant du parcours. Absent -> WhatsApp (runs d'avant la migration 0082). */
    channel?: RunChannel;
    /**
     * Pourquoi ce run était en repos, et donc par où le reprendre.
     *
     * `sleeping` = bloc Attente arrivé à échéance, on reprend au bloc SUIVANT (comportement historique).
     * `waiting` = bloc QUESTION dont le délai « pas de réponse » a expiré, on sort par la sortie `timeout`.
     * Absent -> `sleeping`, pour que tout appelant écrit avant le bloc Question garde son comportement.
     */
    status?: RunStatus;
  }): Promise<boolean> {
    const { tenantId, waId } = run;
    if (this.deps.mayAct && !(await this.deps.mayAct(tenantId, waId))) {
      // eslint-disable-next-line no-console
      console.log(`workflow ${run.workflowId}: fil repris par un humain ou par MBA pendant l'attente, reprise annulée pour ${waId}`);
      await this.cloreSessionDuRun(tenantId, run.id, 'erreur');
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'done' });
      return false;
    }
    const graph = await grapheDuRun(run, () => this.deps.getGraph(run.workflowId, tenantId));
    if (!graph || !run.currentNode) {
      await this.cloreSessionDuRun(tenantId, run.id, 'erreur');
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'done' });
      return false;
    }
    // D'où repartir dépend de CE QUI a expiré.
    //
    // Bloc Attente : le SUCCESSEUR (repasser sur l'attente elle-même rendormirait le parcours).
    //
    // Bloc QUESTION : la sortie `timeout`, et elle seule. Le « successeur » d'une question n'a aucun sens,
    // c'est la RÉPONSE qui décide de la suite. Prendre `nextNode` ici enverrait un contact silencieux dans la
    // branche du premier câblage venu, exactement le défaut que `nextNodeSansHandle` évite déjà ailleurs.
    const parQuestion = run.status === 'waiting';
    // Une échéance consommée sur un bloc agent est une INACTIVITÉ : le contact n'a plus rien dit. Les autres
    // sorties de `resume` closent la session en `erreur`, parce qu'elles tuent le parcours pour une raison
    // qui n'a rien à voir avec le silence du contact.
    if (parQuestion) await this.cloreSessionDuRun(tenantId, run.id, 'inactivite', SORTIE_TIMEOUT);
    const suite = parQuestion
      ? nextNodeByHandle(graph, run.currentNode, SORTIE_TIMEOUT)
      : nextNode(graph, run.currentNode);
    if (!suite) {
      // Sortie « pas de réponse » non câblée : rien n'était prévu, le parcours s'arrête. On REND LA MAIN,
      // parce qu'une question la retenait (`etapeOffreUnChoix`) : sans ça le fil resterait tenu par un
      // parcours mort et l'agent de Meta ne reprendrait jamais la parole.
      if (parQuestion) {
        // eslint-disable-next-line no-console
        console.log(`workflow ${run.workflowId}: pas de réponse dans le délai sur le bloc ${run.currentNode}, sortie « pas de réponse » non câblée -> parcours clos pour ${waId}`);
      }
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'done' });
      if (parQuestion) await this.rendreLaMainAMba(tenantId, waId);
      return false;
    }
    const ctx = await this.buildCtx(tenantId, waId, graph);
    const { actions, rest, canal: apresWalk } = await this.walkResolved(tenantId, waId, graph, suite, ctx, run.id, run.channel ?? 'whatsapp');

    // Fenêtre de service fermée : on écarte les SEULS messages de session (Meta les refuserait, 131047) et on
    // applique le reste. Un walk peut désormais mêler un message rapide sans bouton, des actions et un
    // TEMPLATE : jeter le lot entier ferait sauter le template, qui n'a justement pas besoin de la fenêtre.
    //
    // 🔴 La fenêtre est une règle de META, pas du monde : un message rapide envoyé sur un parcours RCS part
    // par `envoyerQuickEnRcs`, qui n'a AUCUNE fenêtre à respecter. La lui imposer bloquait un envoi
    // parfaitement légitime, tuait le parcours et remontait la conversation en inbox avec un log qui parlait
    // de WhatsApp. Le défaut ne s'est révélé qu'une fois le calcul de fenêtre restreint au canal WhatsApp
    // (2026-08-25) : avant, un retour RCS ouvrait la fenêtre WhatsApp et masquait le problème.
    //
    // ⚠️ Le canal ne peut PAS être lu une fois pour toutes : `apply` le fait MUTER en cours de lot (un
    // template ou un formulaire réussi ramène le parcours sur WhatsApp, l.398-400, et c'est la manière
    // documentée de changer de canal). Un lot `[template, message rapide]` (possible quand MBA est actif,
    // engine.ts) enverrait donc le message rapide en WhatsApp, où la fenêtre s'applique bel et bien. On rejoue
    // ici la MÊME mutation ordonnée, sinon on exempterait un envoi que Meta refuserait en 131047.
    const besoinsFenetre = new Set<WorkflowAction>();
    {
      let canalSimule = apresWalk;
      for (const e of actions) {
        const a = e.action;
        // Un formulaire est WhatsApp par nature (aucun équivalent RCS) : toujours soumis à la fenêtre.
        // Une QUESTION aussi : la liste interactive n'existe que sur WhatsApp (le RCS n'a que des
        // suggestions), donc elle est soumise à la fenêtre quel que soit le canal simulé du parcours.
        if (a.kind === 'sendFlow' || a.kind === 'sendQuestion') besoinsFenetre.add(a);
        else if (a.kind === 'sendQuickMessage' && canalSimule !== 'rcs') besoinsFenetre.add(a);
        if (a.kind === 'sendTemplate' || a.kind === 'sendFlow') canalSimule = 'whatsapp';
      }
    }
    const aBesoinFenetre = (a: WorkflowAction): boolean => besoinsFenetre.has(a);
    // 🔴 Le bloc AGENT exige la fenêtre alors qu'il ne produit AUCUNE action : son premier message est du texte
    // libre, donc un message de session. Ne regarder que les actions le laissait passer, et un montage
    // « attente puis agent » DIRECT réveillait l'agent hors fenêtre : Meta refuse en 131047 et le modèle a déjà
    // été payé. Même trou que celui fermé dans `runFrom`, ici au réveil. Attention, l'attente déclarée ne dit
    // rien de la fenêtre réelle (elle court depuis le dernier message DU CONTACT) : même une attente courte
    // peut se réveiller fenêtre fermée, d'où un test de l'état réel et pas une déduction sur la durée.
    const reveilleUnAgent = rest.status === 'agent_turn';
    let aExecuter = actions;
    let fenetreFermee = false;
    if (reveilleUnAgent || actions.some((e) => aBesoinFenetre(e.action))) {
      const ouverte = this.deps.isWindowOpen ? await this.deps.isWindowOpen(tenantId, waId) : false;
      if (!ouverte) {
        fenetreFermee = true;
        aExecuter = actions.filter((e) => !aBesoinFenetre(e.action));
        // eslint-disable-next-line no-console
        console.error(`workflow ${run.workflowId}: fenêtre 24 h fermée à la reprise, message de session NON envoyé à ${waId} -> conversation remontée en inbox`);
      }
    }

    // `emitEvents` VRAI : un réveil est unitaire par nature (un contact, ici et maintenant), comme `advance`.
    // Sans ça, « attendre 1 jour puis poser le tag relance » ne déclencherait pas l'automation branchée sur ce
    // tag, alors que le MÊME tag posé après une réponse la déclenche. Les campagnes, elles, n'émettent pas.
    const { refus, partis, canal } = await this.apply(tenantId, waId, aExecuter, undefined, true, run.workflowId, apresWalk);
    // Un message du parcours n'a pas pu atteindre le contact : on ne fait pas semblant de continuer, on clôt
    // et on remonte à un humain. Ce qui POUVAIT partir (template, tags) est déjà parti juste au-dessus.
    if (fenetreFermee) {
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'inbox' });
      // ⚠️ AUCUN AFFECTATAIRE ICI, et ce n est pas un oubli : on n a atteint aucun bloc « passer a un
      // humain », c est la fenetre de 24 h qui s est fermee. Personne n a designe qui doit traiter ce fil.
      if (this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId, null);
      return false;
    }
    // Refus au réveil sans qu'aucun message ne parte : le contact n'a rien reçu. Laisser le run en attente le
    // ferait repartir au bloc SUIVANT dès qu'il écrirait, sur un message qu'il n'a jamais vu. On clôt, et on
    // le remonte à un humain. Si un message EST parti, le parcours continue normalement.
    if (refus !== null) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${run.workflowId}: envoi refusé à la reprise pour ${waId} : ${refus}`);
      if (partis === 0) {
        // Garde de VIVACITÉ ici aussi : remonter en `inbox` et escalader à un humain une conversation qui a
        // déjà été remplacée mettrait un opérateur sur un parcours abandonné.
        if (!(await this.ecrireSiVivant(tenantId, run.id, { currentNode: null, status: 'inbox' }))) return false;
        // Remontee SANS bloc « passer a un humain » : pas d affectataire, le fil part au pot commun.
        if (this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId, null);
        return false;
      }
    }
    // 🔴 SI LE PARCOURS VIT ENCORE. Un autre chemin a pu le clore pendant nos envois (une campagne le fait
    // desormais par destinataire) : ecrire sans regarder le ressusciterait AVEC son echeance.
    if (!(await this.ecrireSiVivant(tenantId, run.id, { ...restToState(rest, this.now()), channel: canal }))) return false;
    if (rest.status === 'inbox' && this.deps.escalateToHuman) {
      await this.deps.escalateToHuman(tenantId, waId, rest.assigneA ?? null);
    }
    if (rest.status === 'done') await this.rendreLaMainAMba(tenantId, waId);
    // Bloc AGENT atteint au réveil : ouvrir la session et enfiler le premier tour. APRÈS les sorties
    // anticipées ci-dessus (fenêtre fermée, refus sans envoi), sinon on créerait une session vivante sur un
    // run déjà clos, que rien ne nettoierait.
    if (rest.status === 'agent_turn') {
      await this.demarrerTourAgent(tenantId, waId, { id: run.id, workflowId: run.workflowId }, graph, rest.nodeId);
    }
    return true;
  }

  /**
   * Un parcours vient d'atteindre un bloc agent : ouvrir sa session et enfiler le premier tour.
   *
   * Partagé par `resume` (réveil d'une attente) et `runFrom` (démarrage direct sur le bloc). `advance` ne
   * l'utilise PAS : là-bas la session existe déjà, c'est le contact qui répond.
   *
   * ⚠️ ORDRE, et il est l'INVERSE de celui d'`advance`, délibérément. Ici on enfile APRÈS que l'état du run a
   * été écrit. Le claim du balayage de réveil est un BAIL : en cas d'échec le run reste `sleeping` et redevient
   * dû, donc `resume` serait rejoué EN ENTIER, `walkResolved` et `apply` compris, ce qui RENVERRAIT les
   * messages déjà partis avant le bloc agent. Enfiler d'abord achèterait la reprise du job au prix de doublons
   * chez le contact : mauvais échange. Risque résiduel assumé : si l'enfilage échoue, le run reste `waiting`
   * sur le bloc sans job, et la conversation se répare d'elle-même au message suivant du contact (`advance`
   * retrouve la session vivante par `byRun`). Ce qui est perdu, c'est le premier message que l'agent devait
   * dire de lui-même : une conversation silencieuse plutôt que des messages en double.
   */
  /**
   * Clôt la session d'agent d'un parcours qu'on est en train de TUER ou de faire sortir de son bloc agent.
   *
   * 🔴 SANS ÇA LA SESSION RESTE VIVANTE POUR TOUJOURS, et rien ne la ramasse. Deux dégâts, tous deux
   * silencieux. L'index partiel « une seule session vivante par parcours » ferait RÉUTILISER cette session si
   * le scénario repasse plus tard sur un bloc agent (`byRun ?? open` dans `demarrerTourAgent`), avec ses tours
   * et son coût déjà consommés : l'agent serait muet dès le premier tour. Et elle traînerait dans les écrans
   * d'exploitation comme une conversation vivante qui n'existe plus.
   *
   * Appelée sur TOUTES les sorties de `resume` qui tuent le run, pas seulement sur l'échéance : le fil repris
   * par un humain est même le cas le plus probable, puisque c'est lui qui fait taire le contact. `byRun` ne
   * rend que la session vivante, il n'y a donc rien à faire quand le run n'en a pas.
   */
  private async cloreSessionDuRun(
    tenantId: string, runId: string, statut: AgentSessionStatus, sortie?: string,
  ): Promise<void> {
    if (!this.deps.agentSessions) return;
    const session = await this.deps.agentSessions.byRun(tenantId, runId);
    if (session) await this.deps.agentSessions.clore(tenantId, session.id, statut, sortie);
  }

  private async demarrerTourAgent(
    tenantId: string,
    waId: string,
    run: { id: string; workflowId: string },
    graph: WorkflowGraph,
    nodeId: string,
  ): Promise<void> {
    if (!this.deps.agentSessions) return;
    const noeud = graph.nodes.find((n) => n.id === nodeId);
    const agentId = String(noeud?.data.agentId ?? '').trim();
    if (!agentId) {
      // `walk` ne rend `agent_turn` que sur un bloc CONFIGURÉ, donc on ne devrait jamais passer ici. Si ça
      // arrive, le graphe a changé sous nos pieds : on ne crée pas une session qui pointe un agent inexistant.
      // eslint-disable-next-line no-console
      console.error(`workflow ${run.workflowId}: bloc agent ${nodeId} sans agentId au démarrage du tour, aucun tour enfilé`);
      return;
    }
    // Une session vivante laissée par un passage précédent ferait LEVER `open` sur l'index partiel « une seule
    // session vivante par parcours », et l'échec emporterait tout le réveil. On la réutilise.
    const session = (await this.deps.agentSessions.byRun(tenantId, run.id))
      ?? (await this.deps.agentSessions.open({ tenantId, runId: run.id, agentId, nodeId, waId }));
    await this.deps.enqueueAgentTurn?.({
      tenantId,
      runId: run.id,
      sessionId: session.id,
      workflowId: run.workflowId,
      nodeId,
      waId,
      raison: 'demarrage',
      tours: session.tours,
    });
  }

  /**
   * `walk` + résolution des blocs RCS. Le walk est PUR : sur un bloc `rcs_message` il rend la main avec
   * `rest.status === 'rcs_send'` parce que la branche à suivre dépend d'un appel réseau (le numéro est-il
   * joignable en RCS ?). C'est ICI, et NULLE PART ailleurs, que cette IO est faite.
   *
   * Envoi réussi -> le run attend une réponse SUR ce bloc, exactement comme après un template.
   * Non joignable, opt-out, agent absent, canal non câblé, bloc sans texte -> aucun envoi, et on repart
   * immédiatement par la sortie « non joignable ». Sortie non câblée -> parcours terminé, et surtout JAMAIS
   * la sortie « envoyé » : promettre la suite à un contact qui n'a rien reçu est le pire des deux mondes.
   *
   * Les actions des walks successifs sont ACCUMULÉES : l'appelant les applique en un lot, comme avant.
   */
  /** L'agent est-il allumé pour ce tenant ? Absent -> false, donc rien ne change. */
  private async mbaActif(tenantId: string): Promise<boolean> {
    return this.deps.mbaActifPour ? this.deps.mbaActifPour(tenantId) : false;
  }

  /**
   * Rend le fil à l'agent de Meta, sans jamais faire échouer le parcours qui l'appelle. Un release raté laisse
   * le fil à nous : l'agent reste muet sur ce fil, ce qui se voit dans l'Inbox, alors qu'une exception remontée
   * ferait échouer un envoi déjà parti.
   */
  private async rendreLaMainAMba(tenantId: string, waId: string, opts: { transmettre?: string } = {}): Promise<void> {
    if (!this.deps.releaseToMba) return;
    if (!(await this.mbaActif(tenantId))) return; // gate : aucun appel Meta si l'agent n'est pas allumé
    try {
      await this.deps.releaseToMba(tenantId, waId);
      // APRÈS le release, jamais avant : tant que nous tenons le fil, l'agent de Meta n'a pas la parole.
      if (opts.transmettre !== undefined && this.deps.transmettreHorsParcours) {
        await this.deps.transmettreHorsParcours(tenantId, waId, opts.transmettre);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`release vers MBA ignoré pour ${waId}:`, err instanceof Error ? err.message : err);
    }
  }

  private async walkResolved(
    tenantId: string,
    waId: string,
    graph: WorkflowGraph,
    startNodeId: string,
    ctx: EvalContext | undefined,
    sendKey: string,
    /** Canal courant à l'entrée. Un envoi RCS réussi bascule le parcours sur `rcs` pour la suite. */
    canalEntrant: RunChannel = 'whatsapp',
    /** Même garde que dans `apply` : ce parcours ENVOIE du RCS en ligne, il n'est pas qu'un calcul. */
    garde?: GardeDuTour,
  ): Promise<{ actions: WalkStep[]; rest: WalkRest; canal: RunChannel }> {
    const actions: WalkStep[] = [];
    let canal: RunChannel = canalEntrant;
    let depart = startNodeId;
    for (let i = 0; i < MAX_RCS_ENCHAINES; i++) {
      const r = walk(graph, depart, ctx, { mbaActif: await this.mbaActif(tenantId) });
      actions.push(...r.actions);
      if (r.rest.status !== 'rcs_send') return { actions, rest: r.rest, canal };

      const nodeId = r.rest.nodeId;
      const brut = rcsOutboundOf(graph.nodes.find((n) => n.id === nodeId));
      const agentId = this.deps.rcs ? await this.deps.rcs.agentIdFor(tenantId) : null;
      let envoye = false;
      // 🔴 Ce parcours n'est pas qu'un calcul : il ENVOIE, jusqu'à `MAX_RCS_ENCHAINES` messages d'affilée. Une
      // garde posée uniquement dans `apply` aurait donc laissé passer le chemin RCS, qui est justement celui
      // qui peut enchaîner sans repasser par l'appelant.
      const perduAvantRcs = garde?.perduPourquoi() ?? null;
      if (perduAvantRcs !== null) {
        // eslint-disable-next-line no-console
        console.warn(`rcs: envoi INTERROMPU pour ${waId} au bloc ${nodeId} (${perduAvantRcs})`);
        return { actions, rest: r.rest, canal };
      }
      if (this.deps.rcs && agentId && brut) {
        // Variables `{{prenom}}` du contact. La fiche n'est lue QUE si le message en porte : un bloc sans
        // variable, qui est le cas courant, ne déclenche aucune requête supplémentaire.
        const msg = this.deps.rcs.varsFor && aDesVariables(brut)
          ? appliquerVariables(brut, await this.deps.rcs.varsFor(tenantId, waId))
          : brut;
        const jeton = await this.jetonRcs(tenantId, waId, msg);
        // 🔴 ON REVÉRIFIE ICI, et ce n'est pas une redondance. Entre le contrôle ci-dessus et cette ligne, il
        // y a DEUX attentes (`varsFor`, `jetonRcs`), donc deux requêtes en base : le bail a pu expirer
        // pendant, et un autre porteur avoir repris le tour. C'est la même règle que le lot A2, appliquée un
        // cran plus fin : une garde se pose entre les EFFETS, et « entre » veut dire immédiatement avant
        // l'effet, pas avant le travail qui le précède.
        const perduAvantEnvoi = garde?.perduPourquoi() ?? null;
        if (perduAvantEnvoi !== null) {
          // eslint-disable-next-line no-console
          console.warn(`rcs: envoi INTERROMPU pour ${waId} au bloc ${nodeId} (${perduAvantEnvoi})`);
          return { actions, rest: r.rest, canal };
        }
        const out = await this.deps.rcs.sender.sendTo(tenantId, agentId, waId, msg, `${sendKey}:${nodeId}`, jeton);
        envoye = !('skipped' in out);
        if (!('skipped' in out)) await this.journaliserRcs(tenantId, waId, msg, out.messageId);
      }
      // 🔴 Le parcours bascule sur le canal RCS UNIQUEMENT si le message est vraiment parti. Un envoi sauté
      // (contact désabonné, agent absent) part au repli, qui est WhatsApp : le canal ne doit pas suivre une
      // intention, il suit ce que le contact a REÇU.
      if (envoye) {
        canal = 'rcs';
        return { actions, rest: { status: 'waiting', nodeId }, canal };
      }

      const repli = nextNodeByHandle(graph, nodeId, 'unreachable');
      if (!repli) return { actions, rest: { status: 'done' }, canal };
      depart = repli;
    }
    return { actions, rest: { status: 'done' }, canal };
  }

  /**
   * Écrit l'état d'un parcours en REPRISE, et seulement s'il vit encore.
   *
   * Point de passage unique des trois écritures de `resume` : elles avaient chacune leur `setState`
   * inconditionnel, et il aurait fallu poser la garde trois fois, donc l'oublier une fois.
   *
   * Repli sur `setState` quand la garde n'est pas câblée (fixtures) : le comportement d'avant, pas une
   * absence de comportement.
   */
  private async ecrireSiVivant(tenantId: string, runId: string, state: RunState): Promise<boolean> {
    if (!this.deps.runs.setStateSiVivant) {
      await this.deps.runs.setState(runId, state);
      return true;
    }
    const vivant = await this.deps.runs.setStateSiVivant(tenantId, runId, state);
    if (!vivant) {
      // eslint-disable-next-line no-console
      console.log(`workflow: parcours ${runId} clos pendant sa reprise, etat non reecrit (il a ete remplace)`);
    }
    return vivant;
  }

  /**
   * Corps commun de `start` et `startFromNode` : parcourt depuis `startNodeId`, applique les actions, persiste
   * l'état (sauf 100 % synchrone -> done). `startNodeId` inconnu (bloc supprimé entre-temps) -> `walk` renvoie
   * `done` sans action : aucun envoi, aucun throw.
   *
   * ⚠️ `opts.allowSessionOpen` est la SEULE façon de lever la garde fenêtre 24 h, et il n'est posé que par
   * `startFromNode` (appelé par /v1/sends, qui a DÉJÀ vérifié la fenêtre par destinataire). Le défaut
   * (`start`, campagne classique) garde la garde : ne jamais l'inverser.
   *
   * Renvoie la RAISON (une chaîne lisible) quand le run N'A PAS démarré : bloc de départ absent du graphe (bloc supprimé entre-temps),
   * fil détenu par un humain/MBA, ou ouverture par un message de session hors fenêtre. Sans ce signal, l'appelant
   * campagne comptait le destinataire en `sent` alors que rien n'était parti (campagne « 500 envoyés, 0 échec »
   * pour 0 message réel). `true` = le parcours a bien été appliqué.
   */
  private async runFrom(
    tenantId: string,
    workflowId: string,
    graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null },
    startNodeId: string,
    opts: { allowSessionOpen?: boolean; firstTemplateParams?: string[]; emitEvents?: boolean; ignoreHumanControl?: boolean; figerLeGraphe?: boolean } = {},
  ): Promise<StartOutcome> {
    // Un scénario n'écrit JAMAIS dans un fil détenu par un opérateur ou par MBA. Ce garde est ici, et pas
    // seulement dans `advance`, parce que `start` et `startFromNode` passent par `runFrom` : sans lui, une
    // campagne démarrerait un parcours en plein échange humain, et les deux écriraient au client.
    // « Avoir la main » empêche le scénario de CONTINUER tout seul et MBA de répondre. Ça n'empêche PAS un
    // opérateur d'envoyer une campagne : c'est LUI qui la déclenche, donc c'est lui qui a la main. Le lancement
    // depuis une campagne passe donc `ignoreHumanControl` et REPREND la main pour l'app, sans quoi le scénario
    // partirait puis se bloquerait à la première réponse.
    //
    // 🔴 DEPUIS LE 2026-09-08, UN QUATRIÈME CHEMIN LE PASSE : le clic d'un abonné sur un BOUTON DE CHAÎNE.
    // Le déclencheur n'est plus un opérateur mais le CONTACT lui-même, et c'est le même raisonnement : il a
    // fait un geste explicite vers ce scénario. Sans ça, son clic ne lançait rien dès que le fil était tenu,
    // ce qui est le cas presque à chaque fois au second clic (l'agent de Meta reprend le fil en fin de
    // parcours, pour 24 h). ⚠️ Réservé aux automations NÉES D'UN LIEN DE CHAÎNE : une automation ordinaire
    // par mot-clé ne le passe pas, sinon n'importe quel message écraserait l'opérateur qui répond.
    // Gardé dans les deux sens par `tests/automation-chaine-reprend-la-main.test.ts`.
    if (opts.ignoreHumanControl) {
      // 🔴 UNE REPRISE QUI ÉCHOUE ARRÊTE LE DÉMARRAGE (2026-09-14). Avant, on ignorait son résultat : le
      // parcours démarrait sur un fil que l'agent de Meta tenait toujours, et il était gelé sans un mot à la
      // première réponse du contact, qui recevait entre-temps la réponse de l'agent de Meta. Mesuré sur la
      // campagne « test4 ». Échouer ici fait remonter la raison jusqu'au destinataire (`campaign_recipients.error`),
      // qui est le seul endroit où quelqu'un ira la lire.
      if (this.deps.reclaimControl && (await this.deps.reclaimControl(tenantId, contact.waId)) === false) {
        // eslint-disable-next-line no-console
        console.warn(`workflow ${workflowId}: fil NON repris pour ${contact.waId}, run non démarré (l'agent de Meta le tient et Meta a refusé de le rendre)`);
        return "le fil est tenu par l'agent de Meta et Meta a refusé de le rendre : le scénario n'a pas démarré, il aurait été bloqué dès la première réponse du contact.";
      }
    } else if (this.deps.mayAct && !(await this.deps.mayAct(tenantId, contact.waId))) {
      // eslint-disable-next-line no-console
      console.log(`workflow ${workflowId}: fil détenu par un humain ou par MBA, run non démarré pour ${contact.waId}`);
      return "la conversation est tenue par un opérateur (ou par MBA) : ce déclenchement automatique n'écrit pas dedans. Rends la main depuis l'Inbox pour la rouvrir.";
    }
    // Bloc de départ absent du graphe (supprimé entre la création de l'envoi et son exécution) : `walk` renverrait
    // un `done` vide, indiscernable d'un parcours réussi sans action. On le signale explicitement, sinon la
    // campagne compterait « envoyé » un destinataire pour qui rien n'est parti.
    if (!graph.nodes.some((n) => n.id === startNodeId)) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${workflowId}: bloc de départ ${startNodeId} introuvable, run non démarré pour ${contact.waId}`);
      // ⚠️ LE TEXTE NE PARLE PLUS DE CAMPAGNE. Il disait « supprimé depuis la création de la campagne », ce qui
      // était vrai du seul chemin qui l'affichait alors. Depuis le 2026-09-16, le LIEN DE TEST d'un scénario
      // désigne lui aussi un bloc, et son lien est PERMANENT : la raison la plus courante est désormais un lien
      // collé il y a trois semaines qui pointe un bloc supprimé depuis, sans aucune campagne en jeu.
      return 'le bloc de départ n’existe plus dans le scénario';
    }
    const ctx = await this.buildCtx(tenantId, contact.waId, graph);
    // `sendKey` aléatoire : à ce stade le run n'existe pas encore en base (runs.start vient plus bas), donc
    // aucun identifiant stable n'est disponible. Ce qui protège d'un double envoi ici, c'est le claim atomique
    // du destinataire côté campagne, pas l'idempotence RBM.
    const { actions, rest, canal: apresWalk } = await this.walkResolved(tenantId, contact.waId, graph, startNodeId, ctx, randomUUID());
    // Garde fenêtre 24 h : `start` est appelé par une CAMPAGNE (hors fenêtre de service), un message de
    // session (flow/quick_message) en ouverture serait rejeté par Meta (131047). Depuis le Lot D, le SAVE
    // n'interdit plus cette forme (un scénario peut ouvrir sur un message de session, il est alors réservé aux
    // déclenchements en fenêtre garantie) : c'est `POST /campaigns` qui refuse un tel scénario en campagne, et
    // CETTE garde est le filet runtime si un autre chemin tentait quand même un `start` classique.
    // 🔴 Le bloc AGENT ne produit AUCUNE action (c'est une main rendue, pas un envoi), donc regarder les seules
    // actions le laissait passer : une campagne froide ouvrant sur un agent démarrait, l'agent envoyait du texte
    // libre hors fenêtre, Meta refusait en 131047, et le modèle avait déjà été payé. On teste donc aussi le repos.
    const ouvreParUnAgent = rest.status === 'agent_turn';
    if (!opts.allowSessionOpen && (ouvreParUnAgent || actions.some((e) => e.action.kind === 'sendFlow' || e.action.kind === 'sendQuickMessage' || e.action.kind === 'sendQuestion'))) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${workflowId}: ouverture par un message de session (flow/message rapide/question/agent) hors fenêtre 24 h, run non démarré pour ${contact.waId}`);
      return ouvreParUnAgent
        ? "le scénario ouvre par un agent IA, qui écrit du texte libre : impossible hors de la fenêtre de 24 h"
        : "le scénario ouvre par un message rapide, une question ou un formulaire, impossible hors de la fenêtre de 24 h";
    }
    const { refus, partis, canal } = await this.apply(tenantId, contact.waId, actions, opts.firstTemplateParams, opts.emitEvents === true, workflowId, apresWalk);
    // Refus alors que RIEN n'est parti : le contact n'a rien reçu. On ne persiste PAS de run en attente, pour
    // deux raisons. D'abord il attendrait une réponse à un message jamais reçu. Ensuite il serait ressuscité
    // par n'importe quel message ultérieur du contact, qui recevrait alors le bloc SUIVANT, sorti de nulle
    // part. On remonte la raison telle quelle : c'est elle que la campagne affiche sur le destinataire.
    // Si un message EST parti, le destinataire a bien été touché : le parcours vit, et le refus reste au log.
    if (refus !== null) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${workflowId}: envoi refusé pour ${contact.waId} : ${refus}`);
      if (partis === 0) return refus;
    }
    /**
     * 🔴 LE PARCOURS PRÉCÉDENT EST CLOS ICI, ET NULLE PART AILLEURS.
     *
     * Règle posée par Julien le 2026-09-07 : « on ne bloque personne sur un scénario, surtout quand on lance
     * un nouveau scénario ». Tout démarrage remplace donc le parcours en cours. C'était déjà le comportement
     * du lancement depuis l'Inbox, mais il vivait CHEZ L'APPELANT, donc sur un chemin sur quatre : les trois
     * autres divergeaient chacun à sa façon (le jeton de test laissait un orphelin, l'automation ne démarrait
     * pas du tout, la campagne créait un second run). En le posant sur le passage commun, un cinquième chemin
     * en hérite sans que personne y pense.
     *
     * ⚠️ ET APRÈS `apply`, PAS AU DÉBUT. Trois gardes plus haut peuvent refuser le démarrage (fil tenu par un
     * humain, bloc de départ supprimé, ouverture hors fenêtre de 24 h) et rendent AVANT d'arriver ici. Fermer
     * à l'entrée aurait tué le parcours en cours d'un contact pour un démarrage qui n'a jamais eu lieu, en
     * silence. On ne remplace que ce qu'on a effectivement remplacé.
     *
     * 🔴 ET SEULEMENT SI QUELQUE CHOSE REMPLACE VRAIMENT. Un scénario peut n'être fait que d'actions (poser
     * un tag, écrire un champ) : il n'envoie alors rien et se termine tout de suite, donc `partis === 0` ET
     * le repos vaut `done`, si bien qu'aucun run n'est persisté. Fermer dans ce cas tuerait une conversation
     * vivante SANS RIEN METTRE À LA PLACE, ce qui est l'inverse exact de la règle : on ne bloque personne,
     * mais on ne coupe personne non plus pour un scénario qui n'a pas parlé.
     *
     * On ferme en revanche quand le nouveau parcours est synchrone mais a ENVOYÉ (`partis > 0`) : le contact
     * a reçu autre chose, et laisser l'ancien en attente ferait avancer un parcours abandonné à sa prochaine
     * réponse.
     */
    // Le canal du parcours est PERSISTÉ dès sa naissance : un scénario qui ouvre par un bloc RCS naît sur le
    // canal RCS, et son message rapide suivant partira donc en RCS, pas en WhatsApp.
    const state = { ...restToState(rest, this.now()), channel: canal };
    if (partis > 0 || state.status !== 'done') {
      const closPrecedent = await this.deps.runs.closeActiveByWaId(tenantId, contact.waId);
      // 🔴 LA SESSION D'AGENT SUIT SON PARCOURS. Tuer le run sans clore sa session la laisse `en_cours` avec
      // un tour jamais commencé : invisible de la reprise des tours bloqués, elle ne se referme qu'à la
      // purge de rétention. Le geste existe déjà (`cloreSessionDuRun`), il manquait seulement ici.
      for (const runId of closPrecedent) await this.cloreSessionDuRun(tenantId, runId, 'erreur');
      if (closPrecedent.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`workflow ${workflowId}: ${closPrecedent.length} parcours en cours clos, remplacé pour ${contact.waId}`);
      }
    }
    // ⚠️ L'id rendu par `runs.start` est CAPTURÉ (il était jeté jusqu'ici) : `agent_sessions.run_id` est une FK
    // NOT NULL vers `workflow_runs`, donc la session ne peut pas naître avant le run. C'est ce qui interdit
    // d'ouvrir la session plus tôt, dans `walkResolved` par exemple. Ordre obligatoire : apply, puis start en
    // capturant l'id, puis la session, puis l'enfilage.
    //
    // 🔴 LE FIGEAGE SE DEMANDE, IL N'EST JAMAIS IMPLICITE. Seuls les démarrages de TEST le posent : figer le
    // graphe de chaque destinataire d'une campagne de 5 000 personnes recopierait 5 000 fois le même objet en
    // base, pour répondre à une question que personne ne pose sur un parcours réel.
    const cree = state.status !== 'done'
      ? await this.deps.runs.start(tenantId, workflowId, contact.waId, contact.contactId, state, opts.figerLeGraphe === true ? graph : null)
      : null;
    // Le run a atteint un bloc `inbox` -> la conversation passe explicitement à un humain (badge honnête, A.5).
    if (rest.status === 'inbox' && this.deps.escalateToHuman) {
      await this.deps.escalateToHuman(tenantId, contact.waId, rest.assigneA ?? null);
    }
    if (rest.status === 'done') await this.rendreLaMainAMba(tenantId, contact.waId);
    // Bloc AGENT en ouverture : la session naît maintenant, le run existe enfin.
    if (rest.status === 'agent_turn' && cree) {
      await this.demarrerTourAgent(tenantId, contact.waId, { id: cree.id, workflowId }, graph, rest.nodeId);
    }
    return true;
  }

  /**
   * Démarre un run : parcourt depuis l'entrée, applique les actions, persiste l'état (sauf 100% synchrone -> done).
   * `firstTemplateParams` (campagne workflow) = variables du 1er template déjà résolues par contact -> passées à
   * l'envoi du 1er template SANS re-résolution via les hints stockés. Garde fenêtre 24 h APPLIQUÉE.
   *
   * Renvoie la RAISON du refus (une chaîne) si le run n'a PAS démarré (cf. `runFrom`), y compris sur un graphe VIDE : l'appelant
   * campagne doit pouvoir marquer le destinataire en échec plutôt que de le compter comme envoyé.
   */
  async start(
    tenantId: string, workflowId: string, graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null },
    firstTemplateParams?: string[],
    opts: { emitEvents?: boolean; ignoreHumanControl?: boolean } = {},
  ): Promise<StartOutcome> {
    const entry = entryNode(graph);
    if (!entry) return 'le scénario est vide';
    return this.runFrom(tenantId, workflowId, graph, contact, entry, { ...(firstTemplateParams ? { firstTemplateParams } : {}), ...opts });
  }

  /**
   * Démarre un run depuis l'ENTRÉE, pour un contact dont la fenêtre de service 24 h est GARANTIE OUVERTE parce
   * qu'il vient d'écrire (automation déclenchée par un message entrant). La garde fenêtre n'a alors pas lieu
   * d'être : le scénario peut légitimement ouvrir par un message rapide ou un formulaire, ce qui est justement
   * l'usage que le Lot D a rendu possible.
   *
   * ⚠️ À n'appeler QUE sur un chemin où la fenêtre est prouvée par un inbound récent. Un déclencheur qui ne
   * prouve pas la fenêtre (ex. un tag posé depuis le CRM) doit passer par `start()`, qui garde la protection.
   *
   * `ignoreHumanControl` sert au lancement DEPUIS L'INBOX : l'opérateur y détient presque toujours le fil (il
   * l'a pris en répondant), et c'est pourtant LUI qui demande le scénario. Le refuser au motif qu'il a la main
   * serait absurde. Même règle que le lancement d'une campagne : « avoir la main » empêche le scénario
   * d'avancer tout seul et MBA de répondre, jamais un opérateur d'envoyer.
   */
  async startInWindow(
    tenantId: string, workflowId: string, graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null },
    opts: { emitEvents?: boolean; ignoreHumanControl?: boolean; figerLeGraphe?: boolean } = {},
  ): Promise<StartOutcome> {
    const entry = entryNode(graph);
    if (!entry) return 'le scénario est vide';
    return this.runFrom(tenantId, workflowId, graph, contact, entry, { allowSessionOpen: true, ...opts });
  }

  /**
   * Démarre un run à un bloc ARBITRAIRE du graphe (cible `node` de /v1/sends, D-1). La garde fenêtre 24 h n'est
   * PAS appliquée ici : l'appelant a déjà écarté les contacts hors fenêtre (`out_of_window`), et l'intérêt même
   * de la cible node est d'envoyer un message de session (quick_message/flow) à quelqu'un qui vient d'écrire.
   *
   * ⚠️ `figerLeGraphe` est réservé aux démarrages de TEST, qui jouent le BROUILLON : sans lui, le parcours
   * reprendrait sur le publié à la première réponse du contact. `start` (campagne) ne l'offre pas.
   */
  async startFromNode(
    tenantId: string, workflowId: string, graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null }, startNodeId: string,
    opts: { emitEvents?: boolean; ignoreHumanControl?: boolean; figerLeGraphe?: boolean } = {},
  ): Promise<StartOutcome> {
    return this.runFrom(tenantId, workflowId, graph, contact, startNodeId, { allowSessionOpen: true, ...opts });
  }

  /**
   * Le message RCS n'a PAS pu être remis (rapport de livraison UNDELIVERABLE / UNDELIVERED). Le parcours
   * repart par la sortie « non joignable » du bloc : c'est la cascade RCS -> WhatsApp.
   *
   * 🔴 Pourquoi une méthode À PART plutôt qu'un `advance(..., 'unreachable')`. `advance` retombe sur la
   * première arête libre quand aucun handle ne correspond. Sur un run qui attend AUTRE CHOSE qu'un bloc RCS
   * (un template, par exemple), passer « unreachable » ferait donc avancer le parcours d'un cran sur un
   * accusé qui ne le concerne pas. La garde ci-dessous est tout l'intérêt de cette porte d'entrée : on ne
   * bascule en repli QUE si le run attend bien sur un bloc RCS.
   *
   * Rejeu sans effet : `advance` déduplique sur `lastMessageId`, et un rapport rejoué porte le même
   * identifiant de message. smsmode rejoue jusqu'à six fois, ce n'est donc pas un cas théorique.
   */
  async rcsUndeliverable(tenantId: string, waId: string, messageId: string): Promise<boolean> {
    if (!(await this.runEnAttenteSur(tenantId, waId, 'rcs_message'))) return false;
    await this.advance(tenantId, waId, messageId, 'unreachable', 'rcs');
    return true;
  }

  /**
   * Le message RCS a bien été remis. Le parcours repart par la sortie « envoyé »… mais SEULEMENT si le bloc
   * n'offre aucun bouton réponse.
   *
   * 🔴 Toute la difficulté est là. Après un envoi, le run attend SUR le bloc RCS, et deux choses peuvent
   * encore arriver : le contact tape un bouton, ou le rapport de livraison tombe. Avancer sur « remis »
   * alors qu'un bouton est proposé serait une faute : l'accusé arrive en quelques secondes, le contact
   * répond bien plus tard, et son clic ne trouverait alors plus aucun parcours en attente.
   *
   * Sans bouton, en revanche, il n'y a rien à attendre d'autre : sans cette reprise, un bloc RCS suivi d'une
   * attente puis d'une relance ne repartirait JAMAIS pour un contact qui ne répond pas, c'est-à-dire pour la
   * quasi-totalité d'entre eux.
   */
  async rcsDelivered(tenantId: string, waId: string, messageId: string): Promise<boolean> {
    const bloc = (await this.runEnAttenteSur(tenantId, waId, 'rcs_message'))?.node;
    if (!bloc) return false;
    const boutons = Array.isArray(bloc.data.suggestions) ? bloc.data.suggestions : [];
    if (boutons.some((b) => (b as { kind?: unknown }).kind === 'reply')) return false;
    await this.advance(tenantId, waId, messageId, 'sent', 'rcs');
    return true;
  }

  /**
   * Le tour d'agent a décidé de sortir : le parcours reprend par la branche `sortie:<code>` du bloc.
   *
   * Réutilise `advance` avec un handle synthétique, exactement comme `rcsDelivered`/`rcsUndeliverable` le font
   * avec `sent`/`unreachable` : tout le chemin de reprise (parcours du graphe, envois, persistance, canal) est
   * déjà écrit et testé là, le dupliquer serait la faute que le repo combat.
   *
   * L'identifiant de message est SYNTHÉTIQUE et porte la session : il rend la sortie idempotente. Rejouée,
   * elle est écartée par la déduplication `lastMessageId` d'`advance`, donc le parcours n'avance pas deux fois.
   *
   * Rend `false` si le contact n'a pas de parcours en attente sur un bloc agent : la sortie ne s'applique
   * alors à rien, et forcer ferait avancer un parcours qui attend autre chose.
   */
  async sortirDuBlocAgent(tenantId: string, waId: string, sessionId: string, sortie: string): Promise<boolean> {
    const attente = await this.runEnAttenteSur(tenantId, waId, 'agent');
    if (!attente) return false;
    // Le canal du PARCOURS est repassé tel quel : un bloc agent peut suivre un bloc RCS, et la garde
    // d'étanchéité d'`advance` écarterait un retour annoncé sur le mauvais tuyau.
    await this.advance(tenantId, waId, `agent:${sessionId}:${sortie}`, `sortie:${sortie}`, attente.run.channel ?? 'whatsapp');
    return true;
  }

  /**
   * Déclenche un bloc du scénario COURANT depuis un outil d'agent (`mba_envoyer_bloc`) : `walk` + `apply`
   * bornés, **sans persister de run**.
   *
   * 🔴 POURQUOI PAS `startFromNode`. Il passe par `runFrom`, et la raison a CHANGÉ le 2026-09-07 : ce ne
   * serait plus « deux runs `waiting` en parallèle » (`runFrom` clôt désormais le parcours actif avant de
   * persister le sien), ce serait pire. `runFrom` TUERAIT le run de l'agent qui l'appelle, et clôrait au
   * passage la session d'où part cet outil. La décision reste la même, sa raison est l'inverse.
   *
   * 🔴 UN SOUS-PARCOURS QUI REND LA MAIN EST REFUSÉ AVANT TOUT ENVOI. Quatre repos sont incompatibles avec le
   * fait que notre session tient déjà le fil, et aucun ne peut être honoré sans run pour le porter :
   * `agent_turn` (le bloc visé reboucle sur un bloc agent -> une seconde session lèverait en 23505 sur
   * l'index unique « une seule session vivante par parcours »), `inbox` (basculer le fil laisserait notre run
   * planté sur le bloc agent, cf. `mayAct` dans `advance`), `sleeping` (l'échéance n'est écrite nulle part,
   * donc tout ce qui suit le bloc Attente ne partirait JAMAIS, en silence, alors qu'on aurait répondu
   * « envoyé » au modèle), et `rcs_send` (le résoudre demanderait la boucle de `walkResolved`, dont l'IO
   * partirait AVANT qu'on ait pu refuser). Dans les quatre cas on refuse, et le modèle reçoit la raison.
   *
   * Le repos `waiting` est normal et n'est pas persisté : le message est parti, et c'est l'agent qui garde la
   * conversation. La réponse du contact lui revient par la branche agent d'`advance`, comme toute autre.
   *
   * `emitEvents` est FAUX : un tag posé par un sous-parcours ne doit pas démarrer une automation pendant que
   * l'agent tient le fil.
   */
  async envoyerBlocDepuisAgent(
    tenantId: string,
    waId: string,
    input: { runId: string; workflowId: string; code: string },
  ): Promise<{ ok: boolean; raison?: string }> {
    const attente = await this.runEnAttenteSur(tenantId, waId, 'agent');
    // Le run doit être CELUI de l'agent qui appelle, scénario compris : c'est ce qui empêche un outil de
    // pousser un bloc dans un parcours qui attend tout autre chose.
    if (!attente || attente.run.id !== input.runId || attente.run.workflowId !== input.workflowId) {
      return { ok: false, raison: 'aucun parcours d agent en cours pour ce contact' };
    }
    const { run, graph } = attente;
    // Le préfixe est exigé comme le fait déjà `src/ids/resolve.ts` : sans lui, un code VIDE correspondrait au
    // premier bloc dépourvu de code, et l'outil enverrait un bloc pris au hasard.
    if (!input.code.startsWith('nod_')) return { ok: false, raison: `code de bloc inconnu : ${input.code}` };
    const cible = graph.nodes.find((n) => String(n.data.code ?? '') === input.code);
    if (!cible) return { ok: false, raison: `code de bloc inconnu : ${input.code}` };
    if (this.deps.mayAct && !(await this.deps.mayAct(tenantId, waId))) {
      return { ok: false, raison: 'le fil est tenu par quelqu un d autre' };
    }
    const canal: RunChannel = run.channel ?? 'whatsapp';
    const ctx = await this.buildCtx(tenantId, waId, graph);
    const { actions, rest } = walk(graph, cible.id, ctx, { mbaActif: await this.mbaActif(tenantId) });
    const refusDeRepos: Partial<Record<WalkRest['status'], string>> = {
      agent_turn: 'ce bloc redonne la main a un agent, impossible depuis un agent',
      inbox: 'ce bloc remonte la conversation a un humain, utilisez l outil d escalade',
      sleeping: 'ce bloc contient une attente, non disponible depuis un outil',
      rcs_send: 'ce bloc envoie en RCS, non disponible depuis un outil',
    };
    const refuse = refusDeRepos[rest.status];
    if (refuse) return { ok: false, raison: refuse };
    // Même raison que `sleeping` : un bloc Question À ÉCHÉANCE partirait, mais sa branche « pas de réponse »
    // ne se déclencherait jamais, l'échéance n'étant portée par aucun run.
    if (rest.status === 'waiting' && rest.timeoutInMs) {
      return { ok: false, raison: 'ce bloc attend une reponse avec un delai, non disponible depuis un outil' };
    }
    const { refus, partis } = await this.apply(tenantId, waId, actions, undefined, false, run.workflowId, canal);
    if (partis === 0 && refus !== null) return { ok: false, raison: refus };
    return { ok: true };
  }

  /**
   * Le parcours en attente d'un contact ET le bloc sur lequel il attend, quand ce bloc est du type demandé.
   *
   * Garde commune à toutes les reprises qui ne viennent PAS du contact (accusé de livraison RCS, sortie de
   * tour d'agent, outil d'agent) : c'est elle qui empêche un signal de faire avancer un parcours qui attend
   * autre chose.
   */
  private async runEnAttenteSur(
    tenantId: string, waId: string, type: WorkflowNodeType,
  ): Promise<{ run: WorkflowRunRow; graph: WorkflowGraph; node: WorkflowNode } | null> {
    const run = await this.deps.runs.findWaitingByWaId(tenantId, waId);
    if (!run || !run.currentNode) return null;
    const graph = await grapheDuRun(run, () => this.deps.getGraph(run.workflowId, tenantId));
    const node = graph?.nodes.find((n) => n.id === run.currentNode);
    return graph && node?.type === type ? { run, graph, node } : null;
  }

  /**
   * Avance le run en attente d'un contact quand il répond. No-op si aucun run / message déjà traité.
   * `buttonPayload` = bouton quick-reply tapé (`btn:<index>`). Routage en TROIS cas, dans cet ordre :
   *   1. une arête part de CE handle -> sa branche (le bouton est câblé) ;
   *   2. sinon une arête LIBRE existe (chaîne linéaire, ou sortie « toute autre réponse » tirée exprès)
   *      -> on la suit : le scénario a prévu ce cas ;
   *   3. sinon toutes les arêtes partent d'un bouton -> le scénario n'a rien prévu pour cette réponse, on
   *      clôt le run et l'agent reprend la parole.
   * Le cas 3 remplace l'ancien repli sur la 1re arête sortante, qui envoyait « non merci » dans la branche
   * du bouton « Oui ». Décision produit du 2026-08-20.
   *
   * `canalRetour` = le tuyau d'où vient le retour. Défaut `whatsapp`, sur le modèle de `recordInbound` : la porte
   * Meta (webhooks/workflow-advance.ts) ne peut recevoir QUE du WhatsApp, son interface n'expose donc pas le
   * paramètre, ce qui rend l'omission non ambiguë plutôt que silencieuse. Les portes RCS, elles, le passent
   * explicitement.
   */
  async advance(tenantId: string, waId: string, messageId: string, buttonPayload: string | null = null, canalRetour: RunChannel = 'whatsapp'): Promise<void> {
    const run = await this.deps.runs.findWaitingByWaId(tenantId, waId);
    if (!run || run.lastMessageId === messageId) return; // dédup at-least-once

    /**
     * 🔴 LE TOUR EST RÉSERVÉ AVANT TOUT ENVOI (migration 0104). C'est le correctif du dernier trou connu de
     * ce chemin, documenté ici même depuis des semaines : l'écriture conditionnelle plus bas protège l'ÉTAT,
     * mais elle arrive APRÈS les envois. Deux avances concurrentes envoyaient donc toutes les deux, et le
     * contact recevait un message qu'il ne devait jamais voir.
     *
     * Perdre la réservation n'est PAS une erreur : c'est le cas normal quand deux messages du même contact
     * arrivent ensemble. Le gagnant lisait le même bloc et a traité la suite ; rejouer ici ferait avancer le
     * parcours deux fois. On sort en le journalisant, parce qu'on ne corrige pas ce qu'on ne voit pas.
     */
    const peutReserver = this.deps.runs.reserverAvance !== undefined;
    const jeton = peutReserver
      ? await this.deps.runs.reserverAvance!(tenantId, run.id, run.currentNode, BAIL_AVANCE_S)
      : null;
    if (peutReserver && jeton === null) {
      // eslint-disable-next-line no-console
      console.warn(`workflow ${run.workflowId}: avance IGNOREE pour ${waId} (run ${run.id}), un autre traitement tient le tour sur le bloc ${run.currentNode ?? 'null'} (message ${messageId})`);
      return;
    }

    /**
     * 🔴 LE BAIL EST RENOUVELÉ TANT QU'ON TRAVAILLE (lot 1 du plan post-audit, 2026-09-02). La réservation
     * ci-dessus ferme la course COURTE (deux avances qui démarrent ensemble). Elle ne fermait PAS la course
     * LONGUE : un seul envoi Meta peut durer ~154 s en rejouant ses tentatives, une avance peut en enchaîner
     * plusieurs, donc le bail expirait pendant qu'on travaillait, un autre prenait le tour, et les deux
     * envoyaient. Battre est la seule façon de distinguer un porteur MORT d'un porteur LENT.
     */
    const battement = jeton !== null && this.deps.runs.prolongerAvance
      ? renouvelerLeBail({
          prolonger: () => this.deps.runs.prolongerAvance!(run.id, jeton, BAIL_AVANCE_S),
          perdu: () => {
            // eslint-disable-next-line no-console
            console.warn(`workflow ${run.workflowId}: bail d'avance PERDU pour ${waId} (run ${run.id}), un autre traitement a repris le tour pendant le traitement du message ${messageId}`);
          },
          echec: (err) => {
            // eslint-disable-next-line no-console
            console.warn(`workflow ${run.workflowId}: renouvellement du bail en ECHEC pour le run ${run.id} (on continue de battre):`, err);
          },
        })
      : null;
    try {

    /**
     * Écriture de l'état, CONDITIONNÉE au fait que le run n'a pas bougé pendant qu'on travaillait.
     *
     * 🔴 Ce que ça ferme. Deux avances peuvent se chevaucher DÈS AUJOURD'HUI, avec un seul worker : le
     * process API traite certains retours RCS pendant que le worker traite un webhook du même contact. Les
     * deux lisent le run sur le bloc N, calculent chacun leur suite, et écrivaient tous les deux : le dernier
     * gagnait, en écrasant `current_node`. Un parcours pouvait ainsi REVENIR sur un bloc déjà franchi, et
     * rejouer sa branche au message suivant. Silencieusement.
     *
     * ⚠️ Cette garde reste la CEINTURE, la réservation étant la bretelle : elle n'est plus le dernier
     * rempart depuis la migration 0104, mais deux gardes qui se recouvrent valent mieux qu'une seule sur un
     * chemin qui envoie de l'argent. Elle est clôturée par le JETON depuis le lot 1 du plan post-audit : un
     * porteur de bail périmé ne peut plus écrire par-dessus celui qui a repris le tour.
     */
    const ecrire = async (state: RunState): Promise<boolean> => {
      if (!this.deps.runs.setStateSiEncoreSur) {
        await this.deps.runs.setState(run.id, state);
        return true;
      }
      const ecrit = await this.deps.runs.setStateSiEncoreSur(tenantId, run.id, run.currentNode, state, jeton);
      if (!ecrit) {
        // eslint-disable-next-line no-console
        console.warn(`workflow ${run.workflowId}: avance PERDUE pour ${waId} (run ${run.id}), le parcours a bougé depuis le bloc ${run.currentNode ?? 'null'} pendant le traitement du message ${messageId}`);
      }
      return ecrit;
    };
    // Le fil est-il encore à nous ? Placé APRÈS la recherche du run pour ne pas payer une requête sur les
    // messages qui n'attendent aucun parcours (le cas le plus fréquent). On ne clôt PAS le run, sinon un
    // aller-retour avec un opérateur tuerait le parcours.
    //
    // 🔴 CE GEL ÉTAIT MUET, ET IL A COÛTÉ UNE ENQUÊTE ENTIÈRE (2026-09-14). Toutes les autres sorties de
    // cette fonction journalisent (réservation perdue, bail perdu, avance perdue, discordance de canal) ;
    // celle-ci était un `return` nu. Symptôme vécu : une campagne à scénario dont le contact répond, le
    // MBA qui répond à sa place, et un parcours resté `waiting` avec un `updated_at` intact et ZÉRO ligne
    // dans `workflow_advance_failures`. Il n'existait littéralement aucune trace à lire, ni dans les
    // journaux ni en base, et c'est ce qui a rendu le défaut incompréhensible pour le client comme pour
    // nous. Un chemin qui décide de NE PAS agir doit le dire, au même titre que celui qui échoue.
    //
    // ⚠️ ET LE COMMENTAIRE QUI VIVAIT ICI PROMETTAIT UNE REPRISE QUI N'EXISTE PAS. Il affirmait « le gel
    // est transitoire, il repart tout seul dès que le contrôle revient ». VÉRIFIÉ : `handover.ts` ne
    // relance aucun parcours au `control_passed` de Meta. Le gel ne se lève qu'au PROCHAIN message du
    // contact, qui n'a aucune raison d'écrire une seconde fois puisqu'il vient d'être servi par quelqu'un
    // d'autre. Un parcours gelé est donc mort en pratique, et le dire est le minimum tant que personne ne
    // le relance.
    if (this.deps.mayAct && !(await this.deps.mayAct(tenantId, waId))) {
      // eslint-disable-next-line no-console
      console.warn(`workflow ${run.workflowId}: avance GELEE pour ${waId} (run ${run.id}), le fil ne nous appartient pas (opérateur ou Meta Business Agent) sur le bloc ${run.currentNode ?? 'null'} (message ${messageId}) ; le run reste waiting et ne repartira qu'au prochain message du contact`);
      return;
    }
    const graph = run.currentNode ? await grapheDuRun(run, () => this.deps.getGraph(run.workflowId, tenantId)) : null;
    // Bloc RCS en attente : la réponse du contact reprend par la sortie « envoyé », pas par un payload de
    // bouton. Et le repli conditionnel suit la règle du bloc Condition : tant qu'une sortie TYPÉE existe, on
    // ne prend JAMAIS la 1re arête venue, sinon « non joignable » volerait la suite d'un envoi réussi.
    const courant = graph && run.currentNode ? graph.nodes.find((n) => n.id === run.currentNode) : undefined;

    // 🔴 ÉTANCHÉITÉ DES CANAUX. Le retour doit venir du tuyau sur lequel le parcours attend. Sans cette garde,
    // un tap de suggestion RCS (`btn:0`) choisissait une branche d'une question posée en WhatsApp, et un
    // message écrit sur WhatsApp reprenait la sortie « envoyé » d'un bloc RCS : les deux canaux partagent le
    // MÊME espace de handles `btn:<i>` (rcs/schema.ts et meta/client.ts), donc rien ne les distinguait.
    //
    // Canal ATTENDU : un bloc RCS attend une réponse RCS ; pour tout AUTRE bloc c'est le canal du PARCOURS qui
    // fait foi. ⚠️ Ne pas écrire « bloc non-RCS = whatsapp » : un message rapide derrière un bloc RCS part EN
    // RCS (executor.ts, apply) et attend donc une réponse RCS. C'est exactement ce que la migration 0082 est
    // venue corriger, et l'écrire à l'envers le réintroduirait.
    //
    // Discordance -> on ne fait RIEN : le run reste `waiting` (le clore ferait d'un retour sur le mauvais
    // canal un tueur de parcours), on ne mesure pas, et on n'écrit pas `lastMessageId` (le message
    // n'appartient pas à ce parcours ; le marquer consommé masquerait un rejeu légitime). Le message reste
    // visible et NON LU dans l'inbox (UNREAD_SQL ne regarde que l'antériorité, tous canaux confondus), c'est
    // ce qui le porte à l'attention d'un opérateur.
    // Reprise APRÈS un bloc agent, déclenchée par `sortirDuBlocAgent` et par personne d'autre : ce n'est pas
    // un retour du contact mais l'issue d'un tour. Le préfixe `sortie:` est produit par nous seuls (Meta
    // n'envoie que `btn:`, `row:` et `card:`), c'est ce qui rend ce marqueur sûr. Il éteint deux
    // comportements qui n'ont de sens que pour une vraie réponse : la mesure, et l'interception par la
    // branche agent (sans quoi la sortie réenfilerait un tour au lieu de faire avancer le parcours).
    const sortieAgent = typeof buttonPayload === 'string' && buttonPayload.startsWith('sortie:');
    const canalAttendu: RunChannel = courant?.type === 'rcs_message' ? 'rcs' : (run.channel ?? 'whatsapp');
    if (canalRetour !== canalAttendu) {
      // eslint-disable-next-line no-console
      console.warn(`workflow ${run.workflowId}: retour ${canalRetour} ignoré pour ${waId}, le parcours attend du ${canalAttendu}`);
      return;
    }

    // Mesure de la RÉPONSE, rattachée au bloc qui l'attendait (Analytics > Mes tableaux). Enregistrée ICI,
    // avant toute décision de routage : ce qui compte est ce que le contact a FAIT, pas ce que le graphe en a
    // fait ensuite. Un bouton dont l'arête n'est pas câblée reste un clic, et doit se compter comme tel.
    //
    // `handle` distingue le choix : `btn:<i>` pour un template, et le handle carte/bouton pour un carousel,
    // que `carouselButtonHandle` produit déjà. Pas de payload = le contact a ÉCRIT, ce qui est la mesure
    // « a répondu sans utiliser les choix proposés ».
    //
    // Les blocs RCS sont exclus : leur reprise n'est pas une réponse du contact mais l'issue d'un envoi.
    if (run.currentNode && courant?.type !== 'rcs_message' && !sortieAgent) {
      const aClique = typeof buttonPayload === 'string' && buttonPayload !== '';
      await this.mesurer(
        tenantId, run.workflowId, run.currentNode, waId,
        aClique ? 'reply_button' : 'reply_text',
        aClique ? buttonPayload : undefined,
      );
    }
    // 🔴 BLOC AGENT : le contact répond pendant une conversation que l'agent tient. On n'entre PAS dans le
    // routage. Sans cette branche, `sortieTypee` (juste en dessous) ne connaît que `sent`/`unreachable`, donc
    // il est faux ici, et deux issues suivent, fatales toutes les deux : une arête libre partant du bloc fait
    // SAUTER l'agent dès le premier message du contact, sinon `next` est null, le run est clos en `done` et la
    // conversation est rendue à l'agent de Meta. Dans les deux cas la session reste vivante et ORPHELINE en
    // base, et le réveil d'inactivité se déclenchera plus tard sur un run mort.
    //
    // Placé APRÈS le bloc de mesure ci-dessus, volontairement : celui-ci enregistre déjà la réponse du contact
    // et distingue le clic du texte libre. Le refaire ici le dupliquerait, et en moins bien.
    if (courant?.type === 'agent' && !sortieAgent) {
      const session = await this.deps.agentSessions?.byRun(tenantId, run.id);
      if (!session || session.status !== 'en_cours') {
        // Le run pointe un bloc agent mais aucune session ne le tient : état incohérent. On ne route pas au
        // hasard (ce serait rejouer le saut silencieux qu'on vient de fermer), on remonte la conversation à
        // un humain et on laisse une trace.
        // eslint-disable-next-line no-console
        console.error(`workflow ${run.workflowId}: run ${run.id} sur un bloc agent sans session vivante, remonté en inbox`);
        await ecrire({ currentNode: null, status: 'inbox', lastMessageId: messageId });
        // Remontee a l humain sans qu aucun bloc ne l ait demande (envoi refuse, fenetre fermee) : personne
        // n a designe d affectataire, le fil part au pot commun.
        if (this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId, null);
        return;
      }
      // ⚠️ ORDRE : on enfile AVANT de marquer le message consommé, comme partout ailleurs dans ce fichier
      // (l'effet réel d'abord, `lastMessageId` ensuite). Si l'enfilage lève (panne transitoire de la file),
      // l'exception est avalée par l'isolation par message de `processWorkflowAdvance` et Meta reçoit quand
      // même un 200 : avec l'ordre inverse, `lastMessageId` serait déjà écrit, une redélivrance serait
      // dédupliquée, et le tour ne serait JAMAIS enfilé (conversation bloquée jusqu'à ce que le contact
      // réécrive). Dans ce sens-ci, si l'enfilage réussit mais que `setState` échoue, un rejeu réémet un job
      // portant le MÊME `tours` attendu, que le verrou optimiste de `prendreLeTour` absorbe sans effet.
      //
      // 🔴 Même garde que devant un envoi, pour la même raison : enfiler un tour, c'est commander un appel
      // modèle FACTURÉ, et le nouveau porteur du tour vient de commander le sien sur le même message. Un
      // `return` sec suffit : on n'écrit pas `lastMessageId`, donc rien n'est marqué consommé par un porteur
      // qui n'a plus le droit de le faire.
      const perduAvantTour = battement?.perduPourquoi() ?? null;
      if (perduAvantTour !== null) {
        // eslint-disable-next-line no-console
        console.warn(`workflow ${run.workflowId}: tour d'agent NON enfilé pour ${waId} (run ${run.id}) : ${perduAvantTour}`);
        return;
      }
      await this.deps.enqueueAgentTurn?.({
        tenantId,
        runId: run.id,
        sessionId: session.id,
        workflowId: run.workflowId,
        nodeId: courant.id,
        waId,
        raison: 'message',
        tours: session.tours,
      });
      // ⚠️ `currentNode` est repassé EXPLICITEMENT : `setState` écrit `current_node` SANS coalesce
      // (`run-store.pg.ts`), donc passer null effacerait la position et le bloc agent serait perdu. Le run
      // reste `waiting` SUR le bloc, c'est ce qui permet à `findWaitingByWaId` de le retrouver au message
      // suivant. Et `lastMessageId` est persisté ICI : sans lui la dédup at-least-once ne protège plus, et un
      // rejeu enfilerait un second tour, donc un second appel modèle facturé.
      await ecrire({
        currentNode: run.currentNode,
        status: 'waiting',
        lastMessageId: messageId,
      });
      return;
    }
    // Bloc RCS : `sent` et `unreachable` qualifient la LIVRAISON, les boutons qualifient la RÉPONSE. Un clic
    // prime donc sur `sent` ; sans clic, on reprend par `sent`.
    const handle = courant?.type === 'rcs_message' ? (buttonPayload ?? 'sent') : buttonPayload;
    const sortieTypee = graph && run.currentNode
      ? graph.edges.some((e) => e.source === run.currentNode && (e.sourceHandle === 'sent' || e.sourceHandle === 'unreachable'))
      : false;
    const next = graph && run.currentNode
      ? ((handle ? nextNodeByHandle(graph, run.currentNode, handle) : null)
        ?? (sortieTypee ? null : nextNodeSansHandle(graph, run.currentNode)))
      : null;
    if (!graph || !next) {
      // 🔴 DEUX situations très différentes arrivaient ici, et ce chemin les traitait pareil, en silence.
      //
      // (a) Le contact a ÉCRIT au lieu de taper un bouton : le scénario n'avait rien prévu pour ça, plus
      //     personne n'attend une réponse précise, l'agent de Meta reprend la parole. Cas nominal, inchangé.
      //
      // (b) Le contact a TAPÉ un bouton qui ne mène nulle part. Ce n'est pas lui qui est sorti du script,
      //     c'est le scénario qui a un TROU : on lui a proposé un choix, il l'a fait, et il n'a rien reçu.
      //     Vécu par Julien le 2026-08-25 : bouton tapé, parcours terminé sur-le-champ, aucune trace nulle part.
      //     On remonte donc la conversation à un humain (« À traiter »), au lieu de la rendre à l'agent.
      //
      // ⚠️ Conséquence assumée du (b) : chez un client où MBA est allumé, l'agent ne répondra pas à ce
      // message-là. C'est voulu : un bouton non branché est un défaut de montage, quelqu'un doit le voir.
      // Le payload doit être un HANDLE que l'éditeur sait relier (`btn:<i>`, ou `card:<i>:btn:<j>` pour un
      // carousel). Tout le reste (texte libre, payload d'un vieux template qui porte le libellé du bouton,
      // accusé `sent`/`unreachable` d'un bloc RCS dont la sortie n'est volontairement pas branchée) suit le
      // chemin historique : ce ne sont pas des trous de montage.
      // `row:<i>` = une ligne du MENU d'un bloc Question. Elle appartient à la même famille que `btn:` : le
      // contact a fait un choix qu'on lui a proposé. L'oublier ici la ferait retomber en silence sur le
      // chemin « il a écrit », donc rendre la main à l'agent au lieu de signaler le trou de montage.
      // `sortie:` = une SORTIE D'AGENT non câblée. Même famille que le bouton non branché, et pour la même
      // raison : le scénario a prévu que l'agent sorte par là, il l'a fait, et rien ne l'attend. Rendre la
      // main à l'agent de Meta en silence masquerait un trou de montage, et une sortie d'escalade non câblée
      // enverrait le contact au bot générique au lieu d'alerter un opérateur.
      const boutonSansSuite = typeof buttonPayload === 'string' && /^(btn:|card:|row:|sortie:)/.test(buttonPayload);
      await ecrire({ currentNode: null, status: 'done', lastMessageId: messageId });
      if (boutonSansSuite) {
        // eslint-disable-next-line no-console
        console.error(`workflow ${run.workflowId}: le bouton « ${buttonPayload} » du bloc ${run.currentNode} ne mène nulle part, ${waId} a cliqué et n'a rien reçu`);
        if (this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId, null);
      } else {
        // (a) : son message part aussi chez l'agent de Meta, qui y répond (réponse « à côté »). 🔴 Seulement un
        // VRAI message WhatsApp : cette branche reçoit aussi une réaction (sa charge porte le message visé) et un
        // rapport RCS (`sent`/`unreachable`), qui ne sont pas des messages du client (revue finale du 2026-09-22).
        const unMessage = buttonPayload === null && canalRetour === 'whatsapp';
        await this.rendreLaMainAMba(tenantId, waId, unMessage ? { transmettre: messageId } : {});
      }
      return;
    }
    const ctx = await this.buildCtx(tenantId, waId, graph);
    const { actions, rest, canal: apresWalk } = await this.walkResolved(tenantId, waId, graph, next, ctx, run.id, run.channel ?? 'whatsapp', battement ?? undefined);
    // Un contact qui répond est unitaire par nature : ses tags publient.
    const { refus, partis, canal } = await this.apply(tenantId, waId, actions, undefined, true, run.workflowId, apresWalk, battement ?? undefined);
    // Même règle qu'au réveil : un envoi refusé n'attend aucune réponse. On clôt le run (en gardant
    // `lastMessageId`, sinon le même message serait re-traité) et on remonte la conversation à un humain.
    if (refus !== null) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${run.workflowId}: envoi refusé pour ${waId} : ${refus}`);
      if (partis === 0) {
        await ecrire({ currentNode: null, status: 'inbox', lastMessageId: messageId });
        // Remontee a l humain sans qu aucun bloc ne l ait demande (envoi refuse, fenetre fermee) : personne
        // n a designe d affectataire, le fil part au pot commun.
        if (this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId, null);
        return;
      }
    }
    await ecrire({ ...restToState(rest, this.now()), lastMessageId: messageId, channel: canal });
    if (rest.status === 'inbox' && this.deps.escalateToHuman) {
      await this.deps.escalateToHuman(tenantId, waId, rest.assigneA ?? null);
    }
    // Chaîne terminée sans attendre de choix : l'agent reprend. `waiting` garde la main (le scénario attend un
    // bouton), `inbox` la donne à un humain : ni l'un ni l'autre ne relâche.
    if (rest.status === 'done') await this.rendreLaMainAMba(tenantId, waId);
    // 🔴 TRANSITION FRAÎCHE vers un bloc agent, à ne pas confondre avec la branche du haut. Là-haut, le run
    // était DÉJÀ sur le bloc agent et le contact répondait pendant la conversation. Ici, sa réponse fait
    // AVANCER le parcours depuis un autre bloc (typiquement un template de campagne) jusqu'au bloc agent, pour
    // la première fois : il faut donc ouvrir la session et enfiler le premier tour. Sans ça, le run était posé
    // en attente sur le bloc agent SANS session et SANS tour, l'agent restait muet, et l'anomalie n'était
    // découverte qu'au message suivant du contact, par le filet du haut qui escalade en inbox.
    // C'est le montage central du produit : template de campagne, puis l'agent reprend la main sur la réponse.
    // Pas de garde de fenêtre ici, contrairement à `resume` et `runFrom` : `advance` n'est déclenché que par un
    // message ENTRANT, donc la fenêtre est ouverte par construction.
    if (rest.status === 'agent_turn') {
      await this.demarrerTourAgent(tenantId, waId, { id: run.id, workflowId: run.workflowId }, graph, rest.nodeId);
    }
    } catch (err) {
      /**
       * 🔴 L'ERREUR EMPORTE SON CONTEXTE (constat B1 de l'audit externe du 2026-09-02). Le journal des échecs
       * d'avance (migration 0108) a trois colonnes `workflow_id`, `run_id` et `canal` que PERSONNE ne
       * remplissait : le point de journalisation est le handler de webhook, qui ne connaît que le contact et
       * le message. Résultat, la jointure qui cherche le nom du scénario ne rendait jamais rien, et
       * l'exploitant lisait « ce contact est bloqué » sans jamais savoir DANS QUEL parcours.
       *
       * Le contexte, lui, est ici, et seulement ici. On l'attache donc à l'erreur qui remonte, sans changer
       * quoi que ce soit au flux : on ré-émet la MÊME erreur, avec sa pile. Pas de classe d'erreur nouvelle,
       * pas de valeur de retour transformée, rien qu'un appelant puisse casser en l'ignorant.
       */
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        contexteAvance: { workflowId: run.workflowId, runId: run.id, canal: canalRetour },
      });
    } finally {
      // Le battement s'arrête AVANT la libération, et dans tous les cas : un renouvellement qui survit à son
      // avance tiendrait un tour que plus personne ne travaille, donc gèlerait le contact jusqu'au bail.
      battement?.arreter();
      // Libération BEST-EFFORT : ne pas y arriver coûte au pire l'attente du bail, jamais un message perdu.
      // Dans le `finally` pour que le tour soit rendu même si un envoi jette : sinon le message SUIVANT du
      // contact attendrait la fin du bail pour rien.
      if (jeton !== null && this.deps.runs.libererAvance) {
        await this.deps.runs.libererAvance(run.id, jeton).catch(() => {});
      }
    }
  }
}
