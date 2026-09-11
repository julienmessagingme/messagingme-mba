import type { WorkflowGraph, WorkflowNode } from './graph';
import { evaluateConditionGroup, coerceConditionGroup, parseInstant } from './conditions';
import type { EvalContext } from './conditions';
// « Quand est le prochain créneau ouvert ? » vit dans UN seul endroit : le bloc Attente, l'envoi de campagne
// et la reprise d'une campagne coupée par la fermeture posent la même question et doivent avoir la même réponse.
import { prochaineOuverture } from '../lib/heures-ouvrees';
// Le format de « maintenant » vit dans `src/agent/variables.ts` : un connecteur et un bloc de scenario
// doivent poser la MEME valeur, sinon la meme date lue a deux endroits ne serait pas la meme.
import { formatMaintenant } from '../agent/variables';

/**
 * Moteur d'exécution d'un workflow, PUR (aucune IO). Un run avance en LIGNE DROITE : on suit la 1re arête
 * sortante de chaque bloc. Les blocs SYNCHRONES (tag/field) produisent une action et on continue ; un bloc
 * `template`/`flow` produit son action puis ATTEND une réponse du contact ; `inbox` est terminal (remontée
 * humaine). V1 volontairement simple : pas de branche par bouton (réservé plus tard via sourceHandle).
 */

/** Bouton d'un template (dénormalisé sur le node à la sélection) : sert à envoyer un payload contrôlé par
 *  bouton quick-reply (branche déterministe) et à afficher les sorties dans l'éditeur. */
export interface WorkflowButton { type: string; text: string }

/** Destinataire du node « Envoi de mail » : adresse en dur, ou variable résolue depuis un champ du contact
 *  (même identité déjà résolue pour l'envoi de template : téléphone ou BSUID, pas un nouveau chemin). */
export type EmailRecipient =
  | { kind: 'literal'; value: string }
  | { kind: 'field'; field: string };

/** Nombre maximal de destinataires d'un bloc « Envoi de mail ». Borné ICI, côté moteur, et pas seulement par
 *  le bouton « + » du builder : `parseGraph` ne regarde pas `data`, donc un graphe fabriqué à la main passerait
 *  autant d'adresses qu'il veut. Le surplus est TRONQUÉ (pas de refus : un bloc refusé devient un no-op muet). */
export const MAX_DESTINATAIRES_EMAIL = 3;

/** Action « Envoi de mail » : boîte SMTP + modèle + destinataires, portés par leur id/valeur opaques. Exportée :
 *  consommée par l'executor (câblage de l'envoi réel, IO).
 *
 *  `to` est une LISTE (1 à 3). Le premier part en « À », les suivants en COPIE CACHÉE : les destinataires
 *  peuvent être des clients, et ils ne doivent pas voir les adresses les uns des autres (décision produit du
 *  2026-08-25). La liste ne peut pas être vide : `actionOf` rend `null` avant d'en fabriquer une. */
export interface SendEmailAction {
  kind: 'sendEmail';
  emailAccountId: string;
  templateId: string;
  to: EmailRecipient[];
}

export type WorkflowAction =
  | { kind: 'tag'; tag: string }
  | { kind: 'removeTag'; tag: string }
  | { kind: 'field'; key: string; value: string }
  | { kind: 'clearField'; key: string }
  /** Consentement marketing posé par un scénario. Les deux sens, comme depuis la fiche et l'action en masse. */
  | { kind: 'optIn'; value: 'opted_in' | 'opted_out' }
  | { kind: 'sendTemplate'; templateName: string; language: string; buttons: WorkflowButton[] }
  /** `mediaUrl` = visuel du bloc, hébergé chez nous (`/m/<code>.<ext>`), le MÊME champ que le bloc RCS.
   *  Absent = message texte, comportement historique. */
  | { kind: 'sendQuickMessage'; body: string; buttons: WorkflowButton[]; mediaUrl?: string }
  | { kind: 'sendFlow'; flowId: string; flowName: string; body: string; cta: string }
  /**
   * Bloc QUESTION : une question posée au contact, avec un MENU de réponses (liste interactive WhatsApp) ou
   * sans menu du tout. Il attend TOUJOURS une réponse, et il peut porter une échéance « pas de réponse ».
   *
   * ⚠️ `rows` est transmis ENTIER, lignes au libellé vide comprises. C'est la même règle que les boutons de
   * `sendQuickMessage` : l'index d'une ligne EST sa sortie (`row:<i>`), donc filtrer en amont renumérote les
   * lignes et envoie le contact sur la mauvaise branche. Le filtrage se fait à l'ENVOI, en préservant l'index.
   */
  | { kind: 'sendQuestion'; body: string; buttonLabel: string; rows: QuestionRow[] }
  | SendEmailAction;

/** Une ligne du menu d'un bloc Question. `title` est ce que le contact lit, `description` est facultative. */
export interface QuestionRow {
  title: string;
  description?: string;
}

/** Ce que l'OUVERTURE d'un scénario contient, en un seul parcours (les deux questions posées sur l'ouverture
 *  ont la même exploration : les séparer en deux fonctions dupliquerait la traversée ET ses règles). */
export interface OpeningScan {
  /** Un message de SESSION (message rapide / formulaire) part-il avant tout template ? */
  sessionOpen: boolean;
  /**
   * Un bloc RCS CONFIGURÉ ouvre-t-il le scénario ? C'est une ouverture LÉGALE À FROID, au même titre qu'un
   * template et à la différence d'un message de session : la fenêtre de 24 h est une contrainte de WhatsApp,
   * et le RCS ne passe pas par WhatsApp.
   *
   * 🔴 Vécu le 2026-08-24 : un scénario commençant par un bloc RCS n'apparaissait PAS dans le sélecteur de
   * l'Inbox quand la fenêtre était fermée, c'est-à-dire précisément là où il était le plus utile. La règle
   * « seul un template peut ouvrir à froid » avait été écrite quand WhatsApp était le seul canal.
   */
  rcsOpen: boolean;
  /** Le 1er template atteignable (parcours en LARGEUR : l'ordre reflète la proximité de l'entrée). */
  firstTemplate: WorkflowNode | null;
  /** Plusieurs templates DIFFÉRENTS peuvent ouvrir (branches d'une condition) -> aucune ouverture unique. */
  ambiguousTemplate: boolean;
  /** Une ATTENTE est traversée avant le 1er template : rien ne part au lancement. */
  waitBeforeTemplate: boolean;
  /** Un template d'ouverture atteint n'a PAS de nom : sur cette branche, rien ne partirait, et le destinataire
   *  serait pourtant compté « envoyé ». Distinct de `firstTemplate === null` (aucun template du tout). */
  unnamedOpeningTemplate: boolean;
}

/**
 * Explore, depuis l'entrée, tout ce qui est atteignable AVANT le premier envoi. Les blocs synchrones
 * (tag / field / action) sont traversés, un bloc `condition` explore ses DEUX sorties, `template` et `inbox`
 * arrêtent l'exploration de leur branche.
 *
 * En LARGEUR (file, pas pile) : « le premier template » doit être le plus proche de l'entrée, sinon le mapping
 * de variables d'une campagne viserait un template arbitraire selon l'ordre d'insertion des blocs.
 */
export function scanOpening(graph: WorkflowGraph): OpeningScan {
  const out: OpeningScan = { sessionOpen: false, rcsOpen: false, firstTemplate: null, ambiguousTemplate: false, waitBeforeTemplate: false, unnamedOpeningTemplate: false };
  const entry = entryNode(graph);
  if (!entry) return out;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const queue: string[] = [entry];
  const noms = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === 'inbox') continue; // terminal
    if (node.type === 'template') {
      // Ouverture légale et bloquante : on ne va pas au-delà. Deux branches qui ouvrent sur des templates de
      // noms différents rendent l'ouverture ambiguë (quel template la campagne devrait-elle paramétrer ?).
      const nom = String(node.data.templateName ?? '').trim();
      if (nom !== '') noms.add(nom);
      else out.unnamedOpeningTemplate = true;
      if (!out.firstTemplate) out.firstTemplate = node;
      out.ambiguousTemplate = noms.size > 1;
      continue;
    }
    if (node.type === 'flow' || node.type === 'quick_message') {
      const a = actionOf(node);
      if (a && (a.kind === 'sendFlow' || a.kind === 'sendQuickMessage')) out.sessionOpen = true;
      continue; // bloc bloquant NON configuré (pas d'action) : pas une ouverture, et on ne va pas au-delà
    }
    if (node.type === 'question') {
      // Message de SESSION comme un message rapide : la liste interactive est un message libre, donc soumise
      // à la fenêtre de 24 h. Une question ne peut pas ouvrir une campagne.
      const a = actionOf(node);
      if (a) { out.sessionOpen = true; continue; }
      // Non configuré = passe-plat DANS `walk` : l'analyse doit voir la même chose, sinon l'éditeur jugerait
      // un scénario sur un parcours que le moteur ne suit pas.
      const suite = nextNode(graph, id);
      if (suite) queue.push(suite);
      continue;
    }
    if (node.type === 'agent') {
      // L'agent envoie du texte libre : c'est un message de SESSION (contrairement au RCS, qui ouvre
      // légalement à froid), et il BLOQUE l'exploration puisque `walk` s'y arrête. Sans ce cas, un scénario
      // « agent puis template » serait vu comme ouvrant sur le template : la campagne l'accepterait, ferait
      // paramétrer ce template, et au lancement rien ne partirait alors que les destinataires seraient
      // comptés touchés.
      if (String(node.data.agentId ?? '').trim() !== '') { out.sessionOpen = true; continue; }
      // Non configuré = passe-plat DANS `walk` : l'analyse doit voir la même chose, sinon l'éditeur jugerait
      // un scénario sur un parcours que le moteur ne suit pas.
      const suite = nextNode(graph, id);
      if (suite) queue.push(suite);
      continue;
    }
    if (node.type === 'rcs_message') {
      // Ouverture à froid LÉGALE. `waitBeforeTemplate` est consulté ici parce que le parcours est en LARGEUR :
      // une attente placée AVANT ce bloc a donc déjà été vue, et dans ce cas rien ne part au lancement.
      if (String(node.data.text ?? '').trim() !== '' && !out.waitBeforeTemplate) out.rcsOpen = true;
      // On explore AU-DELÀ : la sortie « non joignable » mène souvent au template de repli, et c'est CE
      // template que la campagne doit savoir paramétrer.
      for (const h of ['sent', 'unreachable']) {
        const c = nextNodeByHandle(graph, id, h);
        if (c) queue.push(c);
      }
      continue;
    }
    if (node.type === 'wait') out.waitBeforeTemplate = true; // traversé, mais rien ne partira au lancement
    if (node.type === 'condition') {
      const t = nextNodeByHandle(graph, id, 'true');
      const f = nextNodeByHandle(graph, id, 'false') ?? nextNode(graph, id);
      if (t) queue.push(t);
      if (f) queue.push(f);
      continue;
    }
    // tag / field / action / wait : bloc synchrone -> explorer la suite
    const nx = nextNode(graph, id);
    if (nx) queue.push(nx);
  }
  return out;
}

/**
 * Ce bloc « message rapide » laisse-t-il le parcours CONTINUER ? Oui quand il n'a aucune réponse rapide au
 * libellé non vide : c'est alors un simple texte, il ne pose pas de question, donc rien ne viendra en retour.
 * Bloquer là faisait qu'un tag placé juste après n'était jamais posé, en silence (prod, 2026-08-15).
 *
 * Source UNIQUE de la règle : `walk` (exécution) et `waitBeforeSessionMessage` (analyse du graphe) doivent
 * répondre pareil, sinon l'éditeur signalerait des montages que le moteur ne rencontre pas, ou l'inverse.
 */
function quickMessageNonBloquant(a: WorkflowAction | null): boolean {
  return a?.kind === 'sendQuickMessage' && !etapeOffreUnChoix(a);
}

/**
 * L'étape présente-t-elle un CHOIX au client, c'est-à-dire un bouton ou une réponse rapide réellement libellé ?
 *
 * C'est LE prédicat du contrôle du fil, et il pilote deux choses à la fois, ce qui est toute la raison de son
 * existence : « le scénario attend-il une réponse ? » et « gardons-nous la main face à l'agent de Meta ? » sont
 * la même question. Une étape qui offre un choix garde la main (la réponse du client doit nous revenir pour
 * être appariée au bouton). Une étape qui n'offre rien la relâche : l'agent de Meta reprend la parole, et les
 * actions du scénario continuent de leur côté.
 *
 * Un formulaire attend forcément une saisie : il offre donc un choix, sans bouton.
 */
export function etapeOffreUnChoix(a: WorkflowAction | null): boolean {
  if (a === null) return false;
  if (a.kind === 'sendFlow') return true;
  // Un bloc QUESTION attend toujours, MENU OU PAS. C'est sa définition même : sans menu, on attend la réponse
  // libre du contact, et c'est cette réponse qui doit nous revenir. Le faire dépendre de `rows` rendrait une
  // question sans menu non bloquante, donc suivie aussitôt par le bloc d'après, sans jamais lire la réponse.
  if (a.kind === 'sendQuestion') return true;
  if (a.kind === 'sendTemplate' || a.kind === 'sendQuickMessage') return a.buttons.some((b) => b.text.trim() !== '');
  return false;
}

/**
 * La fenêtre de service WhatsApp : 24 h depuis le dernier message DU CONTACT. Au-delà, Meta refuse tout ce
 * qui n'est pas un template (131047).
 *
 * Elle est au niveau du module parce que DEUX calculs la lisent : l'analyse de montage ci-dessous, et
 * `waitEstimationMs`, qui décide de la durée à prêter à une attente sans durée connue. Écrite deux fois,
 * elle aurait fini par ne plus valoir la même chose des deux côtés.
 */
export const FENETRE_SERVICE_MS = 24 * 3_600_000;

/** Un montage impossible : une attente qui ferme forcément la fenêtre, suivie d'un message de session. */
export interface WaitThenSession {
  /** Le dernier bloc Attente TRAVERSÉ sur ce chemin (celui qu'on montre à l'utilisateur). */
  waitNodeId: string;
  /** Le bloc message rapide / formulaire qui ne partira jamais. */
  messageNodeId: string;
}

/**
 * Cherche un chemin « attente cumulée >= 24 h, PUIS message rapide ou formulaire ».
 *
 * Ce montage ne peut jamais marcher : la fenêtre de service court depuis le dernier message DU CONTACT, donc
 * après 24 h d'attente elle est fermée à coup sûr, et Meta refuse tout message hors template (131047). Le
 * runtime le bloque (`executor.resume` teste la fenêtre RÉELLE au réveil, y compris pour un bloc agent, qui
 * ne produit pourtant aucune action) ; cette fonction sert à le DIRE dans le builder, au moment où on le
 * construit, plutôt que de laisser découvrir le silence en production.
 *
 * Sous 24 h on ne dit rien : la fenêtre PEUT être encore ouverte (le contact a pu écrire entre-temps), c'est
 * au runtime de trancher sur l'état réel, pas à une analyse de graphe de deviner.
 *
 * Termine sur les graphes CYCLIQUES : le cumul est PLAFONNÉ à 24 h (au-delà, la réponse ne change plus), et un
 * bloc n'est ré-exploré que si on l'atteint avec un cumul strictement plus grand. Sans ce plafond, un cycle
 * d'attentes ferait croître le cumul indéfiniment et la fonction ne rendrait jamais la main.
 */
export function waitBeforeSessionMessage(graph: WorkflowGraph): WaitThenSession | null {
  // Chaque attente compte pour au MOINS un pas de balayage (60 s), la granularité réelle d'un réveil. Sans ce
  // plancher, un délai fractionnaire enregistré par l'API (`{delay: 0.001}`, 60 ms) dans un cycle demanderait
  // ~1,4 million d'itérations par bloc et figerait l'onglet.
  const PAS_MIN_MS = 60_000;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const entry = entryNode(graph);
  if (!entry) return null;
  const meilleur = new Map<string, number>();
  // pile de { bloc, attente cumulée jusqu'ici, dernier bloc Attente franchi }
  const pile: Array<{ id: string; cumul: number; dernierWait: string | null }> = [{ id: entry, cumul: 0, dernierWait: null }];
  while (pile.length > 0) {
    const { id, cumul, dernierWait } = pile.pop()!;
    const vu = meilleur.get(id);
    if (vu !== undefined && vu >= cumul) continue;
    meilleur.set(id, cumul);
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === 'inbox') continue;
    if (node.type === 'question') {
      // Une question est un message de SESSION : après 24 h d'attente cumulée, elle ne partira jamais. Même
      // signalement que pour un message rapide ou un formulaire.
      const a = actionOf(node);
      if (a && cumul >= FENETRE_SERVICE_MS && dernierWait) return { waitNodeId: dernierWait, messageNodeId: id };
      // Configurée, elle BLOQUE (elle attend une réponse) : l'analyse s'arrête là, comme sur un message
      // rapide à boutons. Non configurée, elle est un passe-plat : on explore au-delà.
      if (a) continue;
      const apres = nextNode(graph, id);
      if (apres) pile.push({ id: apres, cumul, dernierWait });
      continue;
    }
    if (node.type === 'agent') {
      // Le premier message de l'agent est un message de SESSION : après 24 h d'attente cumulée, il ne partira
      // jamais. Même signalement que pour un message rapide ou un formulaire.
      const configure = String(node.data.agentId ?? '').trim() !== '';
      if (configure && cumul >= FENETRE_SERVICE_MS && dernierWait) return { waitNodeId: dernierWait, messageNodeId: id };
      // Configuré, il BLOQUE (il tient la conversation) : l'analyse s'arrête là. Non configuré, il est un
      // passe-plat, comme dans `walk` : on explore au-delà.
      if (configure) continue;
      const apres = nextNode(graph, id);
      if (apres) pile.push({ id: apres, cumul, dernierWait });
      continue;
    }
    if (node.type === 'flow' || node.type === 'quick_message') {
      const a = actionOf(node);
      if (a && (a.kind === 'sendFlow' || a.kind === 'sendQuickMessage') && cumul >= FENETRE_SERVICE_MS && dernierWait) {
        return { waitNodeId: dernierWait, messageNodeId: id };
      }
      // Un message rapide SANS bouton ne bloque pas le parcours (cf. `walk`) : on doit donc explorer AU-DELÀ,
      // sinon un montage « attente, message sans bouton, attente, message rapide » ne serait jamais signalé
      // alors que son dernier message ne partira jamais. Un bloc réellement bloquant, lui, arrête l'analyse.
      if (!quickMessageNonBloquant(a)) continue;
      const nx = nextNode(graph, id);
      if (nx) pile.push({ id: nx, cumul, dernierWait });
      continue;
    }
    // Un TEMPLATE remet le compteur à zéro. Attention à la raison : un template n'OUVRE PAS la fenêtre de
    // service (seul un message DU CONTACT l'ouvre). Le parcours s'ARRÊTE au template jusqu'à la réponse, et
    // c'est cette réponse qui rouvre la fenêtre : l'attente d'avant ne pèse donc plus sur la suite.
    const suivant = node.type === 'template'
      ? { cumul: 0, dernierWait: null }
      : node.type === 'wait'
        ? { cumul: Math.min(cumul + Math.max(PAS_MIN_MS, waitEstimationMs(node)), FENETRE_SERVICE_MS), dernierWait: waitEstimationMs(node) > 0 ? id : dernierWait }
        : { cumul, dernierWait };
    if (node.type === 'condition') {
      for (const h of ['true', 'false'] as const) {
        const cible = nextNodeByHandle(graph, id, h);
        if (cible) pile.push({ id: cible, ...suivant });
      }
      const repli = nextNode(graph, id);
      if (repli && !graph.edges.some((e) => e.source === id && (e.sourceHandle === 'true' || e.sourceHandle === 'false'))) {
        pile.push({ id: repli, ...suivant });
      }
      continue;
    }
    const nx = nextNode(graph, id);
    if (nx) pile.push({ id: nx, ...suivant });
  }
  return null;
}

export type WalkRest =
  /**
   * En attente d'une RÉPONSE du contact (après un template, un formulaire, une question).
   *
   * `timeoutInMs` est l'échéance « pas de réponse » d'un bloc Question : le parcours attend la réponse ET le
   * temps qui passe, ce qu'aucun autre bloc ne fait. Absent = attente sans limite, comportement historique.
   */
  | { status: 'waiting'; nodeId: string; timeoutInMs?: number }
  | { status: 'sleeping'; nodeId: string; resumeInMs: number } // en attente du TEMPS qui passe (bloc Attente)
  // Bloc RCS : ce n'est PAS un état de repos, c'est une MAIN RENDUE. Le walk est pur et ne peut pas savoir si
  // le numéro est joignable (appel réseau). L'executor fait l'IO puis reprend par 'sent' ou 'unreachable'.
  // Ce statut ne doit JAMAIS atteindre `restToState` : il n'y a pas d'état de run qui lui corresponde.
  | { status: 'rcs_send'; nodeId: string }
  // Bloc AGENT : ce n'est PAS un état de repos non plus, c'est une MAIN RENDUE, comme rcs_send. Le walk est pur
  // et ne peut pas savoir ce que le modèle va décider. L'executor persiste, ouvre la session et enfile un tour ;
  // le parcours reprendra plus tard par un handle de sortie.
  // ⚠️ Différence avec rcs_send, et elle décide du design : rcs_send est TOUJOURS résolu par `walkResolved` et
  // n'atteint donc jamais `restToState`. `agent_turn`, lui, l'atteint réellement, et le `return` final de
  // `restToState` aurait clos le parcours en `done` pile au moment où l'agent doit prendre la main. D'où un cas
  // EXPLICITE là-bas.
  | { status: 'agent_turn'; nodeId: string }
  /**
   * Conversation remontée à l'humain (terminal).
   *
   * ⚠️ `assigneA` VOYAGE AVEC LE STATUT, il n'est pas relu du graphe plus loin : l'exécuteur n'a pas le
   * nœud sous la main quand il escalade, et le lui faire rechercher par identifiant serait une seconde
   * lecture du graphe qui pourrait diverger de celle qui vient de décider.
   */
  | { status: 'inbox'; assigneA?: string | null }
  | { status: 'done' }; // fin de chaîne (plus d'arête sortante)

/** Unités proposées par le bloc Attente. */
export const WAIT_UNITS = ['minutes', 'hours', 'days'] as const;
export type WaitUnit = (typeof WAIT_UNITS)[number];
const UNIT_MS: Record<WaitUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
/** Plafond : 30 jours. Au-delà, un parcours dormant n'a plus de sens métier et la fenêtre est fermée depuis
 *  longtemps ; borner évite aussi une échéance absurde posée par une saisie erronée. */
export const WAIT_MAX_MS = 30 * 86_400_000;

/**
 * Les trois façons de dire QUAND un bloc Attente reprend.
 *
 * `delai` est le mode historique ET le défaut : un scénario enregistré avant le 2026-09-08 n'a pas ce champ
 * et doit se comporter exactement comme avant, au caractère près.
 */
export const WAIT_MODES = ['delai', 'date', 'heures_ouvrees'] as const;
export type WaitMode = (typeof WAIT_MODES)[number];

/** Le mode d'un bloc Attente, lu DÉFENSIVEMENT (`data` est du JSON libre venu du client). Inconnu -> `delai`,
 *  jamais une erreur : un scénario enregistré par une version ultérieure ne doit pas devenir illisible. */
export function waitMode(node: WorkflowNode): WaitMode {
  const brut = String(node.data.waitMode ?? 'delai');
  return (WAIT_MODES as readonly string[]).includes(brut) ? (brut as WaitMode) : 'delai';
}

/**
 * Durée d'un bloc Attente en mode DÉLAI, en millisecondes. 0 = bloc NON configuré (durée absente, nulle,
 * négative ou unité inconnue) : il se comporte alors en passe-plat, on ne bloque pas un parcours sur une
 * saisie oubliée.
 *
 * ⚠️ Rend 0 pour les deux modes DATÉS, et ce n'est pas un oubli : leur échéance ne se calcule qu'à
 * l'exécution. Le `delay` peut être resté dans `data` (le client a pu régler un délai avant de changer de
 * mode) ; le rendre ici annoncerait une durée que le bloc ne tiendra pas. Les deux questions que ce zéro
 * laisse ouvertes ont chacune leur fonction : `waitResumeInMs` pour l'exécution, `waitEstimationMs` pour
 * l'analyse de graphe.
 */
export function waitDurationMs(node: WorkflowNode): number {
  if (waitMode(node) !== 'delai') return 0;
  const brut = Number(node.data.delay ?? node.data.value ?? 0);
  if (!Number.isFinite(brut) || brut <= 0) return 0;
  const unit = String(node.data.unit ?? 'hours') as WaitUnit;
  const ms = UNIT_MS[unit];
  if (!ms) return 0;
  return Math.min(Math.round(brut * ms), WAIT_MAX_MS);
}

/**
 * La durée qu'une ANALYSE DE GRAPHE doit prêter à un bloc Attente, en millisecondes.
 *
 * 🔴 CE N'EST PAS `waitDurationMs`, ET LA DIFFÉRENCE DÉCIDE SI UN CLIENT REÇOIT UN MESSAGE OU RIEN.
 * `waitBeforeSessionMessage` tourne à la PUBLICATION : elle doit dire, sans connaître l'instant d'exécution,
 * si la fenêtre de 24 h sera fermée derrière l'attente. Une attente « jusqu'à une date » ou « jusqu'aux
 * prochaines heures ouvrées » n'a pas de durée connue d'avance, on la compte donc pour une attente LONGUE,
 * c'est-à-dire la fenêtre entière. Ce n'est pas un repli prudent : c'est déjà ce que le panneau du bloc
 * ANNONCE au client (« après une attente, seul un envoi de TEMPLATE peut encore partir »).
 *
 * ⚠️ Le défaut à ne pas laisser passer serait de rendre 0. L'analyse croirait alors la fenêtre encore
 * ouverte et laisserait publier « attendre jusqu'à demain 9 h, puis message rapide », un montage dont le
 * message ne partira jamais et dont personne ne serait prévenu.
 */
export function waitEstimationMs(node: WorkflowNode): number {
  return waitMode(node) === 'delai' ? waitDurationMs(node) : FENETRE_SERVICE_MS;
}

/**
 * L'instant visé par un bloc Attente en mode « date fixe ». Saisie vide ou illisible -> `null`.
 *
 * La date est saisie DANS LE BLOC (décision de Julien du 2026-09-08), pas prise dans un champ du contact :
 * ce dernier cas est déjà couvert par l'automation « un délai avant ou après une date enregistrée », et il
 * poserait ici la question du champ vide, qui n'a pas de bonne réponse dans un parcours déjà lancé.
 * Elle est lue comme une heure MURALE dans le fuseau de l'espace : « le 24 à 9 h » veut dire 9 h chez le
 * client, pas 9 h UTC.
 */
function cibleDeDate(node: WorkflowNode, ctx: EvalContext): Date | null {
  const brut = String(node.data.waitDate ?? '').trim();
  if (brut === '') return null;
  const d = parseInstant(brut, ctx.timeZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Dans combien de temps un bloc Attente doit reprendre, en millisecondes. C'est ce que l'exécution lit.
 *
 * 0 = PASSE-PLAT (on continue tout de suite), la doctrine de ce moteur pour tout bloc qu'on ne peut pas
 * exécuter (attente sans durée, question sans texte, agent non configuré) : un parcours FIGÉ n'a ni signal
 * ni recours, un parcours qui continue se voit.
 *
 * 🔴 LES DEUX MODES DATÉS EXIGENT `ctx` : sans l'instant courant, le fuseau et les horaires de l'espace, il
 * n'y a rien à calculer. L'exécuteur ne construit ce contexte que si le graphe le réclame, et c'est
 * `buildCtx` qui doit le savoir : sans cette ligne-là, un « attendre les heures ouvrées » deviendrait un
 * passe-plat et enverrait à 1 h du matin exactement ce qu'on voulait retenir. C'est le seul chemin par
 * lequel ce défaut peut passer, et c'est pourquoi il est tenu par un test plutôt que par une relecture.
 *
 * ⚠️ L'échéance est calculée UNE FOIS, ici, et le réveil repart au bloc SUIVANT : un bloc Attente ne se
 * réévalue jamais. Si le balayage prend des heures de retard (worker arrêté), un « jusqu'aux heures
 * ouvrées » repart à l'heure du réveil et non à l'ouverture. C'est la limite commune à toutes les échéances
 * de ce dépôt, pas une propriété de ces modes, et la corriger demanderait que le balayage rejoue le bloc.
 */
export function waitResumeInMs(node: WorkflowNode, ctx?: EvalContext): number {
  const mode = waitMode(node);
  if (mode === 'delai') return waitDurationMs(node);
  if (!ctx) return 0;
  const cible = mode === 'date'
    ? cibleDeDate(node, ctx)
    : prochaineOuverture(ctx.now, ctx.timeZone, ctx.businessHours);
  // `null` = rien à viser : une date illisible, ou une semaine ENTIÈREMENT fermée. `prochaineOuverture` rend
  // délibérément `null` dans ce dernier cas plutôt qu'une date lointaine, en laissant l'appelant décider :
  // ici, on décide passe-plat, pour la raison écrite plus haut.
  if (cible === null) return 0;
  // Une échéance DÉJÀ PASSÉE (une date d'hier, ou l'instant courant parce qu'on est déjà dans les heures
  // ouvertes) n'est pas une attente négative, c'est « il n'y a rien à attendre ».
  return Math.min(Math.max(0, cible.getTime() - ctx.now.getTime()), WAIT_MAX_MS);
}

/** Nombre MAXIMAL de lignes d'un menu. Plafond WhatsApp : « up to 10 rows for all sections combined ». */
export const QUESTION_MAX_ROWS = 10;
/** Plafonds de caractères d'une liste interactive WhatsApp, relevés sur la référence Cloud API le 2026-08-26. */
export const QUESTION_LIMITES = { body: 4096, bouton: 20, titre: 24, description: 72 } as const;

/**
 * Échéance « pas de réponse » d'un bloc Question, en millisecondes. 0 = aucune échéance : le parcours attend
 * indéfiniment, exactement comme après un template ou un message rapide à boutons.
 *
 * Mêmes unités et même plafond que le bloc Attente, à dessein : c'est la même notion de délai pour
 * l'utilisateur, et deux échelles différentes dans le même éditeur seraient un piège.
 */
export function questionTimeoutMs(node: WorkflowNode): number {
  const brut = Number(node.data.timeoutValue ?? 0);
  if (!Number.isFinite(brut) || brut <= 0) return 0;
  const unit = String(node.data.timeoutUnit ?? 'hours') as WaitUnit;
  const ms = UNIT_MS[unit];
  if (!ms) return 0;
  return Math.min(Math.round(brut * ms), WAIT_MAX_MS);
}

/**
 * Les lignes du menu d'un bloc Question, lues DÉFENSIVEMENT depuis `node.data.rows` (JSON libre).
 *
 * Rend le tableau ENTIER, lignes vides comprises : voir la mise en garde de `sendQuestion`, l'index EST la
 * sortie. Une forme inattendue (pas un tableau, entrée non objet) donne une ligne vide plutôt qu'un crash :
 * un scénario enregistré par une version antérieure ne doit jamais devenir illisible.
 */
export function questionRows(node: WorkflowNode): QuestionRow[] {
  const brut = node.data.rows;
  if (!Array.isArray(brut)) return [];
  return brut.slice(0, QUESTION_MAX_ROWS).map((r) => {
    const o = (r ?? {}) as { title?: unknown; description?: unknown };
    const title = String(o.title ?? '').trim().slice(0, QUESTION_LIMITES.titre);
    const description = String(o.description ?? '').trim().slice(0, QUESTION_LIMITES.description);
    return description === '' ? { title } : { title, description };
  });
}

/**
 * Une action ET le bloc qui l'a produite.
 *
 * Le bloc d'origine est porté ICI plutot que dans un tableau parallele au meme index : « meme longueur, meme
 * ordre » est un invariant que rien ne verifie et qui finit par se casser en silence. C'est ce lien qui rend
 * mesurable un scenario bloc par bloc (Analytics > Mes tableaux) : avant, l'executeur recevait une liste
 * d'actions dont il ne savait plus d'ou elles venaient.
 */
export interface WalkStep {
  nodeId: string;
  action: WorkflowAction;
}

export interface WalkResult {
  actions: WalkStep[];
  rest: WalkRest;
}

/** Bloc d'entrée d'un workflow = un bloc SANS arête entrante (racine). Défaut : le 1er bloc. null si vide. */
export function entryNode(graph: WorkflowGraph): string | null {
  if (graph.nodes.length === 0) return null;
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  const root = graph.nodes.find((n) => !hasIncoming.has(n.id));
  return (root ?? graph.nodes[0]!).id;
}

/** Le bloc suivant (cible de la 1re arête sortante). null s'il n'y en a pas. */
export function nextNode(graph: WorkflowGraph, nodeId: string): string | null {
  return graph.edges.find((e) => e.source === nodeId)?.target ?? null;
}

/** Le bloc suivant POUR un handle de sortie donné (branche par bouton : sourceHandle = `btn:<index>`).
 *  null si aucune arête ne part de ce handle. */
export function nextNodeByHandle(graph: WorkflowGraph, nodeId: string, handle: string): string | null {
  return graph.edges.find((e) => e.source === nodeId && e.sourceHandle === handle)?.target ?? null;
}

/** Le bloc suivant par une arête LIBRE, c'est-à-dire qui ne part d'aucun handle : la chaîne linéaire, ou la
 *  sortie tirée exprès depuis le corps du bloc pour dire « toute autre réponse ». null si TOUTES les arêtes
 *  sortantes partent d'un bouton.
 *
 *  Sert à router une réponse qui ne correspond à aucun bouton. `nextNode` prendrait la 1re arête venue, donc
 *  la branche du 1er bouton : un contact qui écrit « non merci » à un bloc Oui/Non se ferait taguer « oui ».
 *  Sans arête libre, le scénario n'a rien prévu pour ce cas, et s'arrêter vaut mieux qu'inventer une branche. */
export function nextNodeSansHandle(graph: WorkflowGraph, nodeId: string): string | null {
  return graph.edges.find((e) => e.source === nodeId && !e.sourceHandle)?.target ?? null;
}

/** Destinataire valide : littéral non vide, ou champ non vide à résoudre à l'envoi (executor). Toute autre
 *  forme (kind absent/inconnu, valeur/champ vide) -> null, comme un bloc non configuré. */
function emailRecipientOf(raw: unknown): EmailRecipient | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'literal' && typeof r.value === 'string' && r.value.trim() !== '') return { kind: 'literal', value: r.value };
  if (r.kind === 'field' && typeof r.field === 'string' && r.field.trim() !== '') return { kind: 'field', field: r.field };
  return null;
}

/**
 * Les destinataires d'un bloc email, lus depuis `data.to` opaque.
 *
 * 🔴 ACCEPTE LES DEUX FORMES, et ce n'est pas du confort. Jusqu'au 2026-08-25, `to` était un OBJET unique, et
 * les scénarios déjà enregistrés le portent tel quel dans leur JSONB : rien ne les renormalise à la lecture
 * (`parseGraph` laisse `data` opaque). Ne lire que la forme LISTE ferait rendre `null` à `actionOf`, donc
 * transformerait ces blocs en no-op TOTALEMENT SILENCIEUX (aucun log, aucun événement, aucun statut d'échec) :
 * des scénarios en production cesseraient d'envoyer sans que rien ne le dise. La forme objet est donc lue
 * comme une liste d'un élément, et elle doit le rester tant qu'un ancien graphe peut exister.
 *
 * Les entrées invalides sont ÉCARTÉES une à une plutôt que de faire échouer le tout : une 3e adresse laissée
 * vide ne doit pas empêcher les deux premières de recevoir. Liste vide -> null (bloc non configuré).
 */
/**
 * La valeur qu'un bloc « poser un champ » écrit, selon ce que l'utilisateur a choisi.
 *
 * 🔴 UN SEUL ENDROIT, appelé par le bloc `field` ET par l'action `set_field`, qui sont deux façons de décrire
 * le même geste. Le calcul y était écrit DEUX FOIS, à l'identique : la première divergence aurait fait qu'un
 * scénario écrit avec le bloc et un scénario écrit avec l'action ne poseraient plus la même valeur, sans que
 * rien ne le signale.
 *
 * `maintenant` : ISO 8601 AVEC LE DÉCALAGE du fuseau de l'espace, et non plus `toISOString()`.
 * Julien, le 2026-09-02 : « il faut que ça soit la valeur au format international qui prenne bien en compte
 * le GMT ». L'ancienne forme rendait toujours de l'UTC : l'instant était juste, mais l'heure LUE était fausse
 * de deux heures en été, et un système qui affichait la valeur telle quelle montrait 09:45 pour 11:45. Les
 * deux formes désignent le même instant, donc les conditions datetime comparent la même chose qu'avant.
 *
 * `derniere_saisie` : le dernier message écrit par le contact, pour le recopier dans un champ. Absent du
 * contexte (personne n'a encore écrit, ou le chargement a échoué) -> valeur VIDE, jamais inventée.
 *
 * Sans contexte du tout (analyse de graphe pure, hors exécution), tout ce qui est dynamique vaut vide.
 */
function valeurDuChamp(data: Record<string, unknown>, ctx?: EvalContext): string {
  const kind = String(data.valueKind ?? '');
  if (kind === 'now') return ctx ? formatMaintenant(ctx.now, ctx.timeZone) : '';
  if (kind === 'derniere_saisie') return ctx ? (ctx.derniereSaisie ?? '') : '';
  return String(data.value ?? '');
}

function emailRecipientsOf(raw: unknown): EmailRecipient[] | null {
  const bruts = Array.isArray(raw) ? raw : [raw];
  const out: EmailRecipient[] = [];
  for (const b of bruts) {
    const r = emailRecipientOf(b);
    if (r) out.push(r);
    if (out.length === MAX_DESTINATAIRES_EMAIL) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * Adresses réellement joignables d'un bloc email, résolues contre les variables du contact. PURE.
 *
 * Extraite du câblage d'envoi (`wiring.ts`) pour être testable : c'est elle qui décide qui reçoit, et à quel
 * titre. Chaque destinataire est résolu INDÉPENDAMMENT, parce qu'une adresse en mode variable lit
 * `contacts.fields`, qui est libre (import CSV, webhook, inbox) : rien ne garantit qu'elle soit renseignée, et
 * une 3e ligne vide ne doit pas priver les deux premières de leur mail.
 *
 * Les doublons sont écartés : le même champ pointé deux fois, ou une adresse fixe qui répète la valeur d'une
 * variable, enverrait deux exemplaires à la même personne.
 *
 * L'ordre est conservé : l'appelant met la PREMIÈRE en « À » et les suivantes en copie cachée.
 */
export function adressesDestinataires(to: EmailRecipient[], vars: Record<string, string | null>): string[] {
  return [...new Set(
    to
      .map((r) => (r.kind === 'literal' ? r.value : (vars[r.field] ?? '')))
      .map((a) => a.trim())
      .filter((a) => a !== ''),
  )];
}

/** Exportée : consommée directement par le test unitaire du node email (`actionOf` en isolation), sans passer
 *  par `walk`. */
export function actionOf(node: WorkflowNode, ctx?: EvalContext): WorkflowAction | null {
  if (node.type === 'question') {
    // Le CORPS fait foi pour « configuré » : sans question écrite, il n'y a rien à envoyer, donc rien à
    // attendre. Le menu, lui, est facultatif (une question sans menu attend une réponse libre).
    const body = String(node.data.body ?? '').trim();
    if (body === '') return null;
    const buttonLabel = String(node.data.buttonLabel ?? '').trim().slice(0, QUESTION_LIMITES.bouton);
    return {
      kind: 'sendQuestion',
      body: body.slice(0, QUESTION_LIMITES.body),
      // Meta EXIGE un libellé de bouton dès qu'il y a une liste. Un repli est plus honnête qu'un refus : le
      // bloc part avec « Choisir » plutôt que d'échouer sur un champ que personne n'a pensé à remplir.
      buttonLabel: buttonLabel === '' ? 'Choisir' : buttonLabel,
      rows: questionRows(node),
    };
  }
  if (node.type === 'tag') {
    const tag = String(node.data.tag ?? '').trim();
    return tag ? { kind: 'tag', tag } : null;
  }
  if (node.type === 'field') {
    const key = String(node.data.fieldKey ?? node.data.key ?? '').trim();
    if (!key) return null;
    return { kind: 'field', key, value: valeurDuChamp(node.data, ctx) };
  }
  if (node.type === 'action') {
    // Bloc unifié : la sous-action est portée par `data.actionKind`. add_tag/set_field produisent les MÊMES
    // actions que les blocs legacy tag/field ; remove_tag/clear_field sont les nouveaux retraits. Bloc incomplet
    // (tag/clé vide) -> null (no-op), comme les autres blocs.
    const kind = String(node.data.actionKind ?? '');
    const tag = String(node.data.tag ?? '').trim();
    const key = String(node.data.fieldKey ?? node.data.key ?? '').trim();
    if (kind === 'add_tag') return tag ? { kind: 'tag', tag } : null;
    if (kind === 'remove_tag') return tag ? { kind: 'removeTag', tag } : null;
    if (kind === 'set_field') {
      if (!key) return null;
      return { kind: 'field', key, value: valeurDuChamp(node.data, ctx) };
    }
    if (kind === 'clear_field') return key ? { kind: 'clearField', key } : null;
    // Consentement : rien à saisir, donc rien qui puisse rendre le bloc incomplet. C'est le SEUL chemin qui
    // pose un opt-out automatiquement (l'upsert d'import ne fait jamais régresser un statut), typiquement
    // derrière un mot-clé « STOP » branché en automation.
    if (kind === 'set_optin') return { kind: 'optIn', value: 'opted_in' };
    if (kind === 'set_optout') return { kind: 'optIn', value: 'opted_out' };
    return null;
  }
  if (node.type === 'template') {
    const templateName = String(node.data.templateName ?? '').trim();
    if (!templateName) return null;
    const raw = Array.isArray(node.data.templateButtons) ? node.data.templateButtons : [];
    const buttons: WorkflowButton[] = raw.map((b) => ({
      type: String((b as { type?: unknown }).type ?? ''),
      text: String((b as { text?: unknown }).text ?? ''),
    }));
    return { kind: 'sendTemplate', templateName, language: String(node.data.language ?? 'fr'), buttons };
  }
  if (node.type === 'flow') {
    // Node « formulaire » : envoie le flow en message interactif (hors template). Sans flowId -> null
    // (no-op waiting), même contrat qu'un template sans templateName. `body` = accroche du message,
    // `cta` = libellé du bouton d'ouverture (pré-rempli avec le cta du formulaire à la sélection).
    const flowId = String(node.data.flowId ?? '').trim();
    if (!flowId) return null;
    const flowName = String(node.data.flowName ?? '').trim();
    const body = String(node.data.body ?? '').trim() || (flowName ? `Formulaire : ${flowName}` : 'Formulaire à remplir');
    const cta = String(node.data.cta ?? '').trim().slice(0, 30) || 'Envoyer';
    return { kind: 'sendFlow', flowId, flowName, body, cta };
  }
  if (node.type === 'quick_message') {
    const body = String(node.data.body ?? '').trim();
    // Les réponses rapides gardent leur ORDRE (index = handle btn:<i> pour la branche) : on ne filtre PAS ici,
    // la couche d'envoi filtre les vides en préservant l'index. Bloc incomplet (pas de corps ou aucune réponse
    // non vide) -> null (no-op), comme un template sans templateName.
    const raw = Array.isArray(node.data.quickReplies) ? node.data.quickReplies : [];
    const buttons: WorkflowButton[] = raw.map((q) => ({ type: 'QUICK_REPLY', text: String(q ?? '') }));
    // Un bloc SANS aucune réponse rapide envoie quand même son TEXTE (la couche d'envoi bascule alors sur un
    // message simple). Avant, il ne faisait rien du tout, en silence : on croyait avoir programmé un message,
    // le contact ne recevait jamais rien et aucune erreur n'apparaissait nulle part.
    if (!body) return null;
    // Visuel facultatif. Même nom de champ que le bloc RCS (`imageUrl`) : un seul composant d'écran, une
    // seule convention de stockage, et le même visuel sert aux DEUX canaux (en-tête WhatsApp, carte RCS).
    const mediaUrl = String(node.data.imageUrl ?? '').trim();
    return { kind: 'sendQuickMessage', body, buttons, ...(mediaUrl ? { mediaUrl } : {}) };
  }
  if (node.type === 'email') {
    // Lecture défensive comme les autres blocs de config : `data` est opaque (parseGraph ne le valide pas pour
    // 'email', pareil que pour les autres types). Compte, modèle ou destinataire manquant/invalide -> null.
    const emailAccountId = String(node.data.emailAccountId ?? '').trim();
    const templateId = String(node.data.templateId ?? '').trim();
    const to = emailRecipientsOf(node.data.to);
    if (!emailAccountId || !templateId || !to) return null;
    return { kind: 'sendEmail', emailAccountId, templateId, to };
  }
  return null;
}

/**
 * Parcourt le graphe depuis `startNodeId` : accumule les actions des blocs synchrones, s'arrête au 1er bloc
 * bloquant (template/flow -> waiting, inbox -> inbox) ou en fin de chaîne (done). Anti-cycle : un bloc déjà
 * visité arrête le parcours (done). Un `startNodeId` inconnu -> done sans action.
 */
/** Répercute une action SYNCHRONE (tag/field, ajout OU retrait) sur la copie de travail du contexte, pour qu'une
 *  condition rencontrée plus loin dans le MÊME walk la voie (l'écriture en base n'a lieu qu'après, via
 *  executor.apply). Même normalisation de tag que le worker (trim + slice 64, dédup). `clearField` retire la clé
 *  (une condition `champ vide` en aval doit voir le champ absent, comme le SQL `fields - key`). */
function applyToWork(work: EvalContext, a: WorkflowAction): void {
  if (a.kind === 'tag') {
    const t = a.tag.trim().slice(0, 64);
    if (t !== '' && !work.tags.includes(t)) work.tags.push(t);
  } else if (a.kind === 'removeTag') {
    const t = a.tag.trim().slice(0, 64);
    work.tags = work.tags.filter((x) => x !== t);
  } else if (a.kind === 'field') {
    work.fields[a.key] = a.value;
  } else if (a.kind === 'clearField') {
    delete work.fields[a.key];
  }
}

export interface WalkOptions {
  /**
   * L'agent de Meta est-il allumé sur le numéro de ce tenant ?
   *
   * Il ne change qu'UNE chose : une étape qui n'offre aucun choix au client cesse de bloquer le parcours, parce
   * que l'agent reprend la parole et que les actions du scénario doivent continuer sans l'attendre. Sans MBA,
   * le comportement historique est conservé au caractère près (un template attend la réponse), pour ne rien
   * changer aux scénarios déjà en service chez les clients.
   */
  mbaActif?: boolean;
}

export function walk(graph: WorkflowGraph, startNodeId: string, ctx?: EvalContext, opts?: WalkOptions): WalkResult {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const actions: WalkStep[] = [];
  const visited = new Set<string>();
  // Copie de travail MUTABLE du contexte : une action tag/field décidée dans CE walk (appliquée en base seulement
  // APRÈS, via executor.apply) doit être visible par une condition rencontrée plus loin dans la MÊME chaîne
  // synchrone. Sans ça, Field(NOW) -> Condition(datetime not_empty) évaluerait contre l'état d'AVANT le field.
  const work: EvalContext | undefined = ctx ? { ...ctx, tags: [...ctx.tags], fields: { ...ctx.fields } } : undefined;
  let current: string | null = startNodeId;

  while (current) {
    if (visited.has(current)) return { actions, rest: { status: 'done' } };
    visited.add(current);
    const node = byId.get(current);
    if (!node) return { actions, rest: { status: 'done' } };

    if (node.type === 'inbox') {
      const a = typeof node.data.assigneA === 'string' ? node.data.assigneA.trim() : '';
      return { actions, rest: { status: 'inbox', assigneA: a === '' ? null : a } };
    }
    if (node.type === 'condition') {
      // Bloc SYNCHRONE sans action : évalue la condition (copie de travail) et suit la sortie 'true' (« Si réunie »)
      // ou 'false' (« Sinon »). Sans contexte (analyse de graphe pure) -> 'false' DÉTERMINISTE. Anti-cycle via visited.
      const here: string = current;
      const passed = work ? evaluateConditionGroup(coerceConditionGroup(node.data), work) : false;
      // Sorties TYPÉES : si la branche évaluée n'est pas câblée alors qu'AU MOINS une sortie typée ('true'/'false')
      // existe -> cul-de-sac (done), JAMAIS l'arête de l'autre branche. Repli sur la 1re arête uniquement pour un
      // node SANS aucune sortie typée (graphe legacy/non branché). Sinon `?? nextNode` volerait l'autre sortie.
      const hasTypedEdge = graph.edges.some((e) => e.source === here && (e.sourceHandle === 'true' || e.sourceHandle === 'false'));
      current = nextNodeByHandle(graph, here, passed ? 'true' : 'false') ?? (hasTypedEdge ? null : nextNode(graph, here));
      continue;
    }
    if (node.type === 'rcs_message') {
      // `walk` est PUR : il ne peut pas savoir si le numéro est joignable en RCS, c'est un appel réseau. Il rend
      // donc la main à l'executor, qui fera l'IO et reprendra par le handle 'sent' ou 'unreachable'. Les actions
      // déjà accumulées partent maintenant, comme pour un bloc Attente.
      return { actions, rest: { status: 'rcs_send', nodeId: current } };
    }
    if (node.type === 'agent') {
      // `walk` est PUR : il ne peut pas savoir ce que le modèle répondra. Il rend donc la main à l'executor,
      // qui ouvrira la session et enfilera un tour. Les actions déjà accumulées partent maintenant, comme pour
      // un bloc RCS ou un bloc Attente.
      // Non configuré = PASSE-PLAT, même choix que le bloc Question sans texte : rendre la main à un agent qui
      // n'existe pas figerait le parcours pour toujours, sans le moindre signal. `data` est opaque et vient du
      // client, d'où la coercition.
      const agentId = String(node.data.agentId ?? '').trim();
      if (!agentId) {
        // 🔴 Le passe-plat suit une arête LIBRE, jamais une sortie typée. Même règle que le bloc Condition
        // juste au-dessus, et pour la même raison : les sorties d'un bloc agent (`sortie:<code>`, `timeout`)
        // sont des issues PRÉCISES. Un `nextNode` prendrait la première arête venue, donc typiquement la
        // branche « échec technique » d'un bloc qu'on vient juste de vider de son agent, et y enverrait tous
        // les contacts sans le moindre signal. Aucune arête libre -> le parcours s'arrête ici.
        current = nextNodeSansHandle(graph, current);
        continue;
      }
      return { actions, rest: { status: 'agent_turn', nodeId: current } };
    }
    if (node.type === 'question') {
      const a = actionOf(node, work);
      if (!a) {
        // Question SANS texte : rien ne part, donc attendre une réponse à une question jamais posée figerait
        // le parcours pour toujours, sans le moindre signal. Passe-plat, comme un bloc Attente sans durée.
        // ⚠️ Divergence ASSUMÉE avec `quick_message`, qui lui bloque même non configuré : là-bas le
        // comportement est historique, ici on choisit celui qui se voit (la conversation continue).
        current = nextNode(graph, current);
        continue;
      }
      actions.push({ nodeId: current, action: a });
      // Il ATTEND toujours, menu ou pas. L'échéance éventuelle voyage avec le repos : c'est l'executor qui la
      // traduit en `resume_at`, le walk reste pur.
      const ms = questionTimeoutMs(node);
      return { actions, rest: { status: 'waiting', nodeId: current, ...(ms > 0 ? { timeoutInMs: ms } : {}) } };
    }
    if (node.type === 'template' || node.type === 'flow' || node.type === 'quick_message') {
      const a = actionOf(node, work);
      if (a) actions.push({ nodeId: current, action: a });
      // Sans MBA : seul un message rapide sans bouton continue (règle historique). Avec MBA : TOUTE étape qui
      // n'offre pas de choix continue, l'agent de Meta répondant à sa place.
      const continuer = !etapeOffreUnChoix(a) && (opts?.mbaActif === true || a?.kind === 'sendQuickMessage');
      if (continuer) {
        current = nextNode(graph, current);
        continue;
      }
      return { actions, rest: { status: 'waiting', nodeId: current } };
    }
    if (node.type === 'wait') {
      // Bloc ATTENTE : il n'agit pas, il met le parcours en sommeil jusqu'à l'échéance. Les actions déjà
      // accumulées partent MAINTENANT ; la suite reprendra depuis ce bloc (le sweeper repart de son successeur).
      // `waitResumeInMs`, jamais `waitDurationMs` : c'est ici que les modes « date fixe » et « heures ouvrées »
      // calculent leur échéance, depuis l'instant courant du contexte.
      const ms = waitResumeInMs(node, work);
      if (ms > 0) return { actions, rest: { status: 'sleeping', nodeId: current, resumeInMs: ms } };
      current = nextNode(graph, current); // rien à attendre (durée non configurée, échéance passée) -> passe-plat
      continue;
    }
    // tag / field / email : bloc synchrone -> action + on continue. On répercute l'effet dans la copie de
    // travail (email n'y a rien à répercuter, applyToWork ignore son kind, comme optIn).
    const a = actionOf(node, work);
    if (a) {
      actions.push({ nodeId: current, action: a });
      if (work) applyToWork(work, a);
    }
    current = nextNode(graph, current);
  }
  return { actions, rest: { status: 'done' } };
}
