import type { ConditionGroup } from '../workflow/conditions';

/**
 * Décide si un événement déclenche une automation, plus le garde-fou anti-rebond. Module pur, testable sans
 * base ; l'évaluation du `conditionGroup` et le démarrage restent au runner, qui a l'IO.
 */

/**
 * Types de déclencheur livrés, liste fermée : une valeur inconnue en base ne déclenche jamais rien.
 *
 * - `tag_added` passe par la file `automation-event` (seuls les chemins unitaires émettent, voir
 *   `event-job.ts`).
 * - `conversation_analyzed` est différé par construction : l'analyse tourne à l'inactivité.
 * - `hubspot_deal_stage` se règle par identifiant d'étape, jamais par libellé (un renommage dans HubSpot
 *   casserait l'automation sans bruit).
 * - `webhook` se règle par identifiant ; ces automations sont possédées par leur webhook (écran Tools >
 *   Webhooks) et l'écran Automation ne les liste pas.
 * - `avant_date` répond à l'écoulement du temps : c'est le balayage (`automation/date-sweep`) qui le lève,
 *   échéance déjà tranchée.
 * - `risque_eleve` : passage en risque élevé constaté par le balayage de nuit, au plus 200 par nuit et par
 *   espace (seul chemin de masse qui émet). Aucune config.
 */
export const AUTOMATION_TRIGGER_KINDS = ['keyword', 'new_contact', 'tag_added', 'conversation_analyzed', 'hubspot_deal_stage', 'webhook', 'avant_date', 'ctwa_ad', 'risque_eleve'] as const;
export type AutomationTriggerKind = (typeof AUTOMATION_TRIGGER_KINDS)[number];
export function isAutomationTriggerKind(v: unknown): v is AutomationTriggerKind {
  return typeof v === 'string' && (AUTOMATION_TRIGGER_KINDS as readonly string[]).includes(v);
}

/** Comment un mot-clé est comparé au message reçu. `equals` sert aussi aux jetons opaques (lien de test wa.me). */
export type KeywordMode = 'contains' | 'equals';

/**
 * Le propriétaire d'une automation née d'un lien de chaîne WhatsApp (`automations.possede_par`). La même
 * chaîne vit en dur dans les requêtes SQL de `src/channels-me/link-store.pg.ts` (garde miroir : ce store ne
 * touche que ses automations) ; `tests/automation-chaine-reprend-la-main.test.ts` les tient alignées.
 */
export const POSSESSEUR_LIEN_CHAINE = 'channelsme_link';

/**
 * Le propriétaire d'une automation née d'une publicité Click-to-WhatsApp, écrit par
 * `PgPublicitesStore.creerAutomation` et tenu aligné avec le SQL par le même test. Si les deux divergeaient,
 * l'automation deviendrait intouchable par son propriétaire et invisible de l'écran Automation, et
 * continuerait de déclencher sans que personne puisse l'éteindre.
 */
export const POSSESSEUR_PUBLICITE = 'publicite';

/**
 * Cette automation vient-elle d'un bouton de chaîne ? Un abonné qui clique le bouton d'une publication fait
 * un geste explicite vers ce scénario, comme l'opérateur qui lance une campagne : il reprend la main.
 * Seulement la chaîne : une automation ordinaire par mot-clé écraserait l'opérateur en train de répondre.
 */
export function vientDuneChaine(a: AutomationRow): boolean {
  return a.possedePar === POSSESSEUR_LIEN_CHAINE;
}

/**
 * Ce démarrage reprend-il la conduite du fil, même tenu par un opérateur ou par l'agent de Meta ? Deux
 * propriétaires nommés (bouton de chaîne, publicité), pas « un propriétaire quelconque » : un futur
 * propriétaire hériterait sinon d'un pouvoir que personne ne lui a accordé. Le lead d'une pub arrive souvent
 * sur un fil que l'agent de Meta tient : sans reprise, le scénario ne démarrerait jamais sur un clic payé.
 * Une automation ordinaire vaut toujours `false`.
 */
export function reprendLaMain(a: AutomationRow): boolean {
  return vientDuneChaine(a) || a.possedePar === POSSESSEUR_PUBLICITE;
}

/**
 * Cette reprise laisse-t-elle la main à un opérateur qui la tient ? Oui pour la publicité : c'est le client qui
 * déclenche (un clic payé), et un opérateur en train de lui répondre garde la conversation, son message arrivant
 * dans l'Inbox. Non pour le bouton de chaîne, lancement explicite au même titre qu'une campagne.
 */
export function epargneLOperateur(a: AutomationRow): boolean {
  return a.possedePar === POSSESSEUR_PUBLICITE;
}

export interface AutomationRow {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  triggerKind: AutomationTriggerKind;
  /** Config brute, dépend du type de déclencheur (opaque : toujours coercée, jamais castée). */
  triggerConfig: Record<string, unknown>;
  conditionGroup: ConditionGroup | null;
  workflowId: string;
  startNodeId: string | null;
  /**
   * Propriétaire de cette automation ; `null` = automation ordinaire. Requis (comme `maxFiresPerHour`) pour que
   * le compilateur énumère tout ce qui fabrique une ligne : un câblage muet retomberait sur `undefined`, et un
   * lien de chaîne cesserait de reprendre la main sans bruit.
   */
  possedePar: string | null;
  /** null = défaut serveur. 0 = aucun anti-rebond. */
  cooldownSeconds: number | null;
  /**
   * Plafond horaire de déclenchements propre à cette automation ; null = plafond global
   * (`AUTOMATION_MAX_FIRES_PER_HOUR`), 0 = aucun plafond. Requis pour la même raison que `possedePar`.
   */
  maxFiresPerHour: number | null;
}

/** L'événement observé, forme normalisée par l'appelant (webhook, file d'événements, hook d'analyse). */
export type AutomationEvent =
  /** `channel` : le tuyau du message reçu ; un message RCS ne prouve pas la fenêtre de service WhatsApp.
   *  `adId` : la publicité d'origine, que Meta ne transmet que sur le premier message après le clic.
   *  `campagneId` : la campagne de cette publicité, résolue par le routage (Meta ne la transmet pas) ; absente
   *  = campagne inconnue. */
  | { kind: 'message'; waId: string; body: string | null; isNewContact: boolean; channel: 'whatsapp' | 'rcs'; adId?: string; campagneId?: string }
  | { kind: 'tag_added'; waId: string; tag: string }
  /** Une conversation vient d'être analysée : `sentiment` catégoriel (pas de score numérique) + `resolved`. */
  | { kind: 'analysis'; waId: string; sentiment: string; resolved: boolean }
  /**
   * Un deal HubSpot a changé d'étape (identifiants internes, stables au renommage). Le contact est déjà résolu
   * en `waId` par le connecteur.
   */
  | { kind: 'hubspot_deal_stage'; waId: string; pipelineId: string; stageId: string }
  /** Un webhook entrant a reçu un appel exploitable ; le contact est déjà résolu en `waId` par la route. */
  | { kind: 'webhook'; waId: string; webhookId: string }
  /**
   * L'échéance d'une date de champ est arrivée. `valeur` est la date telle qu'elle est stockée : le marqueur
   * d'occurrence, pour qu'un rendez-vous reporté redonne un rappel.
   */
  | { kind: 'avant_date'; waId: string; automationId: string; valeur: string }
  /** Le contact vient de passer en risque de désengagement élevé (balayage de nuit). */
  | { kind: 'risque_eleve'; waId: string };

/** Minuscules, sans accents, espaces resserrés : même esprit que la recherche de blocs (web/lib/node-search). */
export function normalizeText(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Mots-clés déclarés dans la config, nettoyés (vides retirés). Jamais de throw sur une config malformée. */
export function keywordsOf(config: Record<string, unknown>): string[] {
  const raw = Array.isArray(config.keywords) ? config.keywords : [];
  return raw.map((k) => normalizeText(String(k ?? ''))).filter((k) => k !== '');
}

/** Mode de comparaison déclaré ; toute valeur inattendue retombe sur `contains` (le plus permissif, attendu par défaut). */
export function keywordModeOf(config: Record<string, unknown>): KeywordMode {
  return config.mode === 'equals' ? 'equals' : 'contains';
}

/**
 * L'événement correspond-il au déclencheur de cette automation ? Ni `enabled`, ni l'anti-rebond, ni le
 * `conditionGroup` : le runner compose ces filtres. Une automation mal configurée (mot-clé ou tag vide) ne
 * déclenche jamais : mieux vaut inerte que partie sur tous les messages.
 */
export function matchesTrigger(a: AutomationRow, ev: AutomationEvent): boolean {
  if (a.triggerKind === 'keyword') {
    if (ev.kind !== 'message') return false;
    const words = keywordsOf(a.triggerConfig);
    if (words.length === 0) return false;
    const body = normalizeText(ev.body ?? '');
    if (body === '') return false;
    return keywordModeOf(a.triggerConfig) === 'equals'
      ? words.includes(body)
      : words.some((w) => body.includes(w));
  }
  if (a.triggerKind === 'new_contact') {
    return ev.kind === 'message' && ev.isNewContact;
  }
  if (a.triggerKind === 'ctwa_ad') {
    // Le message doit venir d'une pub : un message ordinaire ne déclenche rien, même si l'automation n'a pas de
    // pub précise en tête.
    if (ev.kind !== 'message') return false;
    const venuDeLaPub = (ev.adId ?? '').trim();
    if (venuDeLaPub === '') return false;
    /**
     * La campagne passe avant la pub : une automation de publicité porte `campaignId` et vaut pour la campagne
     * entière, donc pour les copies faites dans le Gestionnaire, qui ont chacune un identifiant de pub neuf. Une
     * campagne demandée mais inconnue de ce message ne correspond pas, sans repli sur `adId`.
     */
    const campagneVoulue = String(a.triggerConfig.campaignId ?? '').trim();
    if (campagneVoulue !== '') return campagneVoulue === (ev.campagneId ?? '').trim();
    // Ici une config vide veut dire « n'importe quelle pub » (le scénario d'accueil de tout lead publicitaire),
    // contrairement au tag ou à l'étape vides. La portée reste bornée aux messages issus d'une pub. Quand une pub
    // confie ses leads à un scénario précis, c'est la restriction posée par le routage (`src/pubs/routage.ts`)
    // qui écarte cette automation.
    const voulue = String(a.triggerConfig.adId ?? '').trim();
    return voulue === '' || voulue === venuDeLaPub;
  }
  if (a.triggerKind === 'tag_added') {
    if (ev.kind !== 'tag_added') return false;
    const wanted = normalizeText(String(a.triggerConfig.tag ?? ''));
    return wanted !== '' && normalizeText(ev.tag) === wanted;
  }
  if (a.triggerKind === 'hubspot_deal_stage') {
    if (ev.kind !== 'hubspot_deal_stage') return false;
    // Identifiants bruts, égalité stricte. Étape non configurée : n'attrape rien.
    const stage = String(a.triggerConfig.stageId ?? '').trim();
    if (stage === '' || stage !== ev.stageId) return false;
    // Le pipeline ne restreint que si les deux côtés le portent : le webhook HubSpot ne le porte pas, et un
    // identifiant d'étape n'appartient de toute façon qu'à un pipeline.
    const pipeline = String(a.triggerConfig.pipelineId ?? '').trim();
    return pipeline === '' || ev.pipelineId === '' || pipeline === ev.pipelineId;
  }
  if (a.triggerKind === 'webhook') {
    if (ev.kind !== 'webhook') return false;
    // Égalité stricte sur l'identifiant. Webhook non configuré : n'attrape rien, plutôt que partir sur tous les
    // webhooks de l'espace.
    const attendu = String(a.triggerConfig.webhookId ?? '').trim();
    return attendu !== '' && attendu === ev.webhookId;
  }
  if (a.triggerKind === 'avant_date') {
    if (ev.kind !== 'avant_date') return false;
    // L'échéance a été tranchée par le balayage (fuseau, tirs précédents) : la recalculer la ferait diverger,
    // l'événement désigne donc son automation.
    return a.id === ev.automationId;
  }
  if (a.triggerKind === 'risque_eleve') {
    // Aucune config : c'est le balayage qui a constaté le passage, et il ne l'émet qu'une fois par passage.
    return ev.kind === 'risque_eleve';
  }
  if (a.triggerKind === 'conversation_analyzed') {
    if (ev.kind !== 'analysis') return false;
    // Deux filtres cumulatifs, facultatifs : `sentiment` et `unresolvedOnly`. Aucun des deux : déclenche à
    // chaque analyse, par choix de l'utilisateur.
    const wantSentiment = String(a.triggerConfig.sentiment ?? '').trim();
    if (wantSentiment !== '' && ev.sentiment !== wantSentiment) return false;
    if (a.triggerConfig.unresolvedOnly === true && ev.resolved) return false;
    return true;
  }
  return false;
}

/**
 * Anti-rebond : ce contact a-t-il déjà déclenché cette automation trop récemment ? Sans lui, un scénario qui
 * pose son propre tag déclencheur boucle. 0 désactive explicitement ; `null` retombe sur le défaut du serveur.
 */
export function isInCooldown(
  lastFiredAt: Date | null,
  cooldownSeconds: number | null,
  defaultCooldownSeconds: number,
  now: number,
): boolean {
  if (lastFiredAt === null) return false;
  const seconds = cooldownSeconds ?? defaultCooldownSeconds;
  if (seconds <= 0) return false;
  return now - lastFiredAt.getTime() < seconds * 1000;
}

/**
 * 30 jours par contact : l'anti-rebond par défaut du déclencheur « risque élevé ». La grille du risque n'a
 * pas d'hystérésis : un contact qui oscille autour d'un seuil repasserait en élevé à chaque remontée, et
 * chaque passage coûterait un template facturé.
 *
 * Un défaut, pas un plancher : il remplace le défaut de l'instance quand l'automation n'a rien réglé ; un
 * anti-rebond posé explicitement par l'API l'emporte. Appliqué au déclenchement, il vaut aussi pour les
 * automations déjà créées.
 */
export const ANTI_REBOND_RISQUE_ELEVE_SECONDES = 30 * 24 * 3600;

/** L'anti-rebond qu'une automation sans réglage propre reçoit, selon son déclencheur. */
export function antiRebondParDefaut(kind: AutomationTriggerKind, defautInstanceSecondes: number): number {
  return kind === 'risque_eleve' ? ANTI_REBOND_RISQUE_ELEVE_SECONDES : defautInstanceSecondes;
}
