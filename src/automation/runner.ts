import { evaluateConditionGroup } from '../workflow/conditions';
import type { EvalContext } from '../workflow/conditions';
import { matchesTrigger, isInCooldown } from './match';
import type { AutomationRow, AutomationEvent, AutomationTriggerKind } from './match';

/**
 * Déclenche les scénarios abonnés à un événement. IO INJECTÉE (aucun import pg) -> testable sans base, comme
 * `WorkflowExecutor`. Le matching pur vit dans `./match`, l'évaluation des conditions dans `workflow/conditions`.
 *
 * Trois filtres composés, dans cet ordre (du moins cher au plus cher) :
 *   1. le déclencheur correspond à l'événement (pur, aucune requête) ;
 *   2. le contact n'est pas en anti-rebond pour cette automation (1 requête par automation candidate) ;
 *   3. le `conditionGroup` éventuel est satisfait (contexte contact construit UNE fois, et seulement si besoin).
 */
export interface AutomationRunnerDeps {
  /** Automations ACTIVES du tenant pour ces types de déclencheur (index partiel `enabled`). */
  listEnabled(tenantId: string, kinds: readonly AutomationTriggerKind[]): Promise<AutomationRow[]>;
  /** Dernier déclenchement de cette automation pour ce contact. null = jamais déclenché. */
  lastFiredAt(automationId: string, waId: string): Promise<Date | null>;
  /** Enregistre le déclenchement (upsert). Appelé AVANT le démarrage : voir la note anti-boucle plus bas. */
  markFired(automationId: string, waId: string): Promise<void>;
  /**
   * Annule le déclenchement enregistré. Appelé quand le scénario n'a PAS démarré (`false`) : dans ce cas rien
   * n'a été envoyé (les gardes de l'exécuteur agissent AVANT tout envoi), donc consommer l'anti-rebond
   * avalerait la prochaine vraie demande du client pendant toute la durée du délai.
   */
  clearFired(automationId: string, waId: string): Promise<void>;
  /**
   * Un run de scénario est-il DÉJÀ en attente pour ce contact ? Un seul parcours actif à la fois par contact :
   * en démarrer un second enverrait deux messages pour un seul message reçu, et laisserait le premier orphelin
   * (l'avance ne retrouve qu'un run à la fois).
   */
  hasWaitingRun(tenantId: string, waId: string): Promise<boolean>;
  /**
   * État du contact pour évaluer un `conditionGroup`. null = contact introuvable -> les automations qui ont
   * une condition sont ALORS ignorées (on ne déclenche pas « au cas où » sur un filtre qu'on n'a pas pu vérifier).
   * Non appelé du tout si aucune automation candidate n'a de condition.
   */
  evalContext(tenantId: string, waId: string): Promise<EvalContext | null>;
  /**
   * Démarre le scénario. Renvoie false s'il n'a pas démarré (fil détenu, bloc absent, scénario supprimé).
   *
   * `windowOpen` = la fenêtre de service 24 h est PROUVÉE ouverte (le contact vient d'écrire). Le scénario peut
   * alors ouvrir par un message rapide / formulaire ; sinon la garde de l'exécuteur s'applique.
   */
  /** true = parti. `false` OU une chaîne (la raison du refus) = pas parti : l'automation ne consomme
   *  que le fait, pas la raison. */
  startWorkflow(tenantId: string, workflowId: string, waId: string, startNodeId: string | null, windowOpen: boolean): Promise<boolean | string>;
  /** Anti-rebond appliqué aux automations qui n'ont rien réglé (`cooldownSeconds` null). */
  defaultCooldownSeconds: number;
  /**
   * Nombre de déclenchements de cette automation depuis `since`. Sert le PLAFOND horaire ci-dessous.
   * Absent -> aucun plafond (rétro-compatible pour les suites de tests à deps minimales).
   */
  firedSince?(automationId: string, since: Date): Promise<number>;
  /**
   * Plafond de déclenchements par automation et par heure. L'anti-rebond est par (automation, CONTACT) : il
   * n'empêche donc rien à l'échelle d'une population. Or un seul acte d'exploitation peut produire des milliers
   * d'événements d'un coup (une campagne directe rouvre l'analyse de tous ses destinataires, qui repartent
   * ensuite en « conversation analysée »). Ce plafond est la seule chose qui borne la facture dans ce cas.
   */
  maxFiresPerHour?: number;
  now?: () => number;
}

/** Les types de déclencheur qu'un événement donné peut activer (évite de charger des automations hors sujet). */
function kindsFor(ev: AutomationEvent): AutomationTriggerKind[] {
  if (ev.kind === 'message') return ['keyword', 'new_contact'];
  if (ev.kind === 'tag_added') return ['tag_added'];
  return ['conversation_analyzed'];
}

/**
 * Évalue les automations d'un tenant contre un événement et démarre celles qui passent les trois filtres.
 * Renvoie le nombre de scénarios réellement démarrés.
 *
 * Isolation PAR AUTOMATION : une automation qui échoue (scénario supprimé, base indisponible) ne doit pas
 * empêcher les autres de se déclencher, ni faire échouer l'appelant (le job webhook est partagé).
 */
export async function runAutomations(tenantId: string, ev: AutomationEvent, deps: AutomationRunnerDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const candidates = (await deps.listEnabled(tenantId, kindsFor(ev))).filter((a) => a.enabled && matchesTrigger(a, ev));
  if (candidates.length === 0) return 0;

  // Contexte contact construit UNE seule fois, et SEULEMENT si au moins une candidate porte une condition
  // (même principe que `buildCtx` dans l'executor : pas de requête pour un graphe qui n'en a pas besoin).
  let ctx: EvalContext | null = null;
  let ctxLoaded = false;

  // La fenêtre de service 24 h est PROUVÉE ouverte quand l'événement est un message entrant : le contact vient
  // d'écrire. Le scénario déclenché peut donc légitimement ouvrir par un message rapide ou un formulaire (usage
  // ouvert par le Lot D). Un événement qui ne prouve pas la fenêtre (tag posé depuis le CRM) garde la protection.
  const windowOpen = ev.kind === 'message';

  let started = 0;
  for (const a of candidates) {
    try {
      const last = await deps.lastFiredAt(a.id, ev.waId);
      if (isInCooldown(last, a.cooldownSeconds, deps.defaultCooldownSeconds, now())) continue;

      if (a.conditionGroup) {
        if (!ctxLoaded) { ctx = await deps.evalContext(tenantId, ev.waId); ctxLoaded = true; }
        // Contact introuvable : on ne peut pas vérifier le filtre, donc on ne déclenche pas.
        if (!ctx || !evaluateConditionGroup(a.conditionGroup, ctx)) continue;
      }

      // Plafond par automation : borne le fan-out d'un événement de masse (analyse rouverte pour toute une
      // campagne, par exemple). Vérifié APRÈS l'anti-rebond (moins cher) et AVANT tout démarrage.
      if (deps.firedSince && deps.maxFiresPerHour !== undefined && deps.maxFiresPerHour > 0) {
        const depuis = new Date(now() - 3600_000);
        if ((await deps.firedSince(a.id, depuis)) >= deps.maxFiresPerHour) {
          // eslint-disable-next-line no-console
          console.error(`automation ${a.id} (${a.name}) : plafond de ${deps.maxFiresPerHour} déclenchements/heure atteint, déclenchement ignoré`);
          continue;
        }
      }

      // Un seul parcours actif par contact. Sans cette garde, un contact qui répond à un scénario en cours ET
      // dont le message contient le mot-clé recevrait DEUX messages, et le premier run resterait orphelin
      // (`findWaitingByWaId` n'en retrouve qu'un). On ne marque pas le tir : ce n'est pas un déclenchement.
      //
      // ⚠️ Un run `waiting` n'expire pas tout seul : `hasWaitingRun` doit donc porter une FENÊTRE d'âge côté
      // câblage, sinon un contact qui ne répond jamais resterait bloqué pour toujours. Le saut est journalisé :
      // un déclencheur muet sans trace est indébogable.
      if (await deps.hasWaitingRun(tenantId, ev.waId)) {
        // eslint-disable-next-line no-console
        console.log(`automation ${a.id} : un parcours est déjà en attente pour ${ev.waId}, déclenchement ignoré`);
        continue;
      }

      // Anti-boucle : on marque AVANT de démarrer, pour qu'un scénario qui repose lui-même le déclencheur ne
      // reboucle pas même si le démarrage lève une exception à mi-chemin (un envoi a pu partir).
      await deps.markFired(a.id, ev.waId);
      const issue = await deps.startWorkflow(tenantId, a.workflowId, ev.waId, a.startNodeId, windowOpen);
      // `false` OU une chaîne (la raison du refus) = PAS parti. Tester la simple vérité JS comptait une
      // chaîne comme un succès : le tir restait marqué et l'anti-rebond avalait en silence la prochaine
      // vraie demande du client. Tout le reste (`true`, câblage muet) = parti, comme le moteur de campagne.
      const parti = issue !== false && typeof issue !== 'string';
      if (parti) {
        started += 1;
      } else {
        // Les gardes de l'exécuteur ont refusé AVANT tout envoi (fil tenu par un humain/MBA, bloc absent,
        // scénario supprimé) : rien n'est parti, donc rien à protéger. Garder le tir ferait taire la
        // prochaine vraie demande du client pendant toute la durée de l'anti-rebond.
        if (typeof issue === 'string') {
          // Une automation n'a aucun écran où afficher la raison : le log est le seul endroit où elle vit.
          // eslint-disable-next-line no-console
          console.log(`automation ${a.id} : scénario non démarré pour ${ev.waId} : ${issue}`);
        }
        await deps.clearFired(a.id, ev.waId);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`automation ${a.id} ignorée:`, err instanceof Error ? err.message : err);
    }
  }
  return started;
}
