import type { WorkflowGraph, WorkflowNode } from './graph';
import { evaluateConditionGroup, coerceConditionGroup, parseInstant } from './conditions';
import type { EvalContext } from './conditions';
// « Quand est le prochain créneau ouvert ? » vit à un seul endroit : le bloc Attente, l'envoi de campagne et
// sa reprise après la fermeture doivent avoir la même réponse.
import { prochaineOuverture } from '../lib/heures-ouvrees';
// Le format de « maintenant » vit dans `src/agent/variables.ts` : un connecteur et un bloc de scénario doivent
// poser la même valeur.
import { formatMaintenant } from '../agent/variables';

/**
 * Moteur d'exécution d'un workflow, pur (aucune IO). Un run avance de bloc en bloc : les blocs synchrones
 * (tag/field) produisent une action et on continue ; un bloc qui offre un choix produit son action puis attend
 * une réponse du contact ; `inbox` est terminal (remontée humaine).
 */

/** Bouton d'un template (dénormalisé sur le node à la sélection) : sert à envoyer un payload contrôlé par
 *  bouton quick-reply (branche déterministe) et à afficher les sorties dans l'éditeur. */
export interface WorkflowButton { type: string; text: string }

/** Destinataire du node « Envoi de mail » : adresse en dur, ou variable résolue depuis un champ du contact
 *  (même identité déjà résolue pour l'envoi de template : téléphone ou BSUID, pas un nouveau chemin). */
export type EmailRecipient =
  | { kind: 'literal'; value: string }
  | { kind: 'field'; field: string };

/** Nombre maximal de destinataires d'un bloc « Envoi de mail ». Borné ici, côté moteur : `parseGraph` ne
 *  regarde pas `data`, donc un graphe fabriqué à la main passerait autant d'adresses qu'il veut. Le surplus
 *  est tronqué (un refus ferait du bloc un no-op muet). */
export const MAX_DESTINATAIRES_EMAIL = 3;

/** Action « Envoi de mail » : boîte SMTP + modèle + destinataires (ids/valeurs opaques), consommée par
 *  l'executor. `to` est une liste (1 à 3) jamais vide : le premier part en « À », les suivants en copie
 *  cachée, car des clients ne doivent pas voir les adresses les uns des autres. */
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
  /**
   * Bloc « Appel HTTP » : joue la requête `requestId` de la bibliothèque et range sa réponse dans `champCible`.
   * L'action porte de quoi aller chercher la réponse, pas la réponse : le walk est pur, l'exécuteur fait
   * l'appel.
   */
  | { kind: 'appelHttp'; requestId: string; champCible: string }
  /**
   * Bloc « Fonction JS » : transforme `champSource` par `code` et range le résultat dans `champCible`. La
   * valeur est relue au moment d'exécuter, pas au walk : un bloc précédent vient peut-être d'écrire ce champ.
   */
  | { kind: 'fonctionJs'; code: string; champSource: string; champCible: string }
  /** Consentement marketing posé par un scénario. Les deux sens, comme depuis la fiche et l'action en masse. */
  | { kind: 'optIn'; value: 'opted_in' | 'opted_out' }
  | { kind: 'sendTemplate'; templateName: string; language: string; buttons: WorkflowButton[] }
  /** `mediaUrl` = visuel du bloc, hébergé chez nous (`/m/<code>.<ext>`), le même champ que le bloc RCS.
   *  Absent = message texte.
   *
   *  `lien` = un bouton de lien (WhatsApp `cta_url`, RCS `openUrl`) au lieu de réponses rapides. Les deux
   *  s'excluent chez Meta (deux types de messages interactifs) : quand `lien` est présent, `buttons` est vidé
   *  à la construction de l'action, pour que la couche d'envoi n'ait pas à choisir. `etapeOffreUnChoix` rend
   *  alors `false` et le parcours continue, puisque Meta ne renvoie rien au clic sur un lien. */
  | { kind: 'sendQuickMessage'; body: string; buttons: WorkflowButton[]; mediaUrl?: string; lien?: LienBouton }
  | { kind: 'sendFlow'; flowId: string; flowName: string; body: string; cta: string }
  /**
   * Bloc Question : une question au contact, avec un menu de réponses (liste interactive WhatsApp) ou sans
   * menu. Il attend toujours une réponse, et peut porter une échéance « pas de réponse ».
   *
   * `rows` est transmis entier, lignes au libellé vide comprises : l'index d'une ligne est sa sortie
   * (`row:<i>`), et filtrer en amont renumérote et envoie le contact sur la mauvaise branche. Le filtrage se
   * fait à l'envoi, en préservant l'index.
   */
  | { kind: 'sendQuestion'; body: string; buttonLabel: string; rows: QuestionRow[] }
  | SendEmailAction;

/** Une ligne du menu d'un bloc Question. `title` est ce que le contact lit, `description` est facultative. */
export interface QuestionRow {
  title: string;
  description?: string;
}

/** Ce que l'ouverture d'un scénario contient, en un seul parcours (séparer les deux questions posées sur
 *  l'ouverture dupliquerait la traversée et ses règles). */
export interface OpeningScan {
  /** Un message de session (message rapide / formulaire) part-il avant tout template ? */
  sessionOpen: boolean;
  /**
   * Un bloc RCS configuré ouvre-t-il le scénario ? C'est une ouverture légale à froid, comme un template : la
   * fenêtre de 24 h est une contrainte de WhatsApp, et le RCS ne passe pas par WhatsApp.
   */
  rcsOpen: boolean;
  /** Le 1er template atteignable (parcours en largeur : l'ordre reflète la proximité de l'entrée). */
  firstTemplate: WorkflowNode | null;
  /** Plusieurs templates différents peuvent ouvrir (branches d'une condition) -> aucune ouverture unique. */
  ambiguousTemplate: boolean;
  /** Une attente est traversée avant le 1er template : rien ne part au lancement. */
  waitBeforeTemplate: boolean;
  /** Un template d'ouverture atteint n'a pas de nom : rien ne partirait sur cette branche, et le destinataire
   *  serait pourtant compté « envoyé ». Distinct de `firstTemplate === null` (aucun template du tout). */
  unnamedOpeningTemplate: boolean;
}

/**
 * Explore, depuis l'entrée, tout ce qui est atteignable avant le premier envoi. Les blocs synchrones sont
 * traversés, un bloc `condition` explore ses deux sorties, `template` et `inbox` arrêtent leur branche.
 *
 * En largeur (file, pas pile) : « le premier template » doit être le plus proche de l'entrée, sinon le
 * mapping de variables d'une campagne viserait un template arbitraire selon l'ordre d'insertion des blocs.
 *
 * `depuis` : le bloc d'où partir, pour la cible `node` de l'API publique (`ouvertureApi`) ; absent, on part
 * de l'entrée. Le miroir `web/lib/campaign-eligibility.ts` n'a pas de point de départ et ne doit pas en
 * avoir. Un `depuis` absent du graphe rend un examen vide : rien n'ouvre.
 */
export function scanOpening(graph: WorkflowGraph, depuis?: string): OpeningScan {
  const out: OpeningScan = { sessionOpen: false, rcsOpen: false, firstTemplate: null, ambiguousTemplate: false, waitBeforeTemplate: false, unnamedOpeningTemplate: false };
  const entry = depuis ?? entryNode(graph);
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
      continue; // bloc bloquant non configuré (pas d'action) : pas une ouverture, et on ne va pas au-delà
    }
    if (node.type === 'question') {
      // Message de session comme un message rapide (la liste interactive est soumise à la fenêtre de 24 h) :
      // une question ne peut pas ouvrir une campagne.
      const a = actionOf(node);
      if (a) { out.sessionOpen = true; continue; }
      // Non configuré = passe-plat dans `walk` : l'analyse doit suivre le même parcours que le moteur.
      const suite = nextNode(graph, id);
      if (suite) queue.push(suite);
      continue;
    }
    if (node.type === 'agent') {
      // L'agent envoie du texte libre : un message de session, qui bloque l'exploration puisque `walk` s'y
      // arrête. Sans ce cas, « agent puis template » serait vu comme ouvrant sur le template, et au lancement
      // rien ne partirait alors que les destinataires seraient comptés touchés.
      if (String(node.data.agentId ?? '').trim() !== '') { out.sessionOpen = true; continue; }
      // Non configuré = passe-plat dans `walk` : l'analyse doit suivre le même parcours que le moteur.
      const suite = nextNode(graph, id);
      if (suite) queue.push(suite);
      continue;
    }
    if (node.type === 'rcs_message') {
      // Ouverture à froid légale. `waitBeforeTemplate` est déjà juste ici (parcours en largeur) : une attente
      // placée avant ce bloc empêche tout départ au lancement.
      if (String(node.data.text ?? '').trim() !== '' && !out.waitBeforeTemplate) out.rcsOpen = true;
      // On explore au-delà : la sortie « non joignable » mène souvent au template de repli, que la campagne
      // doit savoir paramétrer.
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
 * Ce message rapide laisse-t-il le parcours continuer ? Oui quand il n'a aucune réponse rapide libellée :
 * c'est un simple texte, rien ne viendra en retour, et bloquer là empêcherait les blocs suivants de
 * s'exécuter. Source unique de la règle pour `walk` et `waitBeforeSessionMessage`, qui doivent répondre
 * pareil.
 */
function quickMessageNonBloquant(a: WorkflowAction | null): boolean {
  return a?.kind === 'sendQuickMessage' && !etapeOffreUnChoix(a);
}

/** Le bouton de lien d'un message rapide : un libellé, une adresse. */
export interface LienBouton { texte: string; url: string }

/**
 * Ce bouton de lien est-il utilisable ? Rend la raison du refus, ou `null` quand il est bon.
 *
 * Un refus explicite, jamais un envoi sans le bouton que le client a coché. Aucune variable dans l'adresse :
 * une variable vide ferait refuser le message entier par Meta. On ne vérifie pas que l'adresse est
 * publiquement joignable (`urlRecuperable`) : ces gardes protègent nos requêtes sortantes, et ici c'est le
 * contact qui ouvre la page, dans son navigateur.
 */
export function problemeLienBouton(lien: LienBouton): string | null {
  if (lien.texte.trim() === '') return 'le bouton de lien du bloc « message rapide » n’a pas de libellé';
  const url = lien.url.trim();
  if (url === '') return 'le bouton de lien du bloc « message rapide » n’a pas d’adresse';
  if (url.includes('{{')) return 'l’adresse du bouton de lien ne peut pas contenir de variable';
  let parsee: URL;
  try { parsee = new URL(url); } catch { return 'l’adresse du bouton de lien n’est pas une adresse valide'; }
  if (parsee.protocol !== 'http:' && parsee.protocol !== 'https:') {
    return 'l’adresse du bouton de lien doit commencer par http:// ou https://';
  }
  return null;
}

/**
 * L'étape présente-t-elle un choix au client (un bouton ou une réponse rapide réellement libellé) ?
 *
 * C'est le prédicat du contrôle du fil : « le scénario attend-il une réponse ? » et « gardons-nous la main
 * face à l'agent de Meta ? » sont la même question. Une étape qui offre un choix garde la main (la réponse
 * doit nous revenir pour être appariée au bouton) ; une étape qui n'offre rien la relâche. Un formulaire
 * attend forcément une saisie : il offre donc un choix, sans bouton.
 */
export function etapeOffreUnChoix(a: WorkflowAction | null): boolean {
  if (a === null) return false;
  if (a.kind === 'sendFlow') return true;
  // Un bloc Question attend toujours, menu ou pas : sans menu, on attend la réponse libre du contact.
  // Dépendre de `rows` ferait enchaîner le bloc suivant sans jamais lire la réponse.
  if (a.kind === 'sendQuestion') return true;
  if (a.kind === 'sendTemplate' || a.kind === 'sendQuickMessage') return a.buttons.some((b) => b.text.trim() !== '');
  return false;
}

/**
 * La fenêtre de service WhatsApp : 24 h depuis le dernier message du contact. Au-delà, Meta refuse tout ce
 * qui n'est pas un template (131047). Partagée par l'analyse de montage et `waitEstimationMs`.
 */
export const FENETRE_SERVICE_MS = 24 * 3_600_000;

/** Un montage impossible : une attente qui ferme forcément la fenêtre, suivie d'un message de session. */
export interface WaitThenSession {
  /** Le dernier bloc Attente traversé sur ce chemin (celui qu'on montre à l'utilisateur). */
  waitNodeId: string;
  /** Le bloc message rapide / formulaire qui ne partira jamais. */
  messageNodeId: string;
}

/**
 * Cherche un chemin « attente cumulée >= 24 h, puis message rapide ou formulaire ». Ce montage ne peut
 * jamais marcher : après 24 h d'attente la fenêtre de service est fermée à coup sûr (131047). Le runtime le
 * bloque (`executor.resume` teste la fenêtre réelle au réveil) ; cette fonction sert à le dire dans le
 * builder. Sous 24 h on ne dit rien : le contact a pu écrire entre-temps, c'est au runtime de trancher.
 *
 * Termine sur les graphes cycliques : le cumul est plafonné à 24 h, et un bloc n'est ré-exploré qu'avec un
 * cumul strictement plus grand.
 */
export function waitBeforeSessionMessage(graph: WorkflowGraph): WaitThenSession | null {
  // Chaque attente compte pour au moins un pas de balayage (60 s), la granularité réelle d'un réveil : sinon un
  // délai fractionnaire (`{delay: 0.001}`) dans un cycle demanderait des millions d'itérations.
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
      // Une question est un message de session : même signalement que pour un message rapide ou un formulaire.
      const a = actionOf(node);
      if (a && cumul >= FENETRE_SERVICE_MS && dernierWait) return { waitNodeId: dernierWait, messageNodeId: id };
      // Configurée, elle bloque (elle attend une réponse) : l'analyse s'arrête là. Non configurée, elle est un
      // passe-plat : on explore au-delà.
      if (a) continue;
      const apres = nextNode(graph, id);
      if (apres) pile.push({ id: apres, cumul, dernierWait });
      continue;
    }
    if (node.type === 'agent') {
      // Le premier message de l'agent est un message de session : même signalement que pour un message rapide.
      const configure = String(node.data.agentId ?? '').trim() !== '';
      if (configure && cumul >= FENETRE_SERVICE_MS && dernierWait) return { waitNodeId: dernierWait, messageNodeId: id };
      // Configuré, il bloque (il tient la conversation) : l'analyse s'arrête là. Non configuré, il est un
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
      // Un message rapide sans bouton ne bloque pas le parcours (cf. `walk`) : on explore au-delà, sinon un
      // montage « attente, message sans bouton, attente, message rapide » ne serait jamais signalé. Un bloc
      // réellement bloquant arrête l'analyse.
      if (!quickMessageNonBloquant(a)) continue;
      const nx = nextNode(graph, id);
      if (nx) pile.push({ id: nx, cumul, dernierWait });
      continue;
    }
    // Un template remet le compteur à zéro. Il n'ouvre pas la fenêtre (seul un message du contact l'ouvre),
    // mais le parcours s'arrête au template jusqu'à la réponse, et c'est cette réponse qui rouvre la fenêtre.
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
   * En attente d'une réponse du contact (après un template, un formulaire, une question). `timeoutInMs` est
   * l'échéance « pas de réponse » d'un bloc Question. Absent = attente sans limite.
   */
  | { status: 'waiting'; nodeId: string; timeoutInMs?: number }
  | { status: 'sleeping'; nodeId: string; resumeInMs: number } // en attente du temps qui passe (bloc Attente)
  // Bloc RCS : pas un état de repos, une main rendue. Le walk est pur et ne sait pas si le numéro est
  // joignable : l'executor fait l'IO puis reprend par 'sent' ou 'unreachable'. Toujours résolu par
  // `walkResolved`, ce statut n'atteint jamais `restToState`.
  | { status: 'rcs_send'; nodeId: string }
  // Bloc agent : une main rendue aussi. L'executor persiste, ouvre la session et enfile un tour ; le parcours
  // reprendra par un handle de sortie. Contrairement à rcs_send, il atteint réellement `restToState`, qui a
  // donc un cas explicite pour ne pas clore le parcours en `done` au moment où l'agent prend la main.
  | { status: 'agent_turn'; nodeId: string }
  /**
   * Conversation remontée à l'humain (terminal). `assigneA` voyage avec le statut : l'exécuteur n'a pas le
   * nœud sous la main quand il escalade, et une seconde lecture du graphe pourrait diverger.
   */
  | { status: 'inbox'; assigneA?: string | null }
  | { status: 'done' }; // fin de chaîne (plus d'arête sortante)

/** Unités proposées par le bloc Attente. */
export const WAIT_UNITS = ['minutes', 'hours', 'days'] as const;
export type WaitUnit = (typeof WAIT_UNITS)[number];
const UNIT_MS: Record<WaitUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
/** Plafond : 30 jours. Au-delà, un parcours dormant n'a plus de sens métier ; borner évite aussi une
 *  échéance absurde posée par une saisie erronée. */
export const WAIT_MAX_MS = 30 * 86_400_000;

/**
 * Les trois façons de dire quand un bloc Attente reprend. `delai` est le défaut : un scénario ancien n'a pas
 * ce champ et doit se comporter exactement comme avant.
 */
export const WAIT_MODES = ['delai', 'date', 'heures_ouvrees'] as const;
export type WaitMode = (typeof WAIT_MODES)[number];

/** Le mode d'un bloc Attente, lu défensivement (`data` est du JSON libre venu du client). Inconnu -> `delai`,
 *  jamais une erreur : un scénario enregistré par une version ultérieure ne doit pas devenir illisible. */
export function waitMode(node: WorkflowNode): WaitMode {
  const brut = String(node.data.waitMode ?? 'delai');
  return (WAIT_MODES as readonly string[]).includes(brut) ? (brut as WaitMode) : 'delai';
}

/**
 * Durée d'un bloc Attente en mode délai, en millisecondes. 0 = bloc non configuré (durée absente, nulle,
 * négative ou unité inconnue) : passe-plat, on ne bloque pas un parcours sur une saisie oubliée.
 *
 * Rend 0 pour les deux modes datés, dont l'échéance ne se calcule qu'à l'exécution (un `delay` resté dans
 * `data` annoncerait une durée que le bloc ne tiendra pas). Voir `waitResumeInMs` pour l'exécution et
 * `waitEstimationMs` pour l'analyse de graphe.
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
 * La durée qu'une analyse de graphe doit prêter à un bloc Attente, en millisecondes. Ce n'est pas
 * `waitDurationMs` : `waitBeforeSessionMessage` tourne à la publication, sans connaître l'instant
 * d'exécution. Une attente « jusqu'à une date » ou « jusqu'aux heures ouvrées » compte donc pour la fenêtre
 * entière, ce que le panneau du bloc annonce déjà au client. Rendre 0 laisserait publier « attendre jusqu'à
 * demain 9 h, puis message rapide », dont le message ne partira jamais.
 */
export function waitEstimationMs(node: WorkflowNode): number {
  return waitMode(node) === 'delai' ? waitDurationMs(node) : FENETRE_SERVICE_MS;
}

/**
 * L'instant visé par un bloc Attente en mode « date fixe ». Saisie vide ou illisible -> `null`.
 *
 * La date est saisie dans le bloc, pas prise dans un champ du contact (ce cas est couvert par l'automation
 * « un délai avant ou après une date enregistrée »). Elle est lue comme une heure murale dans le fuseau de
 * l'espace : « le 24 à 9 h » veut dire 9 h chez le client, pas 9 h UTC.
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
 * 0 = passe-plat, la doctrine de ce moteur pour tout bloc qu'on ne peut pas exécuter : un parcours figé n'a
 * ni signal ni recours, un parcours qui continue se voit.
 *
 * Les deux modes datés exigent `ctx` (instant, fuseau, horaires) : c'est `buildCtx` qui doit savoir le
 * construire pour eux, sinon « attendre les heures ouvrées » deviendrait un passe-plat et enverrait à 1 h du
 * matin. Tenu par un test.
 *
 * L'échéance est calculée une fois, ici, et le réveil repart au bloc suivant : si le balayage prend du retard
 * (worker arrêté), un « jusqu'aux heures ouvrées » repart à l'heure du réveil et non à l'ouverture.
 */
export function waitResumeInMs(node: WorkflowNode, ctx?: EvalContext): number {
  const mode = waitMode(node);
  if (mode === 'delai') return waitDurationMs(node);
  if (!ctx) return 0;
  const cible = mode === 'date'
    ? cibleDeDate(node, ctx)
    : prochaineOuverture(ctx.now, ctx.timeZone, ctx.businessHours);
  // `null` = rien à viser : une date illisible, ou une semaine entièrement fermée (`prochaineOuverture` rend
  // `null` plutôt qu'une date lointaine). Ici, passe-plat.
  if (cible === null) return 0;
  // Une échéance déjà passée (une date d'hier, ou déjà dans les heures ouvertes) : rien à attendre.
  return Math.min(Math.max(0, cible.getTime() - ctx.now.getTime()), WAIT_MAX_MS);
}

/** Nombre maximal de lignes d'un menu. Plafond WhatsApp : « up to 10 rows for all sections combined ». */
export const QUESTION_MAX_ROWS = 10;
/** Plafonds de caractères d'une liste interactive WhatsApp (référence Cloud API). */
export const QUESTION_LIMITES = { body: 4096, bouton: 20, titre: 24, description: 72 } as const;

/**
 * Échéance « pas de réponse » d'un bloc Question, en millisecondes. 0 = aucune échéance : le parcours attend
 * indéfiniment. Mêmes unités et même plafond que le bloc Attente : c'est la même notion de délai pour
 * l'utilisateur.
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
 * Les lignes du menu d'un bloc Question, lues défensivement depuis `node.data.rows` (JSON libre). Rend le
 * tableau entier, lignes vides comprises (l'index est la sortie, voir `sendQuestion`). Une forme inattendue
 * donne une ligne vide plutôt qu'un crash.
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
 * Une action et le bloc qui l'a produite. Le bloc d'origine est porté ici plutôt que dans un tableau
 * parallèle (« même longueur, même ordre » finit par se casser en silence) : c'est ce lien qui rend un
 * scénario mesurable bloc par bloc (Analytics > Mes tableaux).
 */
export interface WalkStep {
  nodeId: string;
  action: WorkflowAction;
}

export interface WalkResult {
  actions: WalkStep[];
  rest: WalkRest;
}

/** Bloc d'entrée d'un workflow = un bloc sans arête entrante (racine). Défaut : le 1er bloc. null si vide. */
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

/** Le bloc suivant pour un handle de sortie donné (branche par bouton : sourceHandle = `btn:<index>`).
 *  null si aucune arête ne part de ce handle. */
export function nextNodeByHandle(graph: WorkflowGraph, nodeId: string, handle: string): string | null {
  return graph.edges.find((e) => e.source === nodeId && e.sourceHandle === handle)?.target ?? null;
}

/** Le bloc suivant par une arête libre (qui ne part d'aucun handle) : la chaîne linéaire, ou la sortie
 *  « toute autre réponse ». null si toutes les arêtes sortantes partent d'un bouton.
 *
 *  Sert à router une réponse qui ne correspond à aucun bouton. `nextNode` prendrait la 1re arête venue,
 *  donc la branche du 1er bouton : un contact qui écrit « non merci » à un bloc Oui/Non se ferait taguer
 *  « oui ». Sans arête libre, s'arrêter vaut mieux qu'inventer une branche. */
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
 * `emailRecipientsOf` : les destinataires d'un bloc email, lus depuis `data.to` opaque. Accepte les deux
 * formes : un objet unique (scénarios anciens, jamais renormalisés puisque `parseGraph` laisse `data`
 * opaque) ou une liste. Ne lire que la liste ferait de ces blocs des no-op silencieux. Les entrées invalides
 * sont écartées une à une (une 3e adresse vide n'empêche pas les deux premières). Liste vide -> null.
 */
/**
 * La valeur qu'un bloc « poser un champ » écrit. Un seul endroit pour le bloc `field` et l'action
 * `set_field`, deux façons de décrire le même geste, qui doivent poser la même valeur.
 *
 * `now` : ISO 8601 avec le décalage du fuseau de l'espace (`formatMaintenant`), pour qu'un système qui
 * affiche la valeur telle quelle montre l'heure locale ; l'instant reste le même pour les conditions.
 * `derniere_saisie` : le dernier message écrit par le contact ; absent du contexte -> vide, jamais inventé.
 * Sans contexte (analyse de graphe pure), tout ce qui est dynamique vaut vide.
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
 * Adresses réellement joignables d'un bloc email, résolues contre les variables du contact. Pure.
 *
 * Chaque destinataire est résolu indépendamment : une adresse en mode variable lit `contacts.fields`, libre,
 * et une 3e ligne vide ne doit pas priver les deux premières de leur mail. Les doublons sont écartés (deux
 * exemplaires à la même personne). L'ordre est conservé : l'appelant met la première en « À » et les
 * suivantes en copie cachée.
 */
export function adressesDestinataires(to: EmailRecipient[], vars: Record<string, string | null>): string[] {
  return [...new Set(
    to
      .map((r) => (r.kind === 'literal' ? r.value : (vars[r.field] ?? '')))
      .map((a) => a.trim())
      .filter((a) => a !== ''),
  )];
}

/** Exportée pour le test unitaire du node email (`actionOf` en isolation). */
export function actionOf(node: WorkflowNode, ctx?: EvalContext): WorkflowAction | null {
  if (node.type === 'question') {
    // Le corps fait foi pour « configuré » : sans question écrite, rien à envoyer ni à attendre. Le menu est
    // facultatif (une question sans menu attend une réponse libre).
    const body = String(node.data.body ?? '').trim();
    if (body === '') return null;
    const buttonLabel = String(node.data.buttonLabel ?? '').trim().slice(0, QUESTION_LIMITES.bouton);
    return {
      kind: 'sendQuestion',
      body: body.slice(0, QUESTION_LIMITES.body),
      // Meta exige un libellé de bouton dès qu'il y a une liste : repli sur « Choisir » plutôt qu'un échec.
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
  if (node.type === 'http') {
    // Bloc incomplet (aucun appel choisi, ou aucun champ cible) -> `null`, un no-op qui laisse le parcours
    // continuer : un bloc à moitié réglé ne doit pas casser un scénario en production.
    const requestId = String(node.data.requestId ?? '').trim();
    const champCible = String(node.data.champCible ?? '').trim();
    return requestId !== '' && champCible !== '' ? { kind: 'appelHttp', requestId, champCible } : null;
  }
  if (node.type === 'js') {
    /**
     * La source vit dans `data.js`, pas dans `data.code` : `data.code` porte le code public du bloc
     * (`nod_<client>_<ULID>`), que `mintNodeCodes` refait à chaque enregistrement dès que la valeur ne
     * ressemble pas à un code valide, ce qui écrasait le JavaScript. Le repli sur `data.code` récupère les
     * graphes pas encore réécrits, sans risque : un code minté est reconnaissable.
     */
    const brutJs = typeof node.data.js === 'string' ? node.data.js : '';
    const ancien = String(node.data.code ?? '');
    const code = brutJs !== '' ? brutJs : (/^nod_[a-z0-9]+_[0-9A-HJKMNP-TV-Z]{26}$/.test(ancien) ? '' : ancien);
    const champSource = String(node.data.champSource ?? '').trim();
    const champCible = String(node.data.champCible ?? '').trim();
    // Bloc à moitié réglé -> no-op. Le code vide compte comme non réglé : l'exécuter écrirait une valeur vide,
    // qui ressemblerait à un échec de la fonction.
    return code.trim() !== '' && champSource !== '' && champCible !== ''
      ? { kind: 'fonctionJs', code, champSource, champCible }
      : null;
  }
  if (node.type === 'action') {
    // Bloc unifié : la sous-action est portée par `data.actionKind`. add_tag/set_field produisent les mêmes
    // actions que les blocs legacy tag/field. Bloc incomplet (tag/clé vide) -> null (no-op).
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
    // Consentement : rien à saisir, donc jamais incomplet. Seul chemin qui pose un opt-out automatiquement
    // (l'upsert d'import ne fait jamais régresser un statut), typiquement derrière un mot-clé « STOP ».
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
    // Node « formulaire » : envoie le flow en message interactif (hors template). Sans flowId -> null, comme un
    // template sans templateName. `body` = accroche, `cta` = libellé du bouton d'ouverture.
    const flowId = String(node.data.flowId ?? '').trim();
    if (!flowId) return null;
    const flowName = String(node.data.flowName ?? '').trim();
    const body = String(node.data.body ?? '').trim() || (flowName ? `Formulaire : ${flowName}` : 'Formulaire à remplir');
    const cta = String(node.data.cta ?? '').trim().slice(0, 30) || 'Envoyer';
    return { kind: 'sendFlow', flowId, flowName, body, cta };
  }
  if (node.type === 'quick_message') {
    const body = String(node.data.body ?? '').trim();
    // Les réponses rapides gardent leur ordre (index = handle btn:<i>) : pas de filtre ici, la couche d'envoi
    // filtre les vides en préservant l'index.
    const raw = Array.isArray(node.data.quickReplies) ? node.data.quickReplies : [];
    const buttons: WorkflowButton[] = raw.map((q) => ({ type: 'QUICK_REPLY', text: String(q ?? '') }));
    // Un bloc sans aucune réponse rapide envoie quand même son texte (message simple, ou `cta_url` s'il porte
    // un bouton de lien). Sans corps -> null.
    if (!body) return null;
    // Visuel facultatif. Même champ que le bloc RCS (`imageUrl`) : le même visuel sert aux deux canaux
    // (en-tête WhatsApp, carte RCS).
    const mediaUrl = String(node.data.imageUrl ?? '').trim();
    // Bouton de lien. L'écran vide déjà `quickReplies` quand on coche la case, on revide ici quand même : un
    // graphe ancien ou posé par l'API peut porter les deux.
    //
    // Le lien est transporté tel que saisi, même incomplet : c'est le câblage qui refuse, avec la raison
    // (`problemeLienBouton`), au lieu d'envoyer un message nu alors que le client a demandé un bouton.
    const lien: LienBouton | null = node.data.lienActif === true
      ? { texte: String(node.data.lienTexte ?? '').trim(), url: String(node.data.lienUrl ?? '').trim() }
      : null;
    return {
      kind: 'sendQuickMessage',
      body,
      buttons: lien ? [] : buttons,
      ...(mediaUrl ? { mediaUrl } : {}),
      ...(lien ? { lien } : {}),
    };
  }
  if (node.type === 'email') {
    // Lecture défensive : `data` est opaque (parseGraph ne le valide pas). Compte, modèle ou destinataire
    // manquant/invalide -> null.
    const emailAccountId = String(node.data.emailAccountId ?? '').trim();
    const templateId = String(node.data.templateId ?? '').trim();
    const to = emailRecipientsOf(node.data.to);
    if (!emailAccountId || !templateId || !to) return null;
    return { kind: 'sendEmail', emailAccountId, templateId, to };
  }
  return null;
}

/**
 * `walk` : parcourt le graphe depuis `startNodeId`, accumule les actions des blocs synchrones, s'arrête au 1er
 * bloc bloquant ou en fin de chaîne (done). Anti-cycle : un bloc déjà visité arrête le parcours (done). Un
 * `startNodeId` inconnu -> done sans action.
 */
/** Répercute une action synchrone (tag/field, ajout ou retrait) sur la copie de travail du contexte, pour
 *  qu'une condition plus loin dans le même walk la voie (l'écriture en base n'a lieu qu'après, via
 *  executor.apply). Même normalisation de tag que le worker (trim + slice 64, dédup). `clearField` retire la
 *  clé, comme le SQL `fields - key`. */
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
   * L'agent de Meta est-il allumé sur le numéro de ce tenant ? Avec lui, une étape qui n'offre aucun choix
   * cesse de bloquer le parcours : l'agent reprend la parole et les actions du scénario continuent. Sans lui,
   * un template attend la réponse, comme toujours.
   */
  mbaActif?: boolean;
}

export function walk(graph: WorkflowGraph, startNodeId: string, ctx?: EvalContext, opts?: WalkOptions): WalkResult {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const actions: WalkStep[] = [];
  const visited = new Set<string>();
  // Copie de travail mutable du contexte : une action tag/field décidée dans ce walk (appliquée en base
  // seulement après) doit être visible par une condition plus loin dans la même chaîne synchrone.
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
      // Bloc synchrone sans action : évalue la condition (copie de travail) et suit 'true' (« Si réunie ») ou
      // 'false' (« Sinon »). Sans contexte (analyse de graphe pure) -> 'false', déterministe.
      const here: string = current;
      const passed = work ? evaluateConditionGroup(coerceConditionGroup(node.data), work) : false;
      // Sorties typées : si la branche évaluée n'est pas câblée alors qu'une sortie typée existe -> cul-de-sac
      // (done), jamais l'arête de l'autre branche. Repli sur la 1re arête seulement pour un node sans sortie typée.
      const hasTypedEdge = graph.edges.some((e) => e.source === here && (e.sourceHandle === 'true' || e.sourceHandle === 'false'));
      current = nextNodeByHandle(graph, here, passed ? 'true' : 'false') ?? (hasTypedEdge ? null : nextNode(graph, here));
      continue;
    }
    if (node.type === 'rcs_message') {
      // Le walk est pur : il ne sait pas si le numéro est joignable en RCS. Il rend la main à l'executor, qui
      // fera l'IO et reprendra par 'sent' ou 'unreachable'. Les actions accumulées partent maintenant.
      return { actions, rest: { status: 'rcs_send', nodeId: current } };
    }
    if (node.type === 'agent') {
      // Le walk est pur : il rend la main à l'executor, qui ouvrira la session et enfilera un tour. Les actions
      // accumulées partent maintenant. Non configuré = passe-plat : rendre la main à un agent qui n'existe pas
      // figerait le parcours pour toujours, sans signal.
      const agentId = String(node.data.agentId ?? '').trim();
      if (!agentId) {
        // Le passe-plat suit une arête libre, jamais une sortie typée : les sorties d'un bloc agent
        // (`sortie:<code>`, `timeout`) sont des issues précises, et `nextNode` enverrait typiquement tous les
        // contacts sur la branche « échec technique ». Aucune arête libre -> le parcours s'arrête ici.
        current = nextNodeSansHandle(graph, current);
        continue;
      }
      return { actions, rest: { status: 'agent_turn', nodeId: current } };
    }
    if (node.type === 'question') {
      const a = actionOf(node, work);
      if (!a) {
        // Question sans texte : attendre une réponse à une question jamais posée figerait le parcours. Passe-plat,
        // comme un bloc Attente sans durée (alors que `quick_message` non configuré bloque, par historique).
        current = nextNode(graph, current);
        continue;
      }
      actions.push({ nodeId: current, action: a });
      // Il attend toujours, menu ou pas. L'échéance voyage avec le repos : l'executor la traduit en `resume_at`.
      const ms = questionTimeoutMs(node);
      return { actions, rest: { status: 'waiting', nodeId: current, ...(ms > 0 ? { timeoutInMs: ms } : {}) } };
    }
    if (node.type === 'template' || node.type === 'flow' || node.type === 'quick_message') {
      const a = actionOf(node, work);
      if (a) actions.push({ nodeId: current, action: a });
      // Sans MBA : seul un message rapide sans bouton continue. Avec MBA : toute étape qui n'offre pas de choix
      // continue, l'agent de Meta répondant à sa place.
      const continuer = !etapeOffreUnChoix(a) && (opts?.mbaActif === true || a?.kind === 'sendQuickMessage');
      if (continuer) {
        current = nextNode(graph, current);
        continue;
      }
      return { actions, rest: { status: 'waiting', nodeId: current } };
    }
    if (node.type === 'wait') {
      // Bloc Attente : met le parcours en sommeil jusqu'à l'échéance. Les actions accumulées partent maintenant ;
      // le sweeper repart du successeur. `waitResumeInMs`, jamais `waitDurationMs` : c'est ici que les modes datés
      // calculent leur échéance.
      const ms = waitResumeInMs(node, work);
      if (ms > 0) return { actions, rest: { status: 'sleeping', nodeId: current, resumeInMs: ms } };
      current = nextNode(graph, current); // rien à attendre (durée non configurée, échéance passée) -> passe-plat
      continue;
    }
    // tag / field / email : bloc synchrone -> action + on continue, effet répercuté dans la copie de travail
    // (applyToWork ignore email et optIn).
    const a = actionOf(node, work);
    if (a) {
      actions.push({ nodeId: current, action: a });
      if (work) applyToWork(work, a);
    }
    current = nextNode(graph, current);
  }
  return { actions, rest: { status: 'done' } };
}
