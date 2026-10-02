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
import { MOTIF_DESABONNE } from '../campaign/guardrails';
import { messageDe, texteDe } from '../lib/erreur';

/**
 * Résultat d'un démarrage : `true` = parti, une chaîne = pas parti, avec la raison exacte (pour que la
 * campagne affiche la cause qui s'applique, pas toutes les causes possibles).
 */
export type StartOutcome = true | string;

/**
 * Ce que rend une dep d'envoi : `void` (parti), une chaîne portant la raison d'un non-envoi, ou
 * `{ messageId }`. La raison d'un refus décidé dans le worker (visuel de carousel non re-téléversé, variable
 * introuvable, template illisible) remonte ainsi jusqu'au destinataire, au lieu d'un « envoyé » à l'écran.
 */
export type SendRefusal = void | string | { messageId: string };

/**
 * L'identifiant Meta d'un envoi réussi, quand la dépendance le remonte. `void` reste un succès et une chaîne
 * non vide un refus ; `{ messageId }` permet de rattacher plus tard un accusé de livraison ou de lecture au
 * bloc qui a envoyé (les statuts Meta ne parlent que d'un identifiant de message).
 */
export function messageIdDe(issue: SendRefusal): string | undefined {
  return typeof issue === 'object' && issue !== null && typeof issue.messageId === 'string' ? issue.messageId : undefined;
}

/**
 * Les actions qui font partir un message, et elles seules.
 *
 * 🔴 Cette liste est la définition de « envoyer » pour la garde d'opt-out : en oublier une laisserait partir
 * ce canal vers un contact qui a dit STOP, sans erreur. Un test la compare aux `kind` que le dispatch
 * d'`apply` traite comme des envois. Le RCS y est couvert par `sendQuickMessage`, que le canal du parcours
 * fait partir en RCS (cf. `envoyerQuickEnRcs`).
 */
export const EST_UN_ENVOI: ReadonlySet<string> = new Set([
  'sendTemplate', 'sendQuickMessage', 'sendQuestion', 'sendFlow', 'sendEmail',
]);

/** Les envois qui partent toujours par WhatsApp, quel que soit le canal du parcours (cf. `apply`). */
const TOUJOURS_WHATSAPP: ReadonlySet<string> = new Set(['sendTemplate', 'sendFlow', 'sendQuestion']);

/**
 * Ce parcours fera-t-il partir un message par WhatsApp ? `runFrom` le demande avant tout effet, pour refuser
 * un numéro délié avant l'e-mail ou l'appel API qui précéderaient l'envoi refusé.
 *
 * Même règle que `apply` : modèle, formulaire et question partent toujours par WhatsApp ; un message rapide
 * suit le canal du parcours, qui ne change en cours de liste que par un envoi WhatsApp (déjà compté ici).
 * Un e-mail seul, un RCS seul, des actions seules : « non », le scénario tourne sur un numéro délié.
 */
export function envoieParWhatsApp(steps: readonly WalkStep[], canalEntrant: RunChannel): boolean {
  return steps.some(({ action: a }) => TOUJOURS_WHATSAPP.has(a.kind) || (a.kind === 'sendQuickMessage' && canalEntrant === 'whatsapp'));
}

/**
 * Le graphe que ce parcours joue : le sien s'il en porte un (parcours de test démarré sur le brouillon), le
 * publié sinon. Point de passage unique pour tous les points de reprise (`resume`, `runEnAttenteSur`,
 * `advance`) : sinon un test changerait de version en cours de route. `grapheFige` à null est le cas normal.
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
     * Crée le parcours. `grapheFige` est un paramètre à part, pas un champ de `RunState` : il s'écrit une
     * seule fois, ici, et les écritures d'état l'auraient ignoré en silence.
     */
    start(tenantId: string, workflowId: string, waId: string, contactId: string | null, state: RunState, grapheFige: WorkflowGraph | null): Promise<{ id: string }>;
    findWaitingByWaId(tenantId: string, waId: string): Promise<WorkflowRunRow | null>;
    setState(id: string, state: RunState): Promise<void>;
    /**
     * Clôt le parcours actif du contact (`waiting` ou `sleeping`). Requise : elle tient l'invariant « au plus
     * un parcours actif par contact ». Sans elle, l'ancien parcours resterait invisible de
     * `findWaitingByWaId` mais réveillable par `claimDueQuestions`.
     */
    closeActiveByWaId(tenantId: string, waId: string): Promise<string[]>;
    /**
     * Écrit l'état seulement si le parcours vit encore. `false` = il a été clos entre-temps, et l'écriture
     * l'aurait ressuscité avec une échéance. Requise ; les fixtures passent `avecGardesDEtatInertes`
     * (`tests/executeur-inerte.ts`).
     */
    setStateSiVivant(tenantId: string, id: string, state: RunState): Promise<boolean>;
    /**
     * Écriture conditionnelle : n'écrit que si le run attend toujours sur `nodeId` (`false` = quelqu'un
     * d'autre l'a fait avancer). `token` : le jeton du tour, pour qu'un porteur de bail périmé n'écrive pas
     * par-dessus celui qui l'a repris ; `null` = aucune réservation. Requise ; fixtures :
     * `avecGardesDEtatInertes`.
     */
    setStateSiEncoreSur(tenantId: string, id: string, nodeId: string | null, state: RunState, token?: string | null): Promise<boolean>;
    /**
     * Réserve le tour d'avance avant tout envoi. `null` = un autre traitement le tient, l'appelant sort sans
     * rien faire : c'est ce qui ferme le double envoi. Optionnelle : absente, aucune réservation (fixtures, e2e).
     */
    reserverAvance?(tenantId: string, id: string, nodeId: string | null, bailSecondes: number): Promise<string | null>;
    /**
     * Prolonge le bail tant que l'avance travaille (`false` = tour repris, on cesse de battre ; cf.
     * `bail-avance.ts`). Optionnelle : absente, aucun renouvellement.
     */
    prolongerAvance?(id: string, token: string, bailSecondes: number): Promise<boolean>;
    /** Rend le tour. Le jeton garantit qu'un porteur de bail périmé ne libère pas le verrou d'un autre. */
    libererAvance?(id: string, token: string): Promise<void>;
  };
  getGraph(workflowId: string, tenantId: string): Promise<WorkflowGraph | null>;
  /** Pose un tag. Rend idéalement `true` si le tag était réellement nouveau : c'est ce qui décide d'émettre
   *  « tag ajouté » (reposer un tag présent n'est pas un événement). `void` (fakes) est traité comme nouveau. */
  applyTag(tenantId: string, waId: string, tag: string): Promise<void | boolean>;
  setField(tenantId: string, waId: string, key: string, value: string): Promise<void>;
  /** Retire un tag du contact (bloc Action « retirer un tag »). */
  removeTag(tenantId: string, waId: string, tag: string): Promise<void>;
  /** Vide un champ du contact = retire la clé (bloc Action « vider un champ »). */
  clearField(tenantId: string, waId: string, key: string): Promise<void>;
  /**
   * Pose le consentement marketing du contact (bloc « Action » d'un scénario). Requise : le câblage de
   * production la fournit toujours, et les fixtures qui ne la regardent pas passent `consentementNonEcrit`.
   */
  setOptIn(tenantId: string, waId: string, value: 'opted_in' | 'opted_out'): Promise<void>;
  /**
   * Enregistre une mesure par bloc (Analytics > Mes tableaux). Requise : le câblage de production la fournit
   * toujours, et les fixtures qui ne mesurent rien passent `aucuneMesure`.
   */
  recordNodeEvent(e: {
    tenantId: string; workflowId: string; nodeId: string; waId: string;
    kind: 'sent' | 'failed' | 'reply_button' | 'reply_text'; handle?: string; metaMessageId?: string;
  }): Promise<void>;
  /**
   * `buttons` = boutons du template (payload contrôlé sur les quick-reply). `explicitParams` = variables du
   * corps déjà résolues (campagne workflow, 1er template), sinon résolution via les hints. Rend `void` si
   * parti, une chaîne portant la raison si rien n'est parti (voir `SendRefusal`).
   */
  sendTemplate(tenantId: string, waId: string, templateName: string, language: string, buttons: WorkflowButton[], explicitParams?: string[]): Promise<SendRefusal>;
  /**
   * Ce contact a-t-il demandé à ne plus être contacté ?
   *
   * 🔴 C'est la garde d'opt-out des envois qui passent par cet exécuteur (scénario, automation). L'agent IA
   * répond sans passer par `apply` et porte sa propre garde (`src/agent/run-turn.ts`) ; la campagne et l'API
   * publique filtrent en amont (`optInAllows`). Requise : optionnelle, un câblage qui l'oublie compilerait et
   * écrirait au contact qui a répondu STOP. Les tests passent `jamaisDesabonne` (`tests/consentement.ts`).
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Lève `NumeroDelieError` si le numéro WhatsApp de l'espace est délié ; ne fait rien sinon, y compris sans
   * numéro (l'envoi dira alors pourquoi il ne part pas).
   *
   * Elle précède la garde, qui vit au point de passage des envois (`MetaClientFactory.clientForTenant`) et ne
   * se pose qu'au moment de l'envoi WhatsApp : un scénario « e-mail, puis modèle » enverrait l'e-mail,
   * buterait sur le modèle, et renverrait l'e-mail à la reprise. `runFrom` l'appelle donc avant tout effet,
   * dès que le parcours contient un envoi WhatsApp (`envoieParWhatsApp`). Requise (no-op en `DRY_RUN`) ;
   * fixtures : `numeroJamaisDelie`.
   */
  verifierNumeroWhatsApp(tenantId: string): Promise<void>;
  /** Envoie un message hors template : interactif (texte + réponses rapides, ou un bouton de lien), image
   *  légendée, ou simple texte. Toujours en fenêtre 24 h (atteint après une réponse du contact, ou par
   *  `startFromNode` après vérification de la fenêtre).
   *
   *  `mediaUrl` = visuel hébergé chez nous, téléversé chez Meta et posé en en-tête (ou image légendée sans
   *  bouton). `lien` = bouton de lien, exclusif des réponses rapides (l'action arrive alors avec `buttons`
   *  vide).
   *
   *  Sixième paramètre : une implémentation qui n'en déclare que cinq compile et avale le lien en silence
   *  (une flèche à moins de paramètres reste assignable). Le vrai câblage est tenu par
   *  `tests/workflow-lien-bouton.test.ts`. */
  sendQuickMessage(tenantId: string, waId: string, body: string, buttons: WorkflowButton[], mediaUrl?: string, lien?: LienBouton): Promise<SendRefusal>;
  /** Envoie un formulaire (message interactif type flow) hors template. Même contrainte de fenêtre 24 h que
   *  sendQuickMessage. */
  sendFlow(tenantId: string, waId: string, flowId: string, body: string, cta: string): Promise<SendRefusal>;
  /**
   * Envoie une question : liste interactive WhatsApp quand `rows` porte au moins un libellé, simple texte
   * sinon. Même contrainte de fenêtre 24 h. `rows` arrive entier : le câblage filtre à l'envoi en préservant
   * l'index, qui est la sortie de scénario (`row:<i>`).
   */
  sendQuestion(tenantId: string, waId: string, body: string, buttonLabel: string, rows: QuestionRow[]): Promise<SendRefusal>;
  /** Envoie l'email du bloc « Envoi de mail » (boîte SMTP, modèle, destinataires, rendu des variables).
   *  Best-effort : `apply` l'appelle sous try/catch, et un échec (boîte ou modèle supprimé, SMTP injoignable,
   *  destinataire vide) n'interrompt jamais le parcours, contrairement aux canaux WhatsApp/RCS. Rend la
   *  raison de l'échec (chaîne non vide), qui est mesurée, ou rien si le mail est parti. Optionnelle :
   *  absente, no-op. */
  sendEmail?(tenantId: string, waId: string, action: SendEmailAction): Promise<string | void>;
  /**
   * Canal RCS, toujours câblé en production. Un espace sans agent RCS (`agentIdFor` rend `null`) : un bloc
   * `rcs_message` n'envoie rien et part toujours sur sa sortie « non joignable ». Fixtures : `rcsSansAgent`.
   */
  rcs: {
    sender: RcsSender;
    /** Agent RCS du tenant (`rcs_agents.agent_id`). null = tenant sans agent configuré. */
    agentIdFor(tenantId: string): Promise<string | null>;
    /**
     * Table de substitution des variables `{{champ}}` du contact. Optionnelle : absente, le message part avec
     * ses accolades (visible, donc préférable à un envoi bloqué). Appelée seulement si le message porte une
     * variable.
     */
    varsFor?(tenantId: string, waId: string): Promise<Record<string, string | null>>;
    /**
     * Journalise l'envoi RCS dans le fil de conversation, comme les envois WhatsApp d'un scénario, pour que
     * l'opérateur voie la question et pas seulement la réponse. Best-effort : un échec de journal ne fait
     * jamais échouer un envoi déjà parti.
     */
    recordOutbound(tenantId: string, waId: string, msg: { body: string; messageId: string }): Promise<void>;
    /**
     * Jeton public du contact qui porte ce numéro, pour savoir qui a cliqué sur un lien du message. `null` =
     * liens tracés mais anonymes. Un scénario envoie à une personne à la fois : une lecture unitaire suffit.
     */
    jetonPour(tenantId: string, waId: string): Promise<string | null>;
  };
  /** Horloge (tests). Absente -> Date.now(). Sert à l'échéance d'un bloc Attente. */
  now?: () => number;
  /**
   * La fenêtre de service 24 h est-elle ouverte pour ce contact ? Utilisée à la reprise d'un parcours
   * endormi : elle court depuis le dernier message du contact, donc même une attente courte peut la voir se
   * fermer. Dans le doute, fermée : mieux vaut ne pas envoyer que se faire refuser par Meta et compter l'envoi
   * comme parti. Fixtures : `fenetreToujoursFermee`.
   */
  isWindowOpen: (tenantId: string, waId: string) => Promise<boolean>;
  /**
   * Rend la main à l'app sur un fil (inverse d'`escalateToHuman`), au lancement voulu d'un parcours : sans
   * ça, le scénario se bloquerait à la première réponse du contact. Rend `false` quand Meta a refusé de retirer
   * le contact de la liste de son agent : un démarrage condamné doit échouer tout de suite, avec sa raison, au
   * lieu d'un parcours gelé pendant que l'agent de Meta répond. `void` (tests) vaut succès ; fixtures : `repriseSansObjection`.
   * `saufOperateur` : un démarrage que le client déclenche (clic sur une publicité, arrivée par un widget) ne prend
   * pas le fil à un opérateur qui le tient, et `'operateur'` le dit (`src/inbox/fil.ts`).
   */
  reclaimControl: (tenantId: string, waId: string, opts?: { saufOperateur?: boolean }) => Promise<boolean | void | 'operateur'>;
  /**
   * Le scénario a-t-il le droit d'écrire dans ce fil ? false dès qu'un opérateur (`app_human`) ou l'agent de
   * Meta (`mba`) le détient. Requis ; fixtures : `filToujoursANous`.
   */
  mayAct(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Construit le contexte d'évaluation d'un contact (fields/tags/opt-in/attributs, fuseau et horaires du
   * tenant, `now`) pour les conditions et les valeurs dynamiques. null si le contact est introuvable : les
   * conditions prennent 'false' et une valeur dynamique est vide (fixtures : `contexteIntrouvable`).
   * `besoins` : la dernière saisie coûte une requête, lue seulement si le graphe la réclame.
   */
  evalContext(tenantId: string, waId: string, besoins?: { derniereSaisie: boolean }): Promise<EvalContext | null>;
  /**
   * Remonte la conversation à un humain (`control_owner = app_human`), sinon le bloc inbox serait un arrêt
   * silencieux. `assigneA` : le membre désigné par le bloc, `null` = au pot commun. Fixtures :
   * `personneNeReprend`.
   *
   * `escalade` est obligatoire : il dit si quelqu'un attend une réponse (bloc « passer à un humain », bouton
   * sans suite, envoi refusé alors que le contact vient d'écrire). La conversation entre alors dans « À
   * traiter » tout de suite, et le balayage ne rend plus le fil à l'agent de Meta tant que personne n'a
   * répondu. `false` pour les échecs de réveil : le contact n'attend rien, et rendre ces fils collants les
   * soustrairait à l'agent pour toujours.
   *
   * `workflowId` : le scénario qui remonte la conversation, requis. Le câblage en tire la cause que la frise du
   * panneau Détail de l'Inbox affiche à côté du passage à l'équipe et de l'affectation qu'il pose (« automatique :
   * scénario Bienvenue », migrations 0192 et 0194) : un affectataire nommé par un bloc n'a pas d'auteur humain, et
   * chaque passage, `escalade` ou non, ouvre une demande du Quantitatif > Performance.
   */
  escalateToHuman(tenantId: string, waId: string, assigneA: string | null, escalade: boolean, workflowId: string): Promise<void>;
  /**
   * Joue un appel de la bibliothèque (Tools > Connecteurs API) pour ce contact, et rend ce qu'il faut ranger
   * dans un champ. Injectée, comme tout ce qui touche le réseau. Absente -> le bloc « Appel HTTP » ne fait
   * rien. `ok: false` = l'appel n'a pas abouti, et l'exécuteur vide le champ cible. `lecture` est REQUIS :
   * `pousse` quand le bloc n'a pas de champ cible (le corps de la réponse n'est pas lu, seul le succès
   * compte), `integre` sinon.
   */
  appelHttp?(tenantId: string, waId: string, requestId: string, lecture: 'pousse' | 'integre'): Promise<{ ok: boolean; valeur: string }>;
  /**
   * Exécute le JavaScript d'un bloc « Fonction JS » dans un bac à sable. Injectée : elle charge un module
   * WebAssembly que les tests de scénario n'ont pas à payer. Absente -> le bloc ne fait rien.
   */
  executerJs?(code: string, valeur: string, champSource?: string): Promise<{ ok: boolean; valeur: string }>;
  /**
   * Table de substitution des variables `{{champ}}` du contact, pour les messages WhatsApp d'un scénario
   * (message rapide, question) : la même que pour le RCS et les modèles d'e-mail (`contactVars`), pour
   * qu'une accolade veuille dire la même chose partout. Optionnelle, appelée seulement si le message porte
   * une accolade ; absente, le message part avec ses accolades. Sans rapport avec les variables
   * positionnelles `{{1}}` d'un template Meta.
   */
  varsFor?(tenantId: string, waId: string): Promise<Record<string, string | null>>;
  /**
   * État des conversations tenues par un bloc agent. Optionnel bien que toujours câblé en production :
   * absent, aucun bloc agent ne peut être servi, et aucune valeur inerte ne reproduit cette absence (une
   * fausse session s'ouvrirait et enfilerait un tour).
   */
  agentSessions?: AgentSessionStore;
  /**
   * Enfile un tour d'agent (fixtures : `aucunTourEnfile`, le run reste en attente sur le bloc). Un tour dure
   * de 3 à 20 s : il ne peut pas se jouer dans le handler de webhook, qui tiendrait la connexion Meta ouverte.
   */
  enqueueAgentTurn(job: AgentTurnJob): Promise<void>;
  /**
   * L'agent de Meta est-il allumé sur le numéro de ce tenant ? Il décide qu'une étape sans choix cesse de
   * bloquer le parcours, et qu'on rende le fil à Meta en fin de chaîne. Fixtures : `agentDeMetaEteint`.
   */
  mbaActifPour(tenantId: string): Promise<boolean>;
  /**
   * Rend le fil à l'agent de Meta (le contact sur sa liste, puis `release`) quand le parcours se termine sans
   * attendre de choix : chaîne finie, ou réponse à côté des boutons attendus.
   *
   * Tout envoi est supposé prendre le contrôle du fil, template compris : on relâche donc systématiquement.
   * Si c'est faux pour un template, on relâche dans le vide (une erreur journalisée) ; le pari inverse
   * laisserait l'agent muet sur tous les destinataires d'une campagne. Best-effort ; fixtures :
   * `filJamaisRendu`.
   */
  releaseToMba(tenantId: string, waId: string): Promise<void>;
  /**
   * Transmet à l'agent de Meta le message « à côté » du client, une fois le fil rendu : sans lui, l'agent ne
   * parlerait qu'au message suivant et la question resterait sans réponse. Appelée seulement par la branche
   * « il a écrit » d'`advance`, sur un vrai message WhatsApp. Best-effort ; fixtures : `rienATransmettre`.
   */
  transmettreHorsParcours(tenantId: string, waId: string, messageId: string): Promise<void>;
  /**
   * Publie « ce tag vient d'être posé » pour les automations. Seulement sur un démarrage unitaire (réponse
   * d'un contact, automation, test), jamais depuis une campagne : voir `apply`. Fixtures : `aucunEvenement`.
   */
  emitTagAdded(tenantId: string, waId: string, tag: string): Promise<void>;
}

/** Message RCS porté par un bloc. null = bloc non configuré : on ne devine pas un contenu, on part en repli. */
function rcsOutboundOf(node: WorkflowNode | undefined): RcsOutbound | null {
  if (!node) return null;
  const text = String(node.data.text ?? '').trim();
  if (!text) return null;
  // Les boutons passent par le même schéma que la bibliothèque et l'assistant de campagne. Un bouton malformé
  // est écarté plutôt qu'envoyé au provider, qui refuserait le message entier.
  const boutons = Array.isArray(node.data.suggestions)
    ? node.data.suggestions.map((b) => rcsSuggestionSchema.safeParse(b)).filter((r) => r.success).map((r) => r.data)
    : [];
  // Visuel d'en-tête -> le message devient une carte, comme dans la bibliothèque (`web/lib/rcs.ts`, même
  // limite de 4 boutons). Dans la carte, les boutons s'affichent pleine largeur ; au-delà de quatre, le
  // surplus retombe en pastilles sous le message plutôt que d'être perdu.
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
 *  a déjà son propre `visited` par appel, ce plafond borne l'enchaînement de walks. */
const MAX_RCS_ENCHAINES = 20;

export function restToState(rest: WalkRest, now: number): RunState {
  if (rest.status === 'waiting') {
    // Bloc Question à échéance : le run reste `waiting` (une réponse du contact doit pouvoir le reprendre, et
    // `findWaitingByWaId` ne voit que `waiting`) et porte en plus un `resume_at` pour le balayeur de réveil.
    if (rest.timeoutInMs !== undefined) {
      return { currentNode: rest.nodeId, status: 'waiting', resumeAt: new Date(now + rest.timeoutInMs) };
    }
    return { currentNode: rest.nodeId, status: 'waiting' };
  }
  // Sommeil : le bloc Attente reste la position courante, avec l'échéance. Le réveil repart de son successeur
  // (repasser le bloc rendormirait le parcours en boucle).
  if (rest.status === 'sleeping') return { currentNode: rest.nodeId, status: 'sleeping', resumeAt: new Date(now + rest.resumeInMs) };
  if (rest.status === 'inbox') return { currentNode: null, status: 'inbox' };
  // Bloc agent : le run attend sur le bloc, pour que `findWaitingByWaId` retrouve le parcours au message
  // suivant. Cas explicite : le `return` final le clorait en `done` au moment où l'agent prend la main.
  if (rest.status === 'agent_turn') return { currentNode: rest.nodeId, status: 'waiting' };
  return { currentNode: null, status: 'done' };
}

/**
 * Orchestre l'exécution d'un workflow : applique les actions du moteur pur et persiste l'état du run. IO
 * injectée -> testable sans base ni réseau. `runFrom` démarre un run pour un contact, `advance` fait avancer
 * le run en attente quand le contact répond (idempotent par message, dédup at-least-once).
 */
export class WorkflowExecutor {
  constructor(private readonly deps: WorkflowExecutorDeps) {}

  /** Horloge injectable (tests). Sert au calcul de l'échéance d'un bloc Attente. */
  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Construit le contexte d'évaluation seulement si le graphe en a besoin (condition, valeur dynamique,
   * attente datée) : les scénarios tag/template purs évitent deux requêtes par étape. Une erreur de
   * `evalContext` est absorbée -> ctx undefined -> conditions 'false' (fail-closed).
   */
  private async buildCtx(tenantId: string, waId: string, graph: WorkflowGraph): Promise<EvalContext | undefined> {
    // Les valeurs dynamiques d'un bloc « poser un champ » : `maintenant` et `derniere_saisie`.
    const valeurDynamique = (n: { type: string; data: Record<string, unknown> }): string | null => {
      const dyn = n.data.valueKind === 'now' || n.data.valueKind === 'derniere_saisie';
      if (n.type === 'field' && dyn) return String(n.data.valueKind);
      if (n.type === 'action' && n.data.actionKind === 'set_field' && dyn) return String(n.data.valueKind);
      return null;
    };
    // Un bloc Attente daté en a besoin aussi : sans contexte, `waitResumeInMs` rend 0, le bloc devient un
    // passe-plat, et « attendre jusqu'aux heures ouvrées » envoie à 1 h du matin.
    const needsCtx = graph.nodes.some((n) => n.type === 'condition' || valeurDynamique(n) !== null
      || (n.type === 'wait' && waitMode(n) !== 'delai'));
    if (!needsCtx) return undefined;
    // Une requête de plus seulement si un bloc réclame la dernière saisie.
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
   * `apply` : applique les actions d'un parcours. `emitEvents` = ce démarrage est-il unitaire (un contact,
   * ici et maintenant) ? Seuls ces chemins publient les événements d'automation (« tag ajouté »).
   *
   * 🔴 Ce n'est pas la dep `applyTag` qui publie : le même exécuteur sert les campagnes, et 5 000
   * destinataires dont le graphe pose un tag déclencheraient 5 000 scénarios et autant de messages facturés.
   * Défaut `false` : on n'émet que si l'appelant prouve qu'il est unitaire.
   *
   * `firstTemplateParams` : variables du corps déjà résolues. Un walk depuis un seul point d'entrée s'arrête
   * au 1er bloc bloquant, donc produit au plus un `sendTemplate` : ces params ne s'appliquent qu'à lui.
   */
  /**
   * Un message rapide envoyé sur le canal RCS. Le bloc dit l'intention, le parcours porte le canal : un
   * message rapide derrière un bloc RCS doit partir en RCS, pas en WhatsApp vers un contact qui n'y a jamais
   * écrit (refusé par Meta, fenêtre de 24 h). Les libellés deviennent des boutons réponse, dans le même
   * ordre, pour que le clic revienne sur la bonne sortie (`btn:<i>`).
   */
  private async envoyerQuickEnRcs(
    tenantId: string,
    waId: string,
    a: { body: string; buttons: WorkflowButton[]; mediaUrl?: string; lien?: LienBouton },
  ): Promise<SendRefusal> {
    const rcs = this.deps.rcs;
    const agentId = await rcs.agentIdFor(tenantId);
    if (!agentId) return "le canal RCS n'est pas activé sur cet espace";
    // Le bouton de lien a un équivalent RCS natif (`openUrl`) : l'ignorer ferait partir le message sans son
    // bouton. Libellé borné à 20 comme côté WhatsApp (le RCS en accepte 25), pour un rendu identique sur les
    // deux canaux. `postbackData` hors de l'espace `btn:<i>` : un clic sur un lien ne correspond à aucune
    // branche du scénario.
    const probleme = a.lien ? problemeLienBouton(a.lien) : null;
    if (probleme) return probleme;
    const suggestions: RcsSuggestion[] = a.lien
      ? [{ kind: 'openUrl' as const, text: a.lien.texte.trim().slice(0, 20), url: a.lien.url.trim(), postbackData: 'lien' }]
      : a.buttons
        .filter((b) => b.type === 'QUICK_REPLY' && b.text.trim() !== '')
        .slice(0, 11)
        .map((b, i) => ({ kind: 'reply' as const, text: b.text.trim(), postbackData: `btn:${i}` }));
    // Un visuel exige une carte RCS (le texte nu n'en porte pas), sinon l'image disparaîtrait en silence. Les
    // boutons restent sous le message (11 max) plutôt que dans la carte (4 max).
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
   * `journaliserRcs` : écrit l'envoi RCS dans le fil de conversation. Best-effort strict : le message est
   * déjà parti, un incident de journal ne doit jamais le faire passer pour un échec.
   */
  /**
   * Le jeton public du destinataire, pour attribuer les clics des liens de ce message. Lu seulement si le
   * message porte un lien traçable : pas de requête ni d'identifiant public pour qui n'a rien à cliquer.
   * Best-effort : un échec de lecture rend un lien anonyme, jamais un envoi raté.
   */
  private async jetonRcs(tenantId: string, waId: string, msg: RcsOutbound): Promise<string | undefined> {
    if (!aDesLiensTracables(msg)) return undefined;
    return (await this.deps.rcs.jetonPour(tenantId, waId).catch(() => null)) ?? undefined;
  }

  private async journaliserRcs(tenantId: string, waId: string, msg: RcsOutbound, messageId: string): Promise<void> {
    try {
      await this.deps.rcs.recordOutbound(tenantId, waId, { body: apercuRcsSortant(msg), messageId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`journal du message RCS ignoré pour ${waId}:`, messageDe(err));
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
     * Le tour est-il encore à nous ? Posée avant chaque effet, pas une fois à l'entrée : une liste d'effets
     * peut durer plusieurs minutes. Absente pour les chemins qui ne réservent pas de tour (`start`, `runFrom`).
     */
    garde?: GardeDuTour,
  ): Promise<{ refus: string | null; partis: number; canal: RunChannel }> {
    let canal: RunChannel = canalEntrant;
    const posedTags: string[] = [];
    // Un walk peut produire plusieurs envois (un message rapide sans bouton ne bloque pas). On retient la
    // première raison de refus et on compte ce qui est parti : un refus n'est décisif que si rien n'est parti.
    let refus: string | null = null;
    let partis = 0;
    /** Réponse de la garde d'opt-out, lue au plus une fois par liste d'effets. `null` = pas encore posée. */
    let desabonne: boolean | null = null;
    for (const { nodeId, action: a } of steps) {
      // On s'arrête ici, entre deux effets, si le tour n'est plus à nous : le jeton clôture l'écriture d'état
      // mais ne peut rien contre un message déjà remis à Meta. Sans ce point de contrôle, un porteur déchu
      // finirait sa liste d'envois en parallèle du nouveau porteur, et le contact recevrait les deux.
      const perdu = garde?.perduPourquoi() ?? null;
      if (perdu !== null) {
        // eslint-disable-next-line no-console
        console.warn(`workflow ${workflowId ?? '?'}: effets INTERROMPUS pour ${waId} au bloc ${nodeId} (${perdu}), ${partis} envoi(s) déjà partis`);
        refus ??= `tour perdu pendant les effets (${perdu})`;
        break;
      }
      /**
       * 🔴 Un contact désabonné ne reçoit aucun envoi automatique : vérifié ici, point de passage commun du
       * scénario et de l'automation. On saute l'envoi sans arrêter le parcours (`continue`, pas `break`) : un
       * tag « a dit stop » doit encore se poser, on refuse de lui parler, pas de tenir sa fiche à jour. Lu une
       * seule fois par liste d'effets.
       */
      if (EST_UN_ENVOI.has(a.kind)) {
        desabonne ??= await this.deps.estDesabonne(tenantId, waId);
        if (desabonne) {
          refus ??= MOTIF_DESABONNE;
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
       * Un échec vide le champ, il ne le laisse pas tel quel : la suite branche une condition sur ce champ, et
       * une valeur périmée ferait prendre la bonne branche pour de mauvaises raisons. Un champ vide se teste.
       * Best-effort : un connecteur en panne n'arrête pas le parcours (l'échec est journalisé au câblage).
       */
      else if (a.kind === 'appelHttp') {
        // Le test du `kind` d'abord, la dépendance ensuite : `a.kind === 'appelHttp' && this.deps.appelHttp`
        // ferait tomber un appel HTTP sans câblage dans la branche suivante, donc le traiter comme un template.
        // Même forme que `sendEmail`.
        if (this.deps.appelHttp) {
          // Sans champ cible, l'appel pousse : rien à ranger, et surtout aucun `setField('')` sur une clé vide.
          const pousse = a.champCible === '';
          const r = await this.deps.appelHttp(tenantId, waId, a.requestId, pousse ? 'pousse' : 'integre');
          if (!pousse) await this.deps.setField(tenantId, waId, a.champCible, r.ok ? r.valeur : '');
        }
      }
      /**
       * La valeur d'entrée est relue ici, pas prise au walk : « Appel API » range une réponse dans un champ,
       * puis « Fonction JS » la transforme, et une photo prise au walk servirait la valeur d'avant l'appel. Un
       * champ source absent donne une chaîne vide (la fonction du client décide). Échec : champ cible vidé.
       */
      else if (a.kind === 'fonctionJs') {
        if (this.deps.executerJs) {
          /**
           * `now` est l'instant du passage, pas un champ de la fiche (il change à chaque passage), en ISO UTC, la
           * seule forme que `new Date(valeur)` relit sans ambiguïté dans le bac à sable.
           */
          // Le contexte n'est lu que pour un vrai champ : « maintenant » ne touche pas la base.
          const evalCtxFields = a.champSource === CHAMP_MAINTENANT
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
      else if (a.kind === 'optIn') await this.deps.setOptIn(tenantId, waId, a.value);
      // Best-effort strict, contrairement aux canaux WhatsApp/RCS : un envoi email raté est journalisé mais
      // n'arrête jamais le parcours ni ne compte comme un refus.
      else if (a.kind === 'sendEmail') {
        // Dep absente (suites à deps minimales) : no-op total, sans mesure (mesurer inventerait un « envoyé »).
        if (this.deps.sendEmail) {
          let echec: string | null = null;
          try {
            const dit = await this.deps.sendEmail(tenantId, waId, a);
            if (typeof dit === 'string' && dit !== '') echec = dit;
          } catch (err) {
            echec = texteDe(err);
          }
          if (echec !== null) {
            // eslint-disable-next-line no-console
            console.error(`workflow sendEmail: ${echec} (${waId}), on continue le parcours`);
          }
          // Un mail raté ne devient jamais un refus du parcours, mais il se mesure comme tout bloc de message.
          await this.mesurer(tenantId, workflowId, nodeId, waId, echec === null ? 'sent' : 'failed');
        }
      }
      else {
        /**
         * Les variables `{{champ}}` du contact, pour les deux blocs WhatsApp à corps libre (message rapide,
         * question) : même grammaire et même table que le RCS et les modèles d'e-mail (`contactVars`). La fiche
         * n'est lue que si le message en porte. Seul le corps est substitué, pas les libellés de boutons : 20
         * caractères chez Meta, un prénom long ferait refuser le message entier (même règle que le RCS).
         */
        const corpsAvecVariables = async (texte: string): Promise<string> => {
          if (!this.deps.varsFor || !/\{\{\s*[\w.-]+\s*\}\}/.test(texte)) return texte;
          return renderText(texte, await this.deps.varsFor(tenantId, waId), { html: false });
        };
        // Jamais `refus ??= await …` : `??=` n'évalue pas sa droite quand la gauche est remplie, et l'envoi
        // serait sauté. On envoie toujours, on ne garde que la 1re raison.
        const dit = a.kind === 'sendQuickMessage'
          // Le canal du parcours décide, pas le type du bloc. Voir `envoyerQuickEnRcs`.
          ? (canal === 'rcs'
            ? await this.envoyerQuickEnRcs(tenantId, waId, a)
            : await this.deps.sendQuickMessage(tenantId, waId, await corpsAvecVariables(a.body), a.buttons, a.mediaUrl, a.lien))
          // Une question part toujours en WhatsApp : la liste interactive n'a aucun équivalent RCS. Pas de
          // branche `canal === 'rcs'`, qui promettrait un repli inexistant.
          : a.kind === 'sendQuestion'
            ? await this.deps.sendQuestion(tenantId, waId, await corpsAvecVariables(a.body), a.buttonLabel, a.rows)
            : a.kind === 'sendFlow'
              ? await this.deps.sendFlow(tenantId, waId, a.flowId, a.body, a.cta)
              : await this.deps.sendTemplate(tenantId, waId, a.templateName, a.language, a.buttons, firstTemplateParams);
        const rate = typeof dit === 'string' && dit !== '';
        // Un template, un formulaire ou une question partent par WhatsApp et y ramènent le parcours (c'est ainsi
        // qu'on bascule de canal). Pour la question, l'oublier gèlerait le parcours : la réponse arriverait par
        // WhatsApp sur un run marqué `rcs`, et la garde d'étanchéité l'ignorerait.
        if (!rate && (a.kind === 'sendTemplate' || a.kind === 'sendFlow' || a.kind === 'sendQuestion')) canal = 'whatsapp';
        if (rate) {
          if (refus === null) refus = dit;
        } else {
          partis += 1;
        }
        // Mesure par bloc, après l'envoi, sur son issue réelle : compter avant gonflerait les « envoyés » de ce
        // que Meta a refusé. L'identifiant du message permettra à un accusé de lecture de retrouver ce bloc.
        await this.mesurer(tenantId, workflowId, nodeId, waId, rate ? 'failed' : 'sent', undefined, messageIdDe(dit));
      }
    }
    // Publication après toutes les actions, et seulement sur un chemin unitaire. Best-effort : la pose du tag
    // est acquise, un incident de file ne doit pas faire échouer le parcours.
    if (emitEvents && posedTags.length > 0) {
      for (const tag of posedTags) {
        try { await this.deps.emitTagAdded(tenantId, waId, tag); } catch { /* best-effort */ }
      }
    }
    return { refus, partis, canal };
  }

  /**
   * Enregistre une mesure par bloc, si le câblage la fournit et si l'on connaît le scénario. Best-effort
   * absolu : un compteur qui trébuche ne doit jamais faire échouer un parcours ni renvoyer un job en échec.
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
    if (!workflowId) return;
    try {
      await this.deps.recordNodeEvent({
        tenantId, workflowId, nodeId, waId, kind,
        ...(handle ? { handle } : {}),
        ...(metaMessageId ? { metaMessageId } : {}),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('mesure de bloc ignorée (best-effort):', messageDe(err));
    }
  }

  /**
   * Réveille un parcours au repos arrivé à échéance et le reprend. Gardes, dans l'ordre du code :
   *  1) `mayAct` : un opérateur ou MBA a pu reprendre le fil pendant le sommeil ; on n'écrit pas dessus.
   *  2) le graphe et le bloc suivant existent encore, sinon on clôt le run plutôt que de le laisser dormant.
   *  3) la fenêtre de service, relue seulement si la suite envoie un message de session : fermée -> on
   *     n'envoie pas et on remonte à un humain, plutôt que de compter un envoi fantôme.
   * Rend true si le parcours a repris, false s'il a été arrêté (clos ou remonté en inbox, jamais laissé
   * dormant, sinon il serait repris à chaque balayage).
   */
  async resume(run: {
    id: string; workflowId: string; tenantId: string; waId: string;
    contactId?: string | null; currentNode: string | null;
    /**
     * Le graphe figé du parcours, `null` pour tout parcours réel. Requis, pour que le balayage le transporte
     * jusqu'ici ; perdu, la reprise retomberait sur le publié.
     */
    grapheFige: WorkflowGraph | null;
    /** Canal courant du parcours. Absent -> WhatsApp (runs anciens). */
    channel?: RunChannel;
    /**
     * Pourquoi ce run était au repos, donc par où le reprendre : `sleeping` = bloc Attente, au bloc suivant ;
     * `waiting` = délai « pas de réponse » d'un bloc Question, par la sortie `timeout`. Absent -> `sleeping`.
     */
    status?: RunStatus;
  }): Promise<boolean> {
    const { tenantId, waId } = run;
    if (!(await this.deps.mayAct(tenantId, waId))) {
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
    // D'où repartir dépend de ce qui a expiré. Bloc Attente : le successeur (repasser sur l'attente la
    // rendormirait). Bloc Question : la sortie `timeout` et elle seule, car c'est la réponse qui décide de la
    // suite : `nextNode` enverrait un contact silencieux dans la branche du premier câblage venu.
    const parQuestion = run.status === 'waiting';
    // Une échéance consommée sur un bloc agent est une inactivité. Les autres sorties de `resume` closent la
    // session en `erreur`, parce qu'elles tuent le parcours pour une autre raison que le silence du contact.
    if (parQuestion) await this.cloreSessionDuRun(tenantId, run.id, 'inactivite', SORTIE_TIMEOUT);
    const suite = parQuestion
      ? nextNodeByHandle(graph, run.currentNode, SORTIE_TIMEOUT)
      : nextNode(graph, run.currentNode);
    if (!suite) {
      // Sortie « pas de réponse » non câblée : le parcours s'arrête, et on rend la main à l'agent de Meta,
      // qu'une question retenait (`etapeOffreUnChoix`), sinon il ne reprendrait jamais la parole.
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

    // Fenêtre de service fermée : on écarte les seuls messages de session (131047) et on applique le reste,
    // template compris, qui n'a pas besoin de la fenêtre.
    //
    // La fenêtre est une règle de Meta : un message rapide sur un parcours RCS part par `envoyerQuickEnRcs`,
    // sans fenêtre à respecter. Et le canal ne peut pas être lu une fois pour toutes : `apply` le fait muter
    // en cours de lot (un template ou un formulaire réussi ramène le parcours sur WhatsApp). On rejoue ici la
    // même mutation ordonnée, sinon on exempterait un envoi que Meta refuserait.
    const besoinsFenetre = new Set<WorkflowAction>();
    {
      let canalSimule = apresWalk;
      for (const e of actions) {
        const a = e.action;
        // Formulaire et question sont WhatsApp par nature (aucun équivalent RCS) : toujours soumis à la
        // fenêtre, quel que soit le canal simulé.
        if (a.kind === 'sendFlow' || a.kind === 'sendQuestion') besoinsFenetre.add(a);
        else if (a.kind === 'sendQuickMessage' && canalSimule !== 'rcs') besoinsFenetre.add(a);
        if (a.kind === 'sendTemplate' || a.kind === 'sendFlow') canalSimule = 'whatsapp';
      }
    }
    const aBesoinFenetre = (a: WorkflowAction): boolean => besoinsFenetre.has(a);
    // Le bloc agent exige la fenêtre alors qu'il ne produit aucune action : son premier message est un message
    // de session. Sans ce cas, « attente puis agent » réveillerait l'agent hors fenêtre (131047, modèle déjà
    // payé). On teste l'état réel de la fenêtre, jamais une déduction sur la durée de l'attente.
    const reveilleUnAgent = rest.status === 'agent_turn';
    let aExecuter = actions;
    let fenetreFermee = false;
    if (reveilleUnAgent || actions.some((e) => aBesoinFenetre(e.action))) {
      const ouverte = await this.deps.isWindowOpen(tenantId, waId);
      if (!ouverte) {
        fenetreFermee = true;
        aExecuter = actions.filter((e) => !aBesoinFenetre(e.action));
        // eslint-disable-next-line no-console
        console.error(`workflow ${run.workflowId}: fenêtre 24 h fermée à la reprise, message de session NON envoyé à ${waId} -> conversation remontée en inbox`);
      }
    }

    // `emitEvents` vrai : un réveil est unitaire (un contact, ici et maintenant), comme `advance`. Sinon
    // « attendre 1 jour puis poser le tag » ne déclencherait pas l'automation branchée sur ce tag.
    const { refus, partis, canal } = await this.apply(tenantId, waId, aExecuter, undefined, true, run.workflowId, apresWalk);
    // Un message du parcours n'a pas pu atteindre le contact : on clôt et on remonte à un humain. Ce qui
    // pouvait partir (template, tags) est déjà parti.
    if (fenetreFermee) {
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'inbox' });
      // Aucun affectataire (aucun bloc « passer à un humain » atteint) et aucune escalade : c'est un réveil,
      // le contact n'attend rien à cet instant.
      await this.deps.escalateToHuman(tenantId, waId, null, false, run.workflowId);
      return false;
    }
    // Refus au réveil sans qu'aucun message ne parte : laisser le run en attente le ferait repartir au bloc
    // suivant dès que le contact écrirait, sur un message jamais vu. On clôt et on remonte à un humain.
    if (refus !== null) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${run.workflowId}: envoi refusé à la reprise pour ${waId} : ${refus}`);
      if (partis === 0) {
        // Garde de vivacité : remonter une conversation déjà remplacée mettrait un opérateur sur un parcours
        // abandonné.
        if (!(await this.ecrireSiVivant(tenantId, run.id, { currentNode: null, status: 'inbox' }))) return false;
        // Sans bloc « passer à un humain » : pas d'affectataire (pot commun), et pas d'escalade au réveil
        // (voir `escalateToHuman`).
        await this.deps.escalateToHuman(tenantId, waId, null, false, run.workflowId);
        return false;
      }
    }
    // Seulement si le parcours vit encore : un autre chemin a pu le clore pendant nos envois, et écrire sans
    // regarder le ressusciterait avec son échéance.
    if (!(await this.ecrireSiVivant(tenantId, run.id, { ...restToState(rest, this.now()), channel: canal }))) return false;
    if (rest.status === 'inbox') {
      await this.deps.escalateToHuman(tenantId, waId, rest.assigneA ?? null, true, run.workflowId);
    }
    if (rest.status === 'done') await this.rendreLaMainAMba(tenantId, waId);
    // Bloc agent atteint au réveil : ouvrir la session et enfiler le premier tour, après les sorties anticipées
    // ci-dessus, sinon on créerait une session vivante sur un run déjà clos.
    if (rest.status === 'agent_turn') {
      await this.demarrerTourAgent(tenantId, waId, { id: run.id, workflowId: run.workflowId }, graph, rest.nodeId);
    }
    return true;
  }

  /**
   * `demarrerTourAgent` : un parcours vient d'atteindre un bloc agent, on ouvre sa session et on enfile le
   * premier tour. Partagé par `resume` et `runFrom` ; `advance` ne l'utilise pas (la session existe déjà).
   *
   * On enfile après l'écriture de l'état du run, à l'inverse d'`advance` : le claim du réveil est un bail,
   * et un échec ferait rejouer tout `resume`, donc renvoyer les messages déjà partis. Risque résiduel
   * assumé : si l'enfilage échoue, le run attend sur le bloc sans job, et le message suivant du contact le
   * répare (`advance` retrouve la session par `byRun`). On perd le premier message de l'agent, pas de doublon.
   */
  /**
   * Clôt la session d'agent d'un parcours qu'on tue ou qu'on fait sortir de son bloc agent, sur toutes les
   * sorties de `resume` qui tuent le run. Sans ça, la session resterait vivante pour toujours : l'index
   * partiel « une seule session vivante par parcours » la ferait réutiliser (`byRun ?? open`), tours et coût
   * déjà consommés, et l'agent serait muet. `byRun` ne rend que la session vivante.
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
      // `walk` ne rend `agent_turn` que sur un bloc configuré : si on passe ici, le graphe a changé sous nos
      // pieds, et on ne crée pas de session vers un agent inexistant.
      // eslint-disable-next-line no-console
      console.error(`workflow ${run.workflowId}: bloc agent ${nodeId} sans agentId au démarrage du tour, aucun tour enfilé`);
      return;
    }
    // Une session vivante laissée par un passage précédent ferait lever `open` sur l'index partiel « une
    // seule session vivante par parcours » : on la réutilise.
    const session = (await this.deps.agentSessions.byRun(tenantId, run.id))
      ?? (await this.deps.agentSessions.open({ tenantId, runId: run.id, agentId, nodeId, waId }));
    await this.deps.enqueueAgentTurn({
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
   * `walkResolved` : `walk` + résolution des blocs RCS. Sur un bloc `rcs_message`, le walk pur rend la main
   * (`rcs_send`) car la branche dépend d'un appel réseau (le numéro est-il joignable en RCS ?) : cette IO est
   * faite ici et nulle part ailleurs.
   *
   * Envoi réussi -> le run attend une réponse sur ce bloc, comme après un template. Non joignable, opt-out,
   * agent absent, bloc sans texte -> aucun envoi, on repart par la sortie « non joignable ». Sortie non
   * câblée -> parcours terminé, jamais la sortie « envoyé ». Les actions des walks successifs sont
   * accumulées : l'appelant les applique en un lot.
   */
  /** L'agent est-il allumé pour ce tenant ? */
  private async mbaActif(tenantId: string): Promise<boolean> {
    return this.deps.mbaActifPour(tenantId);
  }

  /**
   * Rend le fil à l'agent de Meta, sans jamais faire échouer le parcours qui l'appelle. Un release raté
   * laisse le fil à nous (l'agent reste muet, ce qui se voit dans l'Inbox), alors qu'une exception remontée
   * ferait échouer un envoi déjà parti.
   */
  private async rendreLaMainAMba(tenantId: string, waId: string, opts: { transmettre?: string } = {}): Promise<void> {
    if (!(await this.mbaActif(tenantId))) return; // gate : aucun appel Meta si l'agent n'est pas allumé
    try {
      await this.deps.releaseToMba(tenantId, waId);
      // Après le release, jamais avant : tant que nous tenons le fil, l'agent de Meta n'a pas la parole.
      if (opts.transmettre !== undefined) {
        await this.deps.transmettreHorsParcours(tenantId, waId, opts.transmettre);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`release vers MBA ignoré pour ${waId}:`, messageDe(err));
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
    /** Même garde que dans `apply` : ce parcours envoie du RCS en ligne, il n'est pas qu'un calcul. */
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
      const agentId = await this.deps.rcs.agentIdFor(tenantId);
      let envoye = false;
      // Ce parcours envoie, jusqu'à `MAX_RCS_ENCHAINES` messages d'affilée sans repasser par l'appelant : une
      // garde posée seulement dans `apply` laisserait passer le chemin RCS.
      const perduAvantRcs = garde?.perduPourquoi() ?? null;
      if (perduAvantRcs !== null) {
        // eslint-disable-next-line no-console
        console.warn(`rcs: envoi INTERROMPU pour ${waId} au bloc ${nodeId} (${perduAvantRcs})`);
        return { actions, rest: r.rest, canal };
      }
      if (agentId && brut) {
        // Variables `{{prenom}}` du contact, lues seulement si le message en porte.
        const msg = this.deps.rcs.varsFor && aDesVariables(brut)
          ? appliquerVariables(brut, await this.deps.rcs.varsFor(tenantId, waId))
          : brut;
        const jeton = await this.jetonRcs(tenantId, waId, msg);
        // On revérifie ici : `varsFor` et `jetonRcs` sont deux requêtes pendant lesquelles le bail a pu expirer.
        // Une garde se pose immédiatement avant l'effet, pas avant le travail qui le précède.
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
      // Le parcours bascule sur RCS seulement si le message est vraiment parti : un envoi sauté (désabonné,
      // agent absent) part au repli WhatsApp, et le canal suit ce que le contact a reçu.
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
   * Écrit l'état d'un parcours en reprise, seulement s'il vit encore. Point de passage unique des écritures
   * de `resume`, pour ne pas oublier la garde à l'une d'elles.
   */
  private async ecrireSiVivant(tenantId: string, runId: string, state: RunState): Promise<boolean> {
    const vivant = await this.deps.runs.setStateSiVivant(tenantId, runId, state);
    if (!vivant) {
      // eslint-disable-next-line no-console
      console.log(`workflow: parcours ${runId} clos pendant sa reprise, etat non reecrit (il a ete remplace)`);
    }
    return vivant;
  }

  /**
   * Corps commun des démarrages : parcourt depuis `startNodeId`, applique les actions, persiste l'état (sauf
   * 100 % synchrone -> done).
   *
   * `opts.allowSessionOpen` est la seule façon de lever la garde fenêtre 24 h : `startInWindow` (un entrant
   * récent prouve la fenêtre) et `startFromNode` (cible node de /v1/sends, fenêtre vérifiée destinataire par
   * destinataire quand le bloc ouvre par un message de session). Le défaut (`start`, campagne) la garde : ne
   * jamais l'inverser.
   *
   * Rend la raison lisible quand le run n'a pas démarré (bloc de départ absent, fil tenu par un humain ou MBA,
   * message de session hors fenêtre), pour que la campagne ne compte pas « envoyé » un destinataire qui n'a
   * rien reçu. `true` = le parcours a été appliqué.
   */
  private async runFrom(
    tenantId: string,
    workflowId: string,
    graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null },
    startNodeId: string,
    opts: { allowSessionOpen?: boolean; firstTemplateParams?: string[]; emitEvents?: boolean; ignoreHumanControl?: boolean; saufOperateur?: boolean; figerLeGraphe?: boolean } = {},
  ): Promise<StartOutcome> {
    // Un scénario n'écrit jamais dans un fil détenu par un opérateur ou par MBA, sinon les deux écriraient au
    // client. `ignoreHumanControl` : le déclencheur est lui-même le geste explicite (un opérateur qui lance une
    // campagne ou un scénario depuis l'Inbox, un contact qui clique un bouton de chaîne), et on reprend la main
    // pour l'app, sinon le scénario se bloquerait à la première réponse. Réservé aux automations nées d'un lien
    // de chaîne, d'une publicité ou d'un widget : une automation par mot-clé ordinaire écraserait l'opérateur qui
    // répond. Gardé dans les deux sens par `tests/automation-chaine-reprend-la-main.test.ts`. `saufOperateur` (la
    // publicité, le widget) : le clic du client reprend le fil à l'agent de Meta, jamais à un opérateur qui le
    // tient ; c'est le client qui déclenche, pas l'équipe.
    if (opts.ignoreHumanControl) {
      const reprise = await this.deps.reclaimControl(tenantId, contact.waId, { saufOperateur: opts.saufOperateur === true });
      if (reprise === 'operateur') {
        // eslint-disable-next-line no-console
        console.log(`workflow ${workflowId}: fil tenu par un opérateur, run non démarré pour ${contact.waId}`);
        return "la conversation est tenue par un opérateur : ce démarrage, déclenché par le contact, ne lui prend pas la main. Le message l'attend dans l'Inbox.";
      }
      // Une reprise qui échoue arrête le démarrage : sinon l'agent de Meta, qui a ce contact sur sa liste, répondrait
      // à la place du scénario. La raison remonte jusqu'au destinataire (`campaign_recipients.error`).
      if (reprise === false) {
        // eslint-disable-next-line no-console
        console.warn(`workflow ${workflowId}: contact ${contact.waId} NON retiré de la liste de l'agent de Meta, run non démarré`);
        return "le contact n'a pas pu être retiré de la liste de l'agent de Meta : le scénario n'a pas démarré, l'agent aurait répondu à sa place dès la première réponse du contact.";
      }
    } else if (!(await this.deps.mayAct(tenantId, contact.waId))) {
      // eslint-disable-next-line no-console
      console.log(`workflow ${workflowId}: fil détenu par un humain ou par MBA, run non démarré pour ${contact.waId}`);
      return "la conversation est tenue par un opérateur (ou par MBA) : ce déclenchement automatique n'écrit pas dedans. Rends la main depuis l'Inbox pour la rouvrir.";
    }
    // Bloc de départ absent du graphe (supprimé entre-temps) : `walk` rendrait un `done` vide, indiscernable
    // d'un parcours réussi sans action. On le signale, sinon la campagne compterait « envoyé ».
    if (!graph.nodes.some((n) => n.id === startNodeId)) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${workflowId}: bloc de départ ${startNodeId} introuvable, run non démarré pour ${contact.waId}`);
      // Sans parler de campagne : le lien de test d'un scénario, permanent, peut aussi désigner un bloc
      // supprimé depuis.
      return 'le bloc de départ n’existe plus dans le scénario';
    }
    const ctx = await this.buildCtx(tenantId, contact.waId, graph);
    // `sendKey` aléatoire : le run n'existe pas encore en base. Ce qui protège d'un double envoi ici, c'est le
    // claim atomique du destinataire côté campagne, pas l'idempotence RBM.
    const { actions, rest, canal: apresWalk } = await this.walkResolved(tenantId, contact.waId, graph, startNodeId, ctx, randomUUID());
    // Garde fenêtre 24 h : sans `allowSessionOpen`, un message de session en ouverture serait rejeté par Meta
    // (131047). `POST /campaigns` refuse déjà un tel scénario ; ceci est le filet à l'exécution. Le bloc agent
    // ne produit aucune action mais écrit du texte libre : on teste aussi le repos, sinon l'agent enverrait hors
    // fenêtre après que le modèle a été payé.
    const ouvreParUnAgent = rest.status === 'agent_turn';
    if (!opts.allowSessionOpen && (ouvreParUnAgent || actions.some((e) => e.action.kind === 'sendFlow' || e.action.kind === 'sendQuickMessage' || e.action.kind === 'sendQuestion'))) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${workflowId}: ouverture par un message de session (flow/message rapide/question/agent) hors fenêtre 24 h, run non démarré pour ${contact.waId}`);
      return ouvreParUnAgent
        ? "le scénario ouvre par un agent IA, qui écrit du texte libre : impossible hors de la fenêtre de 24 h"
        : "le scénario ouvre par un message rapide, une question ou un formulaire, impossible hors de la fenêtre de 24 h";
    }
    /**
     * Le numéro délié se vérifie ici, avant tout effet, dès que le parcours doit envoyer par WhatsApp : sinon
     * l'e-mail et l'appel API placés avant partiraient, l'envoi buterait, et au « Relier » le parcours
     * repartirait de zéro, e-mail compris. L'exception remonte telle quelle (campagne et automation la
     * traitent).
     *
     * Restent possibles avant ce point : un bloc RCS envoyé par `walkResolved` (aucun envoi WhatsApp ne le suit
     * dans cette liste) et la reprise du fil par `reclaimControl` (rien d'écrit au contact). Et la garde est en
     * cache 5 s par process : un « Délier » entre cette vérification et un envoi plus loin laisse partir les
     * envois d'avant.
     */
    if (envoieParWhatsApp(actions, apresWalk)) {
      await this.deps.verifierNumeroWhatsApp(tenantId);
    }
    const { refus, partis, canal } = await this.apply(tenantId, contact.waId, actions, opts.firstTemplateParams, opts.emitEvents === true, workflowId, apresWalk);
    // Refus alors que rien n'est parti : on ne persiste pas de run en attente (il attendrait une réponse à un
    // message jamais reçu, et le message suivant du contact le ferait avancer au bloc suivant). La raison
    // remonte telle quelle vers la campagne. Si un message est parti, le parcours vit et le refus reste au log.
    if (refus !== null) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${workflowId}: envoi refusé pour ${contact.waId} : ${refus}`);
      if (partis === 0) return refus;
    }
    /**
     * Le parcours précédent est clos ici, et nulle part ailleurs : tout démarrage remplace le parcours en cours
     * (on ne bloque personne sur un scénario), sur le passage commun à tous les chemins de démarrage.
     *
     * Après `apply`, pas au début : les gardes plus haut peuvent refuser le démarrage, et fermer à l'entrée
     * tuerait le parcours d'un contact pour un démarrage qui n'a pas eu lieu. Et seulement si quelque chose
     * remplace vraiment : un scénario fait de seules actions (rien d'envoyé, repos `done`) ne coupe pas une
     * conversation vivante. Un parcours synchrone qui a envoyé (`partis > 0`) ferme l'ancien, sinon celui-ci
     * avancerait à la prochaine réponse.
     */
    // Le canal est persisté dès la naissance : un scénario qui ouvre par un bloc RCS naît sur RCS, et son
    // message rapide suivant part en RCS.
    const state = { ...restToState(rest, this.now()), channel: canal };
    if (partis > 0 || state.status !== 'done') {
      const closPrecedent = await this.deps.runs.closeActiveByWaId(tenantId, contact.waId);
      // La session d'agent suit son parcours : sinon elle reste `en_cours` avec un tour jamais commencé,
      // invisible de la reprise des tours bloqués.
      for (const runId of closPrecedent) await this.cloreSessionDuRun(tenantId, runId, 'erreur');
      if (closPrecedent.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`workflow ${workflowId}: ${closPrecedent.length} parcours en cours clos, remplacé pour ${contact.waId}`);
      }
    }
    // L'id rendu par `runs.start` est capturé : `agent_sessions.run_id` est une FK NOT NULL vers
    // `workflow_runs`, donc la session ne peut pas naître avant le run. Ordre obligatoire : apply, start, la
    // session, puis l'enfilage.
    //
    // Le figeage se demande, il n'est jamais implicite : seuls les démarrages de test le posent (figer le
    // graphe de chaque destinataire d'une campagne le recopierait des milliers de fois).
    const cree = state.status !== 'done'
      ? await this.deps.runs.start(tenantId, workflowId, contact.waId, contact.contactId, state, opts.figerLeGraphe === true ? graph : null)
      : null;
    // Bloc `inbox` atteint -> la conversation passe explicitement à un humain. L'escalade (collante : le
    // balayage ne rend plus le fil à l'agent de Meta tant que personne n'a répondu) exige `partis > 0` : sur une
    // campagne, un scénario qui ouvre sur « passer à un humain » ferait sinon un fil collant par destinataire
    // qui n'a rien reçu, donc n'attend rien. La conversation passe quand même à `app_human`.
    if (rest.status === 'inbox') {
      await this.deps.escalateToHuman(tenantId, contact.waId, rest.assigneA ?? null, partis > 0, workflowId);
    }
    if (rest.status === 'done') await this.rendreLaMainAMba(tenantId, contact.waId);
    // Bloc agent en ouverture : la session naît maintenant, le run existe enfin.
    if (rest.status === 'agent_turn' && cree) {
      await this.demarrerTourAgent(tenantId, contact.waId, { id: cree.id, workflowId }, graph, rest.nodeId);
    }
    return true;
  }

  /**
   * Démarre un run depuis l'entrée. `firstTemplateParams` (campagne workflow) = variables du 1er template
   * déjà résolues par contact, passées sans re-résolution via les hints. Garde fenêtre 24 h appliquée. Rend
   * la raison du refus si le run n'a pas démarré (cf. `runFrom`), y compris sur un graphe vide.
   */
  async start(
    tenantId: string, workflowId: string, graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null },
    firstTemplateParams?: string[],
    opts: { emitEvents?: boolean; ignoreHumanControl?: boolean; saufOperateur?: boolean } = {},
  ): Promise<StartOutcome> {
    const entry = entryNode(graph);
    if (!entry) return 'le scénario est vide';
    return this.runFrom(tenantId, workflowId, graph, contact, entry, { ...(firstTemplateParams ? { firstTemplateParams } : {}), ...opts });
  }

  /**
   * Démarre un run depuis l'entrée, pour un contact dont la fenêtre de service est garantie ouverte parce
   * qu'il vient d'écrire : le scénario peut alors ouvrir par un message rapide ou un formulaire. À n'appeler
   * que sur un chemin où un entrant récent prouve la fenêtre ; sinon `start()`.
   *
   * `ignoreHumanControl` sert au lancement depuis l'Inbox : l'opérateur y détient presque toujours le fil, et
   * c'est lui qui demande le scénario. « Avoir la main » empêche le scénario d'avancer seul et MBA de
   * répondre, jamais un opérateur d'envoyer.
   */
  async startInWindow(
    tenantId: string, workflowId: string, graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null },
    opts: { emitEvents?: boolean; ignoreHumanControl?: boolean; saufOperateur?: boolean; figerLeGraphe?: boolean } = {},
  ): Promise<StartOutcome> {
    const entry = entryNode(graph);
    if (!entry) return 'le scénario est vide';
    return this.runFrom(tenantId, workflowId, graph, contact, entry, { allowSessionOpen: true, ...opts });
  }

  /**
   * Démarre un run à un bloc arbitraire du graphe (cible `node` de /v1/sends). Sans garde fenêtre 24 h : quand
   * ce qui part en premier est un message de session (`ouvertureApi`), l'appelant a déjà écarté les contacts
   * hors fenêtre (`window_closed`). `figerLeGraphe` est réservé aux démarrages de test, qui jouent le
   * brouillon : sans lui, le parcours reprendrait sur le publié à la première réponse.
   */
  async startFromNode(
    tenantId: string, workflowId: string, graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null }, startNodeId: string,
    opts: { emitEvents?: boolean; ignoreHumanControl?: boolean; saufOperateur?: boolean; figerLeGraphe?: boolean } = {},
  ): Promise<StartOutcome> {
    return this.runFrom(tenantId, workflowId, graph, contact, startNodeId, { allowSessionOpen: true, ...opts });
  }

  /**
   * Le message RCS n'a pas pu être remis (UNDELIVERABLE / UNDELIVERED) : le parcours repart par la sortie
   * « non joignable » du bloc (cascade RCS -> WhatsApp).
   *
   * Méthode à part plutôt qu'un `advance(..., 'unreachable')` : `advance` retombe sur la première arête
   * libre, et ferait avancer d'un cran un run qui attend autre chose qu'un bloc RCS. On ne bascule en repli
   * que si le run attend sur un bloc RCS. Rejeu sans effet (dédup `lastMessageId`) : smsmode rejoue jusqu'à
   * six fois.
   */
  async rcsUndeliverable(tenantId: string, waId: string, messageId: string): Promise<boolean> {
    if (!(await this.runEnAttenteSur(tenantId, waId, 'rcs_message'))) return false;
    await this.advance(tenantId, waId, messageId, 'unreachable', 'rcs');
    return true;
  }

  /**
   * Le message RCS a été remis : le parcours repart par la sortie « envoyé », seulement si le bloc n'offre
   * aucun bouton réponse. Avec un bouton, avancer sur l'accusé (quelques secondes) ferait que le clic du
   * contact, bien plus tard, ne trouverait plus de parcours en attente. Sans bouton, sans cette reprise, un
   * bloc RCS suivi d'une relance ne repartirait jamais pour un contact qui ne répond pas.
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
   * Le tour d'agent a décidé de sortir : le parcours reprend par la branche `sortie:<code>` du bloc, via
   * `advance` avec un handle synthétique (comme `rcsDelivered`), pour ne pas dupliquer le chemin de reprise.
   * L'identifiant de message synthétique porte la session : rejouée, la sortie est écartée par la
   * déduplication `lastMessageId`. `false` si le contact n'attend pas sur un bloc agent.
   */
  async sortirDuBlocAgent(tenantId: string, waId: string, sessionId: string, sortie: string): Promise<boolean> {
    const attente = await this.runEnAttenteSur(tenantId, waId, 'agent');
    if (!attente) return false;
    // Le canal du parcours est repassé tel quel : un bloc agent peut suivre un bloc RCS, et la garde
    // d'étanchéité d'`advance` écarterait un retour annoncé sur le mauvais tuyau.
    await this.advance(tenantId, waId, `agent:${sessionId}:${sortie}`, `sortie:${sortie}`, attente.run.channel ?? 'whatsapp');
    return true;
  }

  /**
   * Déclenche un bloc du scénario courant depuis un outil d'agent (`mba_envoyer_bloc`) : `walk` + `apply`
   * bornés, sans persister de run. Pas `startFromNode` : `runFrom` clorait le run de l'agent qui l'appelle,
   * et la session d'où part cet outil.
   *
   * Un sous-parcours qui rend la main est refusé avant tout envoi, aucun run ne pouvant le porter :
   * `agent_turn` (une seconde session lèverait 23505 sur l'index « une seule session vivante par
   * parcours »), `inbox` (notre run resterait planté sur le bloc agent), `sleeping` (l'échéance n'est écrite
   * nulle part, la suite ne partirait jamais) et `rcs_send` (son IO partirait avant qu'on puisse refuser). Le
   * modèle reçoit la raison.
   *
   * Le repos `waiting` est normal et non persisté : l'agent garde la conversation, la réponse du contact lui
   * revient par `advance`. `emitEvents` faux : un tag posé ici ne démarre pas d'automation pendant que
   * l'agent tient le fil.
   */
  async envoyerBlocDepuisAgent(
    tenantId: string,
    waId: string,
    input: { runId: string; workflowId: string; code: string },
  ): Promise<{ ok: boolean; raison?: string }> {
    const attente = await this.runEnAttenteSur(tenantId, waId, 'agent');
    // Le run doit être celui de l'agent qui appelle, scénario compris : un outil ne pousse pas un bloc dans
    // un parcours qui attend autre chose.
    if (!attente || attente.run.id !== input.runId || attente.run.workflowId !== input.workflowId) {
      return { ok: false, raison: 'aucun parcours d agent en cours pour ce contact' };
    }
    const { run, graph } = attente;
    // Préfixe exigé comme dans `src/ids/resolve.ts` : sans lui, un code vide correspondrait au premier bloc
    // dépourvu de code, et l'outil enverrait un bloc pris au hasard.
    if (!input.code.startsWith('nod_')) return { ok: false, raison: `code de bloc inconnu : ${input.code}` };
    const cible = graph.nodes.find((n) => String(n.data.code ?? '') === input.code);
    if (!cible) return { ok: false, raison: `code de bloc inconnu : ${input.code}` };
    if (!(await this.deps.mayAct(tenantId, waId))) {
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
    // Même raison que `sleeping` : la branche « pas de réponse » d'une question à échéance ne se déclencherait
    // jamais, l'échéance n'étant portée par aucun run.
    if (rest.status === 'waiting' && rest.timeoutInMs) {
      return { ok: false, raison: 'ce bloc attend une reponse avec un delai, non disponible depuis un outil' };
    }
    const { refus, partis } = await this.apply(tenantId, waId, actions, undefined, false, run.workflowId, canal);
    if (partis === 0 && refus !== null) return { ok: false, raison: refus };
    return { ok: true };
  }

  /**
   * Le parcours en attente d'un contact et le bloc sur lequel il attend, si ce bloc est du type demandé.
   * Garde commune aux reprises qui ne viennent pas du contact (accusé RCS, sortie de tour d'agent, outil
   * d'agent) : un signal ne fait pas avancer un parcours qui attend autre chose.
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
   * Avance le run en attente d'un contact quand il répond. No-op si aucun run ou message déjà traité.
   * `buttonPayload` = bouton quick-reply tapé (`btn:<index>`). Routage, dans cet ordre :
   *   1. une arête part de ce handle -> sa branche ;
   *   2. sinon une arête libre existe (chaîne linéaire, ou sortie « toute autre réponse ») -> on la suit ;
   *   3. sinon le scénario n'a rien prévu pour cette réponse : on clôt le run et l'agent reprend la parole
   *      (la 1re arête enverrait « non merci » dans la branche du bouton « Oui »).
   *
   * `canalRetour` = le tuyau d'où vient le retour. Défaut `whatsapp` : la porte Meta
   * (webhooks/workflow-advance.ts) ne reçoit que du WhatsApp ; les portes RCS le passent explicitement.
   */
  async advance(tenantId: string, waId: string, messageId: string, buttonPayload: string | null = null, canalRetour: RunChannel = 'whatsapp'): Promise<void> {
    const run = await this.deps.runs.findWaitingByWaId(tenantId, waId);
    if (!run || run.lastMessageId === messageId) return; // dédup at-least-once

    /**
     * Le tour est réservé avant tout envoi : l'écriture conditionnelle plus bas protège l'état mais arrive
     * après les envois, et deux avances concurrentes enverraient toutes les deux. Perdre la réservation est le
     * cas normal quand deux messages du même contact arrivent ensemble (le gagnant traite la suite) : on sort,
     * en le journalisant.
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
     * Le bail est renouvelé tant qu'on travaille : un seul envoi Meta peut durer ~154 s, et sans battement un
     * autre traitement reprendrait le tour pendant qu'on envoie encore (cf. `bail-avance.ts`).
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
     * Écriture de l'état, conditionnée au fait que le run n'a pas bougé pendant qu'on travaillait (et au jeton
     * du tour). Deux avances peuvent se chevaucher même avec un seul worker (l'API traite certains retours RCS
     * pendant que le worker traite un webhook du même contact) : sans cette garde, la dernière écriture
     * gagnerait et un parcours pourrait revenir sur un bloc déjà franchi. Ceinture de la réservation : sur un
     * chemin qui envoie des messages facturés, deux gardes valent mieux qu'une.
     */
    const ecrire = async (state: RunState): Promise<boolean> => {
      const ecrit = await this.deps.runs.setStateSiEncoreSur(tenantId, run.id, run.currentNode, state, jeton);
      if (!ecrit) {
        // eslint-disable-next-line no-console
        console.warn(`workflow ${run.workflowId}: avance PERDUE pour ${waId} (run ${run.id}), le parcours a bougé depuis le bloc ${run.currentNode ?? 'null'} pendant le traitement du message ${messageId}`);
      }
      return ecrit;
    };
    // Le fil est-il encore à nous ? Placé après la recherche du run pour ne pas payer une requête sur les
    // messages qui n'attendent aucun parcours. On ne clôt pas le run (un aller-retour avec un opérateur ne doit
    // pas tuer le parcours), mais on journalise : rien ne relance ce parcours au retour du contrôle
    // (`handover.ts` ne le fait pas), il ne repart qu'au prochain message du contact, donc il est en pratique
    // mort, et sans trace personne ne comprendrait pourquoi.
    if (!(await this.deps.mayAct(tenantId, waId))) {
      // eslint-disable-next-line no-console
      console.warn(`workflow ${run.workflowId}: avance GELEE pour ${waId} (run ${run.id}), le fil ne nous appartient pas (opérateur ou Meta Business Agent) sur le bloc ${run.currentNode ?? 'null'} (message ${messageId}) ; le run reste waiting et ne repartira qu'au prochain message du contact`);
      return;
    }
    const graph = run.currentNode ? await grapheDuRun(run, () => this.deps.getGraph(run.workflowId, tenantId)) : null;
    // Bloc RCS en attente : la réponse du contact reprend par la sortie « envoyé », pas par un payload de
    // bouton. Le repli suit la règle du bloc Condition : tant qu'une sortie typée existe, jamais la 1re arête
    // venue (« non joignable » volerait la suite d'un envoi réussi).
    const courant = graph && run.currentNode ? graph.nodes.find((n) => n.id === run.currentNode) : undefined;

    // Étanchéité des canaux : le retour doit venir du tuyau sur lequel le parcours attend. Les deux canaux
    // partagent le même espace de handles `btn:<i>` (rcs/schema.ts et meta/client.ts), donc sans cette garde un
    // tap RCS choisirait une branche d'une question WhatsApp, et inversement.
    //
    // Canal attendu : un bloc RCS attend une réponse RCS ; pour tout autre bloc, c'est le canal du parcours qui
    // fait foi (pas « bloc non-RCS = whatsapp » : un message rapide derrière un bloc RCS part en RCS et attend
    // une réponse RCS).
    //
    // Discordance -> on ne fait rien : le run reste `waiting` (un retour sur le mauvais canal ne tue pas le
    // parcours), pas de mesure, pas de `lastMessageId` (le message n'appartient pas à ce parcours). Il reste non
    // lu dans l'inbox, ce qui le porte à l'attention d'un opérateur.
    //
    // `sortie:` marque une reprise après un bloc agent, déclenchée par `sortirDuBlocAgent` seul (Meta n'envoie
    // que `btn:`, `row:` et `card:`) : elle éteint la mesure et l'interception par la branche agent (sans quoi la
    // sortie réenfilerait un tour au lieu de faire avancer le parcours).
    const sortieAgent = typeof buttonPayload === 'string' && buttonPayload.startsWith('sortie:');
    const canalAttendu: RunChannel = courant?.type === 'rcs_message' ? 'rcs' : (run.channel ?? 'whatsapp');
    if (canalRetour !== canalAttendu) {
      // eslint-disable-next-line no-console
      console.warn(`workflow ${run.workflowId}: retour ${canalRetour} ignoré pour ${waId}, le parcours attend du ${canalAttendu}`);
      return;
    }

    // Mesure de la réponse, rattachée au bloc qui l'attendait, avant toute décision de routage : ce qui compte
    // est ce que le contact a fait (un bouton non câblé reste un clic). `handle` distingue le choix (`btn:<i>`, ou
    // le handle carte/bouton d'un carousel) ; pas de payload = le contact a écrit. Les blocs RCS sont exclus :
    // leur reprise est l'issue d'un envoi, pas une réponse.
    if (run.currentNode && courant?.type !== 'rcs_message' && !sortieAgent) {
      const aClique = typeof buttonPayload === 'string' && buttonPayload !== '';
      await this.mesurer(
        tenantId, run.workflowId, run.currentNode, waId,
        aClique ? 'reply_button' : 'reply_text',
        aClique ? buttonPayload : undefined,
      );
    }
    // Bloc agent : le contact répond pendant une conversation que l'agent tient, on n'entre pas dans le
    // routage. Sinon une arête libre ferait sauter l'agent dès le premier message, ou le run serait clos et le fil
    // rendu à l'agent de Meta, avec une session orpheline dans les deux cas. Placé après la mesure, qui a déjà
    // enregistré la réponse.
    if (courant?.type === 'agent' && !sortieAgent) {
      const session = await this.deps.agentSessions?.byRun(tenantId, run.id);
      if (!session || session.status !== 'en_cours') {
        // Run sur un bloc agent sans session vivante : état incohérent. On ne route pas au hasard, on remonte la
        // conversation à un humain et on laisse une trace.
        // eslint-disable-next-line no-console
        console.error(`workflow ${run.workflowId}: run ${run.id} sur un bloc agent sans session vivante, remonté en inbox`);
        await ecrire({ currentNode: null, status: 'inbox', lastMessageId: messageId });
        // Aucun bloc n'a demandé cette remontée : pas d'affectataire. L'escalade se lit sur la session close : seule
        // une fin délibérée (`status === 'sortie'`, écrit par `src/agent/escalade.ts` avant de basculer le fil) porte
        // une promesse faite au contact. Une panne (`erreur`, `plafond`, `inactivite`) ne doit pas rendre le fil
        // collant : le contact vient d'écrire, « À traiter » le porte déjà. Le cas nominal pose déjà le drapeau
        // (`src/worker.ts`) ; ceci rattrape un processus mort entre les deux gestes.
        const finDeliberee = session?.status === 'sortie';
        await this.deps.escalateToHuman(tenantId, waId, null, finDeliberee, run.workflowId);
        return;
      }
      // On enfile avant de marquer le message consommé (l'effet réel d'abord, `lastMessageId` ensuite) : si
      // l'enfilage lève, une redélivrance n'est pas dédupliquée et le tour finit par partir. Dans l'autre sens
      // (enfilage réussi, `setState` en échec), un rejeu réémet un job au même `tours`, que le verrou optimiste de
      // `prendreLeTour` absorbe.
      //
      // 🔴 Même garde que devant un envoi : enfiler un tour commande un appel modèle facturé, et le nouveau
      // porteur du tour a commandé le sien. `return` sec, sans écrire `lastMessageId`.
      const perduAvantTour = battement?.perduPourquoi() ?? null;
      if (perduAvantTour !== null) {
        // eslint-disable-next-line no-console
        console.warn(`workflow ${run.workflowId}: tour d'agent NON enfilé pour ${waId} (run ${run.id}) : ${perduAvantTour}`);
        return;
      }
      await this.deps.enqueueAgentTurn({
        tenantId,
        runId: run.id,
        sessionId: session.id,
        workflowId: run.workflowId,
        nodeId: courant.id,
        waId,
        raison: 'message',
        tours: session.tours,
      });
      // `currentNode` est repassé explicitement : `setState` écrit `current_node` sans coalesce, et null perdrait
      // le bloc agent. Le run reste `waiting` sur le bloc (retrouvé au message suivant), et `lastMessageId` est
      // persisté ici : sans lui, un rejeu enfilerait un second tour facturé.
      await ecrire({
        currentNode: run.currentNode,
        status: 'waiting',
        lastMessageId: messageId,
      });
      return;
    }
    // Bloc RCS : `sent` et `unreachable` qualifient la livraison, les boutons la réponse. Un clic prime donc
    // sur `sent` ; sans clic, on reprend par `sent`.
    const handle = courant?.type === 'rcs_message' ? (buttonPayload ?? 'sent') : buttonPayload;
    const sortieTypee = graph && run.currentNode
      ? graph.edges.some((e) => e.source === run.currentNode && (e.sourceHandle === 'sent' || e.sourceHandle === 'unreachable'))
      : false;
    const next = graph && run.currentNode
      ? ((handle ? nextNodeByHandle(graph, run.currentNode, handle) : null)
        ?? (sortieTypee ? null : nextNodeSansHandle(graph, run.currentNode)))
      : null;
    if (!graph || !next) {
      // Deux situations distinctes :
      // (a) le contact a écrit au lieu de choisir : le scénario n'a rien prévu, l'agent de Meta reprend la parole ;
      // (b) le contact a fait un choix proposé qui ne mène nulle part : c'est un trou de montage, on remonte la
      //     conversation à un humain (« À traiter ») au lieu de la rendre à l'agent, même si MBA est allumé.
      // Un choix proposé = un handle que l'éditeur sait relier : `btn:<i>`, `card:<i>:btn:<j>` (carousel),
      // `row:<i>` (menu d'une question), `sortie:` (sortie d'agent non câblée, qui ne doit pas envoyer le contact
      // au bot générique au lieu d'alerter un opérateur). Tout le reste (texte libre, payload d'un vieux template,
      // accusé RCS dont la sortie n'est pas branchée) suit le chemin (a).
      const boutonSansSuite = typeof buttonPayload === 'string' && /^(btn:|card:|row:|sortie:)/.test(buttonPayload);
      await ecrire({ currentNode: null, status: 'done', lastMessageId: messageId });
      if (boutonSansSuite) {
        // eslint-disable-next-line no-console
        console.error(`workflow ${run.workflowId}: le bouton « ${buttonPayload} » du bloc ${run.currentNode} ne mène nulle part, ${waId} a cliqué et n'a rien reçu`);
        // Pas d'escalade : le contact vient de cliquer, `last_direction` est entrant et « À traiter » porte déjà
        // la conversation. Le drapeau n'ajouterait que la collance.
        await this.deps.escalateToHuman(tenantId, waId, null, false, run.workflowId);
      } else {
        // (a) : son message part aussi chez l'agent de Meta, qui y répond. Seulement un vrai message WhatsApp :
        // cette branche reçoit aussi des réactions et des rapports RCS, qui ne sont pas des messages du client.
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
        // Aucun bloc n'a demandé la remontée : pas d'affectataire. Pas d'escalade : le contact vient d'écrire,
        // « À traiter » le porte déjà (même raison qu'au bouton sans suite).
        await this.deps.escalateToHuman(tenantId, waId, null, false, run.workflowId);
        return;
      }
    }
    await ecrire({ ...restToState(rest, this.now()), lastMessageId: messageId, channel: canal });
    if (rest.status === 'inbox') {
      await this.deps.escalateToHuman(tenantId, waId, rest.assigneA ?? null, true, run.workflowId);
    }
    // Chaîne terminée sans attendre de choix : l'agent reprend (`waiting` garde la main, `inbox` la donne à un
    // humain). Si le client a écrit et que la chaîne n'a rien envoyé en retour, son message part chez l'agent,
    // sinon celui-ci reprendrait sans savoir que le client vient d'écrire. Si la chaîne a répondu, l'agent
    // répondrait par-dessus : on ne transmet pas.
    if (rest.status === 'done') {
      /**
       * Sauf si la chaîne a déjà recueilli ce message (« Votre e-mail ? », puis « écrire le champ = dernière
       * saisie ») : le transmettre ferait commenter la saisie hors contexte par l'agent. On regarde les blocs
       * réellement traversés, pas le graphe entier. Limite connue : une variable de connecteur
       * `systeme/derniere_saisie` (portée par la requête d'un bloc « Appel HTTP ») n'est pas vue, et le message
       * part quand même. Une détection incomplète laisse l'agent parler, jamais l'inverse.
       */
      const aLuLaSaisie = actions.some((a) => graph.nodes.find((n) => n.id === a.nodeId)?.data.valueKind === 'derniere_saisie');
      const sansReponse = buttonPayload === null && canalRetour === 'whatsapp' && partis === 0 && !aLuLaSaisie;
      await this.rendreLaMainAMba(tenantId, waId, sansReponse ? { transmettre: messageId } : {});
    }
    // Transition fraîche vers un bloc agent (distincte de la branche du haut, où le run y était déjà) : la
    // réponse fait avancer le parcours jusqu'au bloc agent pour la première fois, typiquement après un template
    // de campagne. On ouvre la session et on enfile le premier tour, sinon l'agent resterait muet. Pas de garde
    // de fenêtre : `advance` n'est déclenché que par un message entrant.
    if (rest.status === 'agent_turn') {
      await this.demarrerTourAgent(tenantId, waId, { id: run.id, workflowId: run.workflowId }, graph, rest.nodeId);
    }
    } catch (err) {
      /**
       * L'erreur emporte son contexte : le journal des échecs d'avance a des colonnes `workflow_id`, `run_id` et
       * `canal` que seul ce point connaît (le handler de webhook ne connaît que le contact et le message). On
       * ré-émet la même erreur, avec sa pile, sans changer le flux.
       */
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        contexteAvance: { workflowId: run.workflowId, runId: run.id, canal: canalRetour },
      });
    } finally {
      // Le battement s'arrête avant la libération, dans tous les cas : un renouvellement qui survit à son avance
      // tiendrait un tour que plus personne ne travaille.
      battement?.arreter();
      // Libération best-effort (au pire l'attente du bail), dans le `finally` pour que le tour soit rendu même si
      // un envoi jette, sans faire attendre le message suivant du contact.
      if (jeton !== null && this.deps.runs.libererAvance) {
        await this.deps.runs.libererAvance(run.id, jeton).catch(() => {});
      }
    }
  }
}
