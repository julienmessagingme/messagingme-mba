import type { ACTIONS, HANDLED_BY, Intent, SENTIMENTS } from './schema';

/**
 * La dernière analyse d'un contact, telle que sa fiche la porte (colonnes `analyse_*` de `contacts`, migration
 * 0196). Écrite par l'analyse seule (`PgConversationAnalysisStore.save`), dans la transaction de l'analyse ; elle
 * survit à l'effacement de la conversation, sauf `conversationId`, qui retombe alors à `null`.
 * `satisfaction` et `urgence` : `null` = pas de mesure, jamais 0.
 */
export interface AnalyseDeFiche {
  intention: Intent;
  sentiment: (typeof SENTIMENTS)[number];
  satisfaction: number | null;
  urgence: number | null;
  resolue: boolean;
  sujet: string;
  traiteePar: (typeof HANDLED_BY)[number];
  action: (typeof ACTIONS)[number];
  /** Quand l'analyse a été faite. */
  analyseLe: Date;
  /** Le dernier message couvert : la règle « dernière » compare cette borne, jamais la date de l'analyse. */
  fenetreFin: Date;
  /** La conversation d'où viennent ces valeurs (pour lire le résumé de la MÊME analyse), `null` une fois effacée. */
  conversationId: string | null;
}

/**
 * Ce qu'une analyse a recopié sur une fiche : l'ancienne copie (`null` à la première analyse du contact) et la
 * nouvelle. `null` à la place de l'objet entier = rien n'a été recopié (aucun contact actif pour cette conversation,
 * ou une analyse plus récente déjà en place). Le déclencheur « un champ d'analyse devient » en naît.
 */
export interface CopieFiche {
  contactId: string;
  /** L'identité WhatsApp de la FICHE écrite (numéro ou BSUID), qui peut différer du fil analysé. */
  waId: string | null;
  avant: AnalyseDeFiche | null;
  apres: AnalyseDeFiche;
}

/** Les colonnes de la copie, dans l'ordre de `analyseDeLaLigne`. Une seule liste, pour chaque lecteur. */
export const COLONNES_ANALYSE_FICHE = [
  'analyse_intention', 'analyse_sentiment', 'analyse_satisfaction', 'analyse_urgence', 'analyse_resolue',
  'analyse_sujet', 'analyse_traitee_par', 'analyse_action', 'analyse_le', 'analyse_fenetre_fin',
  'analyse_conversation_id',
] as const;

export type LigneAnalyseFiche = {
  [K in (typeof COLONNES_ANALYSE_FICHE)[number]]: K extends 'analyse_satisfaction' | 'analyse_urgence'
    ? number | null
    : K extends 'analyse_resolue'
      ? boolean | null
      : K extends 'analyse_le' | 'analyse_fenetre_fin'
        ? Date | null
        : string | null;
};

/**
 * Relit une copie depuis une ligne SQL. `null` si la fiche n'a jamais été analysée : la cohérence est tenue en
 * base (0196, une copie est entière ou absente), `analyse_le` suffit donc à le dire. Les codes sont garantis par
 * les CHECK de 0196, tenus égaux au schéma par `tests/fiche-analyse-migration.test.ts`, d'où les conversions.
 */
export function analyseDeLaLigne(r: LigneAnalyseFiche): AnalyseDeFiche | null {
  if (r.analyse_le === null || r.analyse_fenetre_fin === null) return null;
  return {
    intention: r.analyse_intention as AnalyseDeFiche['intention'],
    sentiment: r.analyse_sentiment as AnalyseDeFiche['sentiment'],
    satisfaction: r.analyse_satisfaction,
    urgence: r.analyse_urgence,
    resolue: r.analyse_resolue === true,
    sujet: r.analyse_sujet ?? '',
    traiteePar: r.analyse_traitee_par as AnalyseDeFiche['traiteePar'],
    action: r.analyse_action as AnalyseDeFiche['action'],
    analyseLe: r.analyse_le,
    fenetreFin: r.analyse_fenetre_fin,
    conversationId: r.analyse_conversation_id,
  };
}
