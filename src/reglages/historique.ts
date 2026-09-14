/**
 * CE QUI A CHANGÉ DANS LES RÉGLAGES D'UN ROBOT, ET CE QUI A ÉTÉ EFFACÉ.
 *
 * 🔴 IL EXISTE PARCE QUE META N'A PAS DE CORBEILLE. Les FAQ, compétences et sites d'un Meta Business Agent
 * vivent CHEZ LUI : rien n'est stocké chez nous, il n'y a ni historique ni annulation. Une suppression par
 * erreur est définitive, et ces lignes en sont le seul exemplaire.
 *
 * 🔴 CE N'EST PAS `audit_log`, ET LA RAISON EST MESURÉE. Ce journal-là conviendrait par sa forme
 * (`action`, `target_kind`, `target_id`, `detail` jsonb, `actor_email` dénormalisé), mais il est PURGÉ :
 * `PgAuditStore.purgeOlderThan`, deux ans par défaut. La rétention demandée ici est illimitée. Y ranger cet
 * historique aurait été une promesse démentie par un `delete` écrit dans un autre fichier.
 *
 * ⚠️ LES DEUX JOURNAUX COEXISTENT et ne répondent pas à la même question : `audit_log` est la PREUVE qu'une
 * purge RGPD a eu lieu et de qui l'a demandée ; celui-ci dit ce qu'un robot savait hier et ne sait plus.
 *
 * PUR : aucune IO. L'implémentation Postgres vit dans `./historique.pg.ts`.
 */

/** Ce sur quoi une ligne porte. Miroir de rien en base (`element` est un `text` libre), mais la liste. */
export const ELEMENTS = [
  'business_info', 'faq', 'competence', 'site', 'fichier', 'outil', 'activation',
  'fiche_agent', 'connaissance',
] as const;
export type Element = (typeof ELEMENTS)[number];

/** D'où vient la modification. Miroir du CHECK `reglages_historique_origine_chk`. */
export type Origine = 'assistant' | 'formulaire';

/** Miroir du CHECK `reglages_historique_operation_chk`. */
export type Operation = 'ajout' | 'modification' | 'suppression';

export interface LigneHistorique {
  surface: 'mba' | 'agent';
  /** L'agent concerné, ou `null` pour le MBA (un seul par espace). */
  surfaceId: string | null;
  element: Element;
  operation: Operation;
  /**
   * L'identifiant chez Meta, ou la clé du champ modifié.
   *
   * ⚠️ INDICATIF, JAMAIS UNE RÉFÉRENCE : un identifiant Meta ne survit pas à la suppression de l'objet
   * qu'il désigne. Il sert à rapprocher deux lignes entre elles, pas à retrouver quoi que ce soit.
   */
  cible: string | null;
  /** Ce qu'on montre à l'écran, déjà rédigé : « FAQ : horaires du dimanche ». */
  libelle: string;
  /**
   * L'état AVANT.
   *
   * 🔴 OBLIGATOIRE POUR UNE SUPPRESSION : c'est le seul exemplaire du contenu effacé. La garde est ici ET
   * dans le schéma, et les deux sont voulues : celle-ci donne une erreur lisible au développeur, celle-là
   * est infranchissable.
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
 * CE QUI INTERDIT D'ÉCRIRE CETTE LIGNE, en français, ou `null` si rien ne l'interdit.
 *
 * 🔴 ELLE REND UN MESSAGE PLUTÔT QU'UN BOOLÉEN, comme `problemeDeChaine` : l'appelant est parfois une route
 * qui doit répondre en 4xx, et « false » ne se transmet pas à un utilisateur. PURE, donc éprouvable sans base.
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
