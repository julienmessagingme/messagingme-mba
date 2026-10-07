/**
 * Ce qui a changé dans les réglages d'un robot, et ce qui a été effacé.
 *
 * Meta n'a pas de corbeille : les FAQ, compétences et sites d'un Meta Business Agent vivent chez lui, sans
 * historique ni annulation. Ces lignes sont le seul exemplaire d'un contenu supprimé.
 * 🔴 Ce n'est pas `audit_log`, qui est purgé (deux ans) : la rétention voulue ici est illimitée.
 * Module pur ; l'implémentation Postgres vit dans `./historique.pg.ts`.
 */

/**
 * Ce sur quoi une ligne porte (`element` est un `text` libre en base). `repondeur` : l'agent devient (ou cesse d'être)
 * le répondeur de l'espace (`src/repondeur/reglage.ts`).
 */
export const ELEMENTS = [
  'business_info', 'faq', 'competence', 'site', 'fichier', 'outil', 'activation',
  'fiche_agent', 'connaissance', 'repondeur', 'message_interactif',
] as const;
export type Element = (typeof ELEMENTS)[number];

/**
 * D'où vient la modification : l'assistant de la console, ses onglets, ou un agent tiers par le serveur MCP (lot 8a).
 * Miroir du CHECK `reglages_historique_origine_chk` (0146, élargi par 0206) ; `tests/reglages-historique.test.ts`
 * compare les deux listes.
 */
export const ORIGINES = ['assistant', 'formulaire', 'mcp'] as const;
export type Origine = (typeof ORIGINES)[number];

/** Miroir du CHECK `reglages_historique_operation_chk`. */
export type Operation = 'ajout' | 'modification' | 'suppression';

export interface LigneHistorique {
  surface: 'mba' | 'agent';
  /** L'agent concerné, ou `null` pour le MBA (un seul par espace). */
  surfaceId: string | null;
  element: Element;
  operation: Operation;
  /** L'identifiant chez Meta, ou la clé du champ modifié. Indicatif, jamais une référence : il ne survit pas à la
   *  suppression de l'objet. */
  cible: string | null;
  /** Ce qu'on montre à l'écran, déjà rédigé : « FAQ : horaires du dimanche ». */
  libelle: string;
  /**
   * L'état avant. 🔴 Obligatoire pour une suppression : seul exemplaire du contenu effacé (garde ici et dans le
   * schéma).
   */
  avant: unknown;
  apres: unknown;
  origine: Origine;
  acteurEmail: string | null;
  acteurId: string | null;
}

/** Une ligne relue, telle que l'écran la reçoit. */
export interface LigneHistoriqueLue extends LigneHistorique {
  id: string;
  /** ISO UTC. */
  at: string;
}

export interface FiltreHistorique {
  surface: 'mba' | 'agent';
  /** L'agent visé. Absent ou `null` = le MBA de l'espace. */
  surfaceId?: string | null;
  limite?: number;
}

export interface HistoriqueStore {
  ecrire(tenantId: string, ligne: LigneHistorique): Promise<void>;
  lister(tenantId: string, filtre: FiltreHistorique): Promise<LigneHistoriqueLue[]>;
}

/** Le plafond de lecture. Au-delà, l'écran pagine plutôt que de tout charger. */
export const MAX_LIGNES_HISTORIQUE = 500;

/**
 * Ce qui interdit d'écrire cette ligne, en français, ou `null`. Un message plutôt qu'un booléen : une route doit
 * pouvoir le rendre en 4xx. Pure.
 */
export function problemeDeLigne(l: LigneHistorique): string | null {
  if (l.operation === 'suppression' && (l.avant === null || l.avant === undefined)) {
    return 'Une suppression se journalise avec le contenu effacé : c’est le seul exemplaire qui en reste.';
  }
  if (l.surface === 'agent' && !l.surfaceId) {
    return 'Une ligne d’agent doit nommer l’agent.';
  }
  if (l.surface === 'mba' && l.surfaceId) {
    return 'Le Meta Business Agent est unique par espace : sa ligne ne porte pas d’identifiant.';
  }
  if (l.libelle.trim() === '') {
    return 'Une ligne d’historique doit dire ce qui a changé.';
  }
  return null;
}
