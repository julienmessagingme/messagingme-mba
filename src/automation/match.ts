import type { ConditionGroup } from '../workflow/conditions';

/**
 * Décide si un ÉVÉNEMENT déclenche une automation. Module PUR (aucune IO, aucun import qui tire pg) ->
 * testable en unitaire sans base, comme `workflow/conditions.ts` et `workflow/engine.ts`.
 *
 * Ce module ne fait QUE la mise en correspondance déclencheur <-> événement, plus le garde-fou anti-rebond.
 * L'évaluation du `conditionGroup` (état du contact) et le démarrage du scénario restent au runner, qui a l'IO.
 */

/**
 * Types de déclencheur livrés. Volontairement fermé : une valeur inconnue en base ne déclenche jamais rien.
 *
 * `tag_added` est CONNU du moteur (le matching est écrit et testé) mais N'EST PAS proposé à la création, car
 * rien ne l'ÉMET encore : un tag peut être posé depuis l'API (fiche contact, action en masse, import, API
 * publique), or l'API est un autre process que le worker et ne sait pas démarrer un scénario. L'émettre
 * proprement demande une file dédiée. Tant qu'elle n'existe pas, proposer ce déclencheur reviendrait à vendre
 * une automation qui ne part jamais.
 */
export const AUTOMATION_TRIGGER_KINDS = ['keyword', 'new_contact', 'tag_added'] as const;
/** Ce que l'UI/API autorise à CRÉER aujourd'hui (sous-ensemble de ce que le moteur sait faire). */
export const AUTOMATION_TRIGGER_KINDS_CREATABLE = ['keyword', 'new_contact'] as const;
export function isCreatableTriggerKind(v: unknown): v is AutomationTriggerKind {
  return typeof v === 'string' && (AUTOMATION_TRIGGER_KINDS_CREATABLE as readonly string[]).includes(v);
}
export type AutomationTriggerKind = (typeof AUTOMATION_TRIGGER_KINDS)[number];
export function isAutomationTriggerKind(v: unknown): v is AutomationTriggerKind {
  return typeof v === 'string' && (AUTOMATION_TRIGGER_KINDS as readonly string[]).includes(v);
}

/** Comment un mot-clé est comparé au message reçu. `equals` sert aussi aux jetons opaques (lien de test wa.me). */
export type KeywordMode = 'contains' | 'equals';

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
  /** null = défaut serveur. 0 = aucun anti-rebond. */
  cooldownSeconds: number | null;
}

/** L'événement observé, forme normalisée par l'appelant (webhook, sweep, hook applicatif). */
export type AutomationEvent =
  | { kind: 'message'; waId: string; body: string | null; isNewContact: boolean }
  | { kind: 'tag_added'; waId: string; tag: string };

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
 * L'événement correspond-il au DÉCLENCHEUR de cette automation ? Ne regarde ni `enabled`, ni le cooldown, ni
 * le `conditionGroup` : le runner compose ces trois filtres, ce qui les garde testables séparément.
 *
 * Une automation mal configurée (mot-clé vide, tag vide) ne déclenche JAMAIS : mieux vaut une automation inerte
 * qu'une automation qui part sur tous les messages.
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
  if (a.triggerKind === 'tag_added') {
    if (ev.kind !== 'tag_added') return false;
    const wanted = normalizeText(String(a.triggerConfig.tag ?? ''));
    return wanted !== '' && normalizeText(ev.tag) === wanted;
  }
  return false;
}

/**
 * Anti-rebond : ce contact a-t-il déjà déclenché CETTE automation trop récemment ?
 *
 * Sans ce garde-fou, un scénario qui pose lui-même le tag déclencheur (ou un client qui répète le mot-clé)
 * relance le scénario en boucle. `cooldownSeconds` à 0 désactive explicitement le garde-fou (choix assumé) ;
 * `null` retombe sur le défaut du serveur, comme le délai de reprise du contrôle.
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
