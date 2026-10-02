import { evaluateConditionGroup } from '../workflow/conditions';
import type { EvalContext } from '../workflow/conditions';
import { matchesTrigger, isInCooldown, reprendLaMain, epargneLOperateur, antiRebondParDefaut } from './match';
import type { AutomationRow, AutomationEvent, AutomationTriggerKind } from './match';
import { NumeroDelieError } from '../meta/numero-delie';
import { messageDe } from '../lib/erreur';

/**
 * Déclenche les scénarios abonnés à un événement. IO injectée, testable sans base ; le matching pur vit dans
 * `./match`, l'évaluation des conditions dans `workflow/conditions`.
 *
 * Trois filtres, du moins cher au plus cher : le déclencheur correspond (pur), le contact n'est pas en
 * anti-rebond (une requête par candidate), le `conditionGroup` est satisfait (contexte construit une fois, et
 * seulement si besoin).
 */
export interface AutomationRunnerDeps {
  /**
   * Ce contact est-il bloqué ? Un contact bloqué ne déclenche plus aucune automation : son message est
   * enregistré et lisible, mais rien ne part vers lui. Absente : aucun contact n'est bloqué.
   */
  contacts?: { isBlockedByWaId(tenantId: string, waId: string): Promise<boolean> };
  /** Les automations de l'espace et leurs déclenchements. */
  automations: {
    /** Automations actives du tenant pour ces types de déclencheur (index partiel `enabled`). */
    listEnabled(tenantId: string, kinds: readonly AutomationTriggerKind[]): Promise<AutomationRow[]>;
    /** Dernier déclenchement de cette automation pour ce contact. null = jamais déclenché. */
    lastFiredAt(automationId: string, waId: string): Promise<Date | null>;
    /**
     * Enregistre le déclenchement (upsert), avant le démarrage. `marqueur` retient pour quelle occurrence on a
     * tiré (seul `avant_date`) : avec lui c'est un claim, `false` si un autre tour a déjà tiré pour cette
     * occurrence. Sans marqueur, l'écriture est inconditionnelle et rend toujours `true`.
     */
    markFired(automationId: string, waId: string, marqueur?: string): Promise<boolean>;
    /**
     * Annule le déclenchement enregistré quand le scénario n'a pas démarré (`false` ou une raison) : les gardes de
     * l'exécuteur agissent avant tout envoi, et consommer l'anti-rebond avalerait la prochaine vraie demande du
     * client. Aussi sur un `NumeroDelieError`, sauf pour `avant_date` (voir le `catch` de `runAutomations`).
     */
    clearFired(automationId: string, waId: string): Promise<void>;
    /** Déclenchements de cette automation depuis `since`, pour le plafond horaire. Absent : aucun plafond. */
    firedSince?(automationId: string, since: Date): Promise<number>;
  };
  /**
   * État du contact pour évaluer un `conditionGroup`. null = contact introuvable : les automations à condition
   * sont ignorées (on ne déclenche pas sur un filtre non vérifié). Non appelé si aucune candidate n'a de
   * condition.
   */
  evalContext(tenantId: string, waId: string): Promise<EvalContext | null>;
  /**
   * Démarre le scénario. `true` = parti ; `false` ou une chaîne (la raison du refus) = pas parti (fil détenu,
   * bloc absent, scénario supprimé).
   *
   * Les options voyagent dans un objet : une flèche à cinq paramètres reste assignable à un contrat qui en
   * déclare six, et le sixième serait avalé en silence par un câblage écrit pour l'ancienne signature.
   */
  startWorkflow(tenantId: string, workflowId: string, waId: string, opts: {
    startNodeId: string | null;
    /** La fenêtre de service 24 h est prouvée ouverte (le contact vient d'écrire). */
    windowOpen: boolean;
    /**
     * Ce démarrage reprend la conduite du fil, même tenu par un opérateur ou par l'agent de Meta. Réservé aux
     * automations possédées nées d'un geste explicite du contact (`reprendLaMain` : bouton de chaîne, clic sur
     * une publicité, arrivée par un widget) ; une automation ordinaire reste bloquée par un fil tenu.
     */
    reprendLaMain: boolean;
    /**
     * La reprise laisse la main à un opérateur qui la tient (`epargneLOperateur` : la publicité, le widget). Présent
     * seulement quand c'est vrai : une automation ordinaire ou de chaîne ne le porte pas.
     */
    saufOperateur?: true;
  }): Promise<boolean | string>;
  /** Anti-rebond appliqué aux automations qui n'ont rien réglé (`cooldownSeconds` null). */
  defaultCooldownSeconds: number;
  /**
   * Plafond de déclenchements par automation et par heure, par défaut pour l'instance. L'anti-rebond est par
   * contact et ne borne rien à l'échelle d'une population : ce plafond est la seule chose qui borne la facture
   * d'un événement de masse. Le `maxFiresPerHour` propre d'une automation l'emporte, plus strict comme plus
   * large.
   */
  maxFiresPerHour?: number;
  now?: () => number;
}

/**
 * Ce qui restreint un tour d'évaluation, quand l'appelant en sait plus que le déclencheur : le routage d'un
 * lead publicitaire exige que seule l'automation de la publicité soit évaluée (une automation `ctwa_ad` sans
 * pub précise veut dire « n'importe quelle pub »). Aucun filtre n'est dispensé : l'automation nommée passe
 * quand même l'anti-rebond, sa condition et son plafond.
 */
export interface OptionsRun {
  /** `null` = aucune restriction. */
  seuleAutomation: string | null;
}

const SANS_RESTRICTION: OptionsRun = { seuleAutomation: null };

/** Les types de déclencheur qu'un événement donné peut activer (évite de charger des automations hors sujet). */
function kindsFor(ev: AutomationEvent): AutomationTriggerKind[] {
  if (ev.kind === 'message') return ['keyword', 'new_contact', 'ctwa_ad'];
  if (ev.kind === 'tag_added') return ['tag_added'];
  if (ev.kind === 'hubspot_deal_stage') return ['hubspot_deal_stage'];
  if (ev.kind === 'webhook') return ['webhook'];
  if (ev.kind === 'avant_date') return ['avant_date'];
  if (ev.kind === 'risque_eleve') return ['risque_eleve'];
  // Une analyse sert deux déclencheurs : « conversation analysée » (chaque analyse) et « un champ devient »
  // (seulement quand la copie sur la fiche change). Branche explicite : un genre ajouté demain ne compile pas
  // tant qu'il n'a pas la sienne.
  if (ev.kind === 'analysis') return ['conversation_analyzed', 'analyse_devient'];
  const _jamais: never = ev;
  return [];
}

/**
 * Évalue les automations d'un tenant contre un événement et démarre celles qui passent les trois filtres ;
 * renvoie le nombre de scénarios démarrés. Isolation par automation : une automation qui échoue ne doit ni
 * empêcher les autres, ni faire échouer l'appelant (le job webhook est partagé).
 */
export async function runAutomations(
  tenantId: string,
  ev: AutomationEvent,
  deps: AutomationRunnerDeps,
  opts: OptionsRun = SANS_RESTRICTION,
): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  // 🔴 Contact bloqué : son message reste enregistré, mais il ne déclenche plus rien. C'est le seul point
  // d'entrée des automations, donc la seule garde nécessaire côté scénarios.
  if (deps.contacts && (await deps.contacts.isBlockedByWaId(tenantId, ev.waId))) return 0;
  // La restriction s'applique avant la mise en correspondance : « seule celle-là » ne doit pas dépendre de la
  // configuration des automations écartées.
  const candidates = (await deps.automations.listEnabled(tenantId, kindsFor(ev)))
    .filter((a) => opts.seuleAutomation === null || a.id === opts.seuleAutomation)
    .filter((a) => a.enabled && matchesTrigger(a, ev));
  if (candidates.length === 0) return 0;

  // Contexte contact construit une seule fois, et seulement si une candidate porte une condition.
  let ctx: EvalContext | null = null;
  let ctxLoaded = false;

  // La fenêtre de service 24 h n'est prouvée ouverte que par un message entrant WhatsApp : le scénario peut
  // alors ouvrir par un message rapide ou un formulaire. Un message RCS ne passe pas par Meta et n'ouvre aucune
  // fenêtre : sans le test du canal, le message rapide partirait en 131047.
  const windowOpen = ev.kind === 'message' && ev.channel === 'whatsapp';

  let started = 0;
  for (const a of candidates) {
    try {
      // Pas d'anti-rebond pour `avant_date` : l'unicité y est tenue par le marqueur d'occurrence, et l'anti-rebond
      // empêcherait un rendez-vous reporté à l'intérieur du délai de redonner son rappel.
      if (ev.kind !== 'avant_date') {
        const last = await deps.automations.lastFiredAt(a.id, ev.waId);
        // Le défaut dépend du déclencheur : 30 jours pour « risque élevé » (`antiRebondParDefaut`).
        if (isInCooldown(last, a.cooldownSeconds, antiRebondParDefaut(a.triggerKind, deps.defaultCooldownSeconds), now())) continue;
      }

      if (a.conditionGroup) {
        if (!ctxLoaded) { ctx = await deps.evalContext(tenantId, ev.waId); ctxLoaded = true; }
        // Contact introuvable : on ne peut pas vérifier le filtre, donc on ne déclenche pas.
        if (!ctx || !evaluateConditionGroup(a.conditionGroup, ctx)) continue;
      }

      // 🔴 Plafond par automation, vérifié après l'anti-rebond (moins cher) et avant tout démarrage : il borne le
      // fan-out facturé d'un événement de masse. Celui de l'automation l'emporte sur celui de l'instance (un lien
      // de chaîne doit accueillir des milliers d'abonnés sans desserrer la garde des autres) ; `null` = celui de
      // l'instance, `0` = aucun plafond, choix explicite.
      const plafond = a.maxFiresPerHour ?? deps.maxFiresPerHour;
      if (deps.automations.firedSince && plafond !== undefined && plafond > 0) {
        const depuis = new Date(now() - 3600_000);
        if ((await deps.automations.firedSince(a.id, depuis)) >= plafond) {
          // Le message porte le plafond réellement appliqué, pour qu'on cherche le réglage au bon endroit.
          // eslint-disable-next-line no-console
          console.error(`automation ${a.id} (${a.name}) : plafond de ${plafond} déclenchements/heure atteint, déclenchement ignoré`);
          continue;
        }
      }

      // Pas de garde « un parcours attend déjà » : `runFrom` clôt le parcours actif avant de persister le nouveau,
      // donc un nouveau déclenchement tranche au lieu de bloquer. Ce qui freine un scénario qui repose son propre
      // déclencheur, c'est l'anti-rebond, et seulement s'il est non nul : une automation réglée à 0, sans plafond,
      // sur un scénario qui repose son propre tag, boucle.

      // On marque avant de démarrer, pour que l'anti-rebond ait quelque chose à lire même si le démarrage lève à
      // mi-chemin (un envoi a pu partir). Sans marqueur, `markFired` enregistre et ne refuse jamais.
      // 🔴 Pour `avant_date`, c'est un claim : si la file prend du retard, le balayage republie la même échéance,
      // et sans lui deux rappels facturés partiraient. Quand le scénario ne démarre pas, `clearFired` efface le
      // marqueur, et la tentative suivante regagne le claim.
      if (!(await deps.automations.markFired(a.id, ev.waId, ev.kind === 'avant_date' ? ev.valeur : undefined))) {
        // eslint-disable-next-line no-console
        console.log(`automation ${a.id} : rappel déjà tiré pour cette échéance chez ${ev.waId}, ignoré`);
        continue;
      }
      const issue = await deps.startWorkflow(tenantId, a.workflowId, ev.waId, {
        startNodeId: a.startNodeId,
        windowOpen,
        // Seuls la chaîne, la publicité et le widget reprennent la main : l'agent de Meta tenant souvent le fil, un
        // clic ne lancerait sinon rien, en silence.
        reprendLaMain: reprendLaMain(a),
        // Le clic sur une publicité ou sur un widget ne prend pas la main à un opérateur qui la tient.
        ...(epargneLOperateur(a) ? { saufOperateur: true as const } : {}),
      });
      // `false` ou une chaîne = pas parti ; tester la simple vérité JS compterait une chaîne comme un succès, et
      // l'anti-rebond avalerait la prochaine vraie demande. Tout le reste = parti, comme le moteur de campagne.
      const parti = issue !== false && typeof issue !== 'string';
      if (parti) {
        started += 1;
      } else {
        // Les gardes de l'exécuteur ont refusé avant tout envoi : rien n'est parti, garder le tir ferait taire la
        // prochaine vraie demande du client pendant tout l'anti-rebond.
        if (typeof issue === 'string') {
          // Une automation n'a aucun écran pour la raison du refus : ce journal est le seul endroit où elle vit.
          // eslint-disable-next-line no-console
          console.log(`automation ${a.id} : scénario non démarré pour ${ev.waId} : ${issue}`);
        }
        await deps.automations.clearFired(a.id, ev.waId);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`automation ${a.id} ignorée:`, messageDe(err));
      /**
       * Le numéro délié efface le tir, contrairement aux autres exceptions (où l'on ne sait pas si un message est
       * parti) : `runFrom` vérifie le numéro avant tout effet du parcours dès qu'il enverra par WhatsApp. Reste
       * étroit : la garde est en cache 5 s, un « délier » tombé entre la vérification et un envoi plus loin laisse
       * partir ce qui précède.
       *
       * Sauf `avant_date`, qui garde son tir : son balayage republierait chaque minute un rappel dont le marqueur a
       * disparu. Tenu par `tests/automation-runner.test.ts` et `tests/numero-delie-parcours.test.ts`.
       */
      if (err instanceof NumeroDelieError && ev.kind !== 'avant_date') await deps.automations.clearFired(a.id, ev.waId).catch(() => {});
    }
  }
  return started;
}
