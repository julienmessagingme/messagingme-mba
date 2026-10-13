/**
 * Les déclencheurs d'une automation, tels que la route les accepte et que l'écran les propose. Un type ajouté d'un
 * seul côté ferait échouer la création en 400, ou cacherait un déclencheur.
 */

/**
 * Les types de déclencheur livrés, liste fermée : une valeur inconnue en base ne déclenche jamais rien. Ce que chacun
 * écoute est décrit au moteur (`src/automation/match.ts`). ⚠️ `webhook` est possédé par son webhook entrant : l'écran
 * Automation ne le propose pas et la route refuse d'en créer (migration 0074).
 */
export const AUTOMATION_TRIGGER_KINDS = [
  'keyword', 'new_contact', 'tag_added', 'conversation_analyzed', 'hubspot_deal_stage', 'webhook', 'avant_date', 'ctwa_ad',
  'risque_eleve', 'analyse_devient',
] as const;
export type AutomationTriggerKind = (typeof AUTOMATION_TRIGGER_KINDS)[number];

/**
 * Les opérateurs d'un « devient » : ceux des filtres de contacts, moins ceux qui ne décrivent pas un changement
 * (« vide », « renseigné », « analysée depuis moins de N jours »).
 */
export const OPERATEURS_DEVIENT = ['in', 'gte', 'lte', 'is_true', 'is_false'] as const;
/** Les opérateurs des filtres de « conversation analysée » : tous, moins l'ancienneté, l'analyse ayant lieu maintenant. */
export const OPERATEURS_CONVERSATION_ANALYSEE = ['in', 'gte', 'lte', 'is_true', 'is_false', 'empty', 'not_empty'] as const;
