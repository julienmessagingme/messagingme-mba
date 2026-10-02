import type { Pool } from 'pg';
import { POSSESSEUR_WIDGET, type AutomationRow } from '../automation/match';
import { runAutomations, type AutomationRunnerDeps } from '../automation/runner';
import { PgTagStore } from '../crm/tag-store.pg';
import type { InboundMessage } from '../webhooks/inbound';
import { tenter } from '../lib/tenter';
import { reconnaissanceDesWidgets, type WidgetDuMessage } from './reconnaissance';
import { PgWidgetStore, type WidgetRow } from './store.pg';
import { PgWidgetTirsStore, type TirsDuWidget } from './tirs.pg';

/**
 * Ce qui se passe quand un visiteur arrive par un widget et écrit sur WhatsApp (lot 3 du plan
 * `docs/superpowers/plans/2026-10-02-widget-whatsapp.md`, décisions de Julien du 2026-10-02). Appelé par
 * `processInbound` (`src/webhooks/inbound.ts`) pour chaque message reçu, après tout ce qui existait avant lui.
 *
 * Deux gestes, et deux seulement :
 *  1. LA SOURCE : une étiquette posée sur le contact, pour TOUS les devenirs, dès que le message contient la phrase
 *     d'un widget actif ;
 *  2. LE DEVENIR, et seul 'scenario' agit au lot 3 :
 *     - 'scenario' : le scénario du widget démarre ICI, par le runner des automations et toutes ses gardes, et il
 *       REPREND le fil à l'agent de Meta, jamais à un opérateur qui le tient (lot 3b) ;
 *     - 'mba' : rien n'est pris, comme `assignerReponse` pour 'mba' : l'agent de Meta répond s'il est actif ;
 *     - 'agent' : EXACTEMENT comme null au lot 3. Une session d'agent IA exige un parcours de scénario
 *       (`agent_sessions.run_id` NOT NULL), le devenir sera grisé « à venir » à l'écran (lot 4) ;
 *     - null : rien, le réglage de l'espace gouverne.
 *
 * 🔴 AUCUN DE CES GESTES N'ÉMET D'ÉVÉNEMENT D'AUTOMATION PAR LUI-MÊME, et c'est décidé par le chemin appelant (règle
 * du dépôt) : le chemin de réception décide ICI, une fois, qui prend la conversation que le widget amène. Émettre
 * « tag ajouté » pour l'étiquette laisserait une automation démarrer un SECOND scénario sur la même arrivée, par la
 * file, après coup et hors de l'anti-rebond du widget : deux règles en concurrence sur un message, ce que la spec
 * exclut (section 3). Le scénario démarré, lui, est un démarrage UNITAIRE comme celui d'une automation : il passe
 * par le `startWorkflow` du runner, donc ses propres blocs « tag » publient comme ceux de tout scénario déclenché
 * par un message. Gardé par `tests/widget-devenir.test.ts`.
 */

/**
 * Le geste complet sur un message. `true` = un scénario est parti : le message est alors CONSOMMÉ, et le job ne le
 * donne ni aux automations, ni à l'avance d'un parcours, ni à l'agent de Meta (`handleWebhookJob`), exactement comme
 * un message qui a démarré une automation. Sans ça, une automation « nouveau contact » démarrerait un second
 * scénario par-dessus, et l'avance prendrait la phrase pour la réponse à la première question du scénario neuf.
 */
export type ArriveeParWidget = (tenantId: string, m: InboundMessage) => Promise<boolean>;

export interface DepsArriveeParWidget {
  widgetDuMessage: WidgetDuMessage;
  /** Pose l'étiquette sur le contact (et la déclare). N'émet rien, voir l'en-tête. */
  poserEtiquette(tenantId: string, waId: string, etiquette: string): Promise<void>;
  /** Démarre le scénario du widget ; rend le nombre de scénarios partis (0 ou 1). */
  demarrerScenario(tenantId: string, widget: WidgetRow, workflowId: string, m: InboundMessage): Promise<number>;
}

export const PREFIXE_ETIQUETTE_WIDGET = 'widget-';

/**
 * L'étiquette de source d'un widget. 🔴 DÉRIVÉE DU CODE, jamais du nom ni de la phrase : le code est IMMUABLE
 * (`widgets_code_key`, aucun `update` ne le réécrit), quand le nom et la phrase se modifient. Un widget renommé
 * continue donc de poser la MÊME étiquette, et aucune colonne n'est nécessaire pour la figer. Pas de doublon : le
 * dépôt des contacts dédoublonne (`array_agg(distinct ...)`) et le référentiel déclare par clé (`tenant_id, name`).
 * Le code est public (il est dans l'adresse du script) : l'étiquette ne révèle rien de plus.
 */
export function etiquetteDuWidget(code: string): string {
  return `${PREFIXE_ETIQUETTE_WIDGET}${code}`;
}

/**
 * La forme EXACTE d'une étiquette de widget, ancrée : le préfixe et un code tel que `newTrackingCode` le tire (12
 * caractères de son alphabet). Le comptage des messages reçus (`PgChannelsMeLinkStore.messagesContenantLaPhrase`)
 * s'en sert pour reconnaître les contacts arrivés par un widget, y compris SUPPRIMÉ. Un simple préfixe prendrait
 * pour une arrivée l'étiquette « widget-salon » qu'un client aurait posée lui-même. Compatible avec les expressions
 * régulières de Postgres comme de JavaScript ; `tests/widget-comptage.test.ts` la confronte au générateur.
 */
export const MOTIF_ETIQUETTE_WIDGET = `^${PREFIXE_ETIQUETTE_WIDGET}[0-9a-hjkmnp-tv-z]{12}$`;

/**
 * L'automation équivalente au widget, construite en mémoire et jamais écrite : mot-clé = sa phrase en `contains`,
 * son scénario, son plafond. C'est ce qui fait passer le démarrage par le MÊME chemin qu'une automation, gardes
 * comprises.
 *
 * - `possedePar: POSSESSEUR_WIDGET` (lot 3b, décision de Julien du 2026-10-02) : comme la publicité, le scénario du
 *   widget REPREND le fil à l'agent de Meta (`reprendLaMain`) et le LAISSE à un opérateur qui le tient
 *   (`epargneLOperateur`) : c'est le visiteur qui déclenche, en cliquant la bulle. Sans la reprise, sur tout espace où
 *   l'agent de Meta tient le fil, le devenir 'scenario' ne démarrerait jamais. La reprise a lieu au démarrage, dans
 *   l'exécuteur, donc APRÈS l'anti-rebond, le plafond et le contact bloqué du runner. Un refus qui la suit (contact
 *   désabonné, numéro délié) laisse le fil à l'app jusqu'au balayage de contrôle, comme pour le bouton de chaîne.
 * - `cooldownSeconds: null` : l'anti-rebond de l'instance (`AUTOMATION_COOLDOWN_SECONDS`), aucun réglage propre.
 * - `maxFiresPerHour` = `max_par_heure` ; `null` = le plafond de l'instance (`AUTOMATION_MAX_FIRES_PER_HOUR`), même
 *   convention des deux côtés. Le CHECK `widgets_max_par_heure_chk` exclut 0, qui voudrait dire « aucun plafond ».
 */
export function automationDuWidget(tenantId: string, widget: WidgetRow, workflowId: string): AutomationRow {
  return {
    id: widget.id,
    tenantId,
    name: `widget « ${widget.nom} »`,
    enabled: true,
    triggerKind: 'keyword',
    triggerConfig: { keywords: [widget.phrase], mode: 'contains' },
    conditionGroup: null,
    workflowId,
    startNodeId: null,
    possedePar: POSSESSEUR_WIDGET,
    cooldownSeconds: null,
    maxFiresPerHour: widget.maxParHeure,
  };
}

/**
 * Le démarrage par le runner. Tout vient de `runner`, les dépendances MÊMES des automations du worker (contact
 * bloqué, `startWorkflow` et sa garde du fil, plafond et anti-rebond de l'instance), sauf la source des
 * automations : la seule du widget, et ses tirs à lui (`widget_tirs`, `automation_fires` refusant un identifiant
 * qui n'est pas une automation).
 */
export function demarrageParLeRunner(
  runner: AutomationRunnerDeps,
  tirsPour: (tenantId: string) => TirsDuWidget,
): DepsArriveeParWidget['demarrerScenario'] {
  return (tenantId, widget, workflowId, m) => runAutomations(
    tenantId,
    // `isNewContact` n'entre pas dans la correspondance d'un mot-clé : faux, plutôt qu'un signal qu'on n'a pas.
    { kind: 'message', waId: m.waId, body: m.body, isNewContact: false, channel: 'whatsapp' },
    {
      ...runner,
      automations: { listEnabled: async () => [automationDuWidget(tenantId, widget, workflowId)], ...tirsPour(tenantId) },
    },
  );
}

export function creerArriveeParWidget(deps: DepsArriveeParWidget): ArriveeParWidget {
  return async (tenantId, m) => {
    // 🔴 Le TEXTE d'un message texte, seulement : `wa.me` pré-remplit un message texte, toujours. Un bouton porte
    // son libellé dans `body` et un média sa légende : ni l'un ni l'autre n'est une arrivée par la bulle (même
    // règle que le STOP, `processInbound`). Sans texte, aucune lecture en base.
    const widget = await deps.widgetDuMessage(tenantId, m.type === 'text' ? m.body : null);
    if (!widget) return false;

    // Chaque geste isolé : une étiquette qui échoue n'empêche pas le scénario, et l'inverse.
    await tenter('widget : étiquette de source non posée:', () => deps.poserEtiquette(tenantId, m.waId, etiquetteDuWidget(widget.code)));

    // 'scenario' sans scénario (supprimé depuis, `on delete set null`) retombe sur le réglage de l'espace, comme
    // 'agent' et null. `devenir = 'agent'` avec un `agent_id` renseigné ou non : la même chose, sans erreur.
    if (widget.devenir !== 'scenario' || widget.workflowId === null) return false;
    // 🔴 Un `standby` (le contact est sur la liste de l'agent de Meta, qui tient le fil) démarre le scénario COMME un
    // `messages` (lot 3b), à l'inverse de `processTriggers` : la reprise que porte l'automation du widget retire le
    // contact de la liste de l'agent AVANT tout envoi, ou annule le démarrage si Meta refuse
    // (`ControleDuFil.reprendrePourLApp`). Le scénario ne répond donc jamais par-dessus l'agent ; la publicité fait
    // de même, en reprenant avant les déclencheurs (`processRoutagePub`). Tout autre `field` ne démarre rien.
    if (m.field && m.field !== 'messages' && m.field !== 'standby') return false;
    const workflowId = widget.workflowId;
    let partis = 0;
    await tenter('widget : scénario non démarré:', async () => {
      partis = await deps.demarrerScenario(tenantId, widget, workflowId, m);
    });
    return partis > 0;
  };
}

/**
 * L'assemblage de production, appelé par le câblage du job `webhook` (`src/worker.ts`). `runner` DOIT être l'objet
 * des automations du worker (`automationRunnerDeps`), pas une copie : c'est lui qui porte le `startWorkflow` des
 * démarrages unitaires et les valeurs de l'instance. `tests/widget-devenir.test.ts` lit le câblage.
 */
export function arriveeParWidget(pool: Pool, d: {
  contacts: { addTagsByPhoneReturningNew(tenantId: string, waId: string, tags: string[]): Promise<unknown> };
  runner: AutomationRunnerDeps;
}): ArriveeParWidget {
  const tags = new PgTagStore(pool);
  const tirs = new PgWidgetTirsStore(pool);
  return creerArriveeParWidget({
    widgetDuMessage: reconnaissanceDesWidgets(new PgWidgetStore(pool)),
    // La pose de `applyTag` (`src/workflow/wiring.ts`), sans sa publication : sur le contact, puis la déclaration
    // dans le référentiel, best-effort.
    poserEtiquette: async (tenantId, waId, etiquette) => {
      await d.contacts.addTagsByPhoneReturningNew(tenantId, waId, [etiquette]);
      try { await tags.create(tenantId, etiquette); } catch { /* déclaration best-effort, comme applyTag */ }
    },
    demarrerScenario: demarrageParLeRunner(d.runner, (tenantId) => tirs.pour(tenantId)),
  });
}
