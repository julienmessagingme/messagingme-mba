import type { NiveauRisque } from './risque';

/** Contrat des critères partagé par la console et le serveur. Les lectures SQL et les validations d'entrées
 * restent dans le CRM ; ce module pur porte leur vocabulaire commun et le format de l'adresse. */
export const CONTACT_FIELD_OPS = ['eq', 'contains', 'not_contains', 'empty', 'not_empty'] as const;
export type ContactFieldOp = (typeof CONTACT_FIELD_OPS)[number];

export function isContactFieldOp(v: unknown): v is ContactFieldOp {
  return typeof v === 'string' && (CONTACT_FIELD_OPS as readonly string[]).includes(v);
}

export const OPERATEURS_FICHE_SEULS = ['in', 'gte', 'lte', 'is_true', 'is_false', 'newer_than_days'] as const;
export type OperateurFicheSeul = (typeof OPERATEURS_FICHE_SEULS)[number];

export interface ContactFieldFilter { key: string; op: ContactFieldOp | OperateurFicheSeul; value: string }

/** Critères composables du mini-CRM et des audiences de campagne. Tous optionnels. */
export interface ContactFilters {
  tags?: string[];
  /** 'and' (défaut) = tous les tags ; 'or' = au moins un. */
  tagMode?: 'and' | 'or';
  /** Exclut tout contact qui porte au moins un de ces tags. */
  tagsExclude?: string[];
  optIn?: 'opted_in' | 'opted_out' | 'unknown';
  /** Préfixe E.164 ancré. */
  phonePrefix?: string;
  /** Sous-chaîne de chiffres du numéro. */
  phoneContains?: string;
  nameSearch?: string;
  /** Écarte les contacts connus comme injoignables ; les inconnus restent dans l'audience. */
  joignabiliteWhatsApp?: 'connu_injoignable';
  /** Valeur hors des niveaux reconnus : refus 400 côté serveur, jamais abandon silencieux du filtre. */
  risque?: NiveauRisque;
  fieldFilters?: ContactFieldFilter[];
}

/** Une sélection explicite ou un jeu de filtres re-résolu côté serveur, avec exclusions éventuelles. */
export type BulkTarget = { ids: string[] } | { filters: ContactFilters; excludeIds?: string[] };

/** Les noms des critères sur le fil GET. Deux noms historiques diffèrent du modèle : `joignabilite`, `fields`. */
export const CONTACT_FILTER_QUERY_KEYS = {
  tags: 'tags', tagMode: 'tagMode', tagsExclude: 'tagsExclude', optIn: 'optIn',
  phonePrefix: 'phonePrefix', phoneContains: 'phoneContains', nameSearch: 'nameSearch',
  joignabiliteWhatsApp: 'joignabilite', risque: 'risque', fieldFilters: 'fields',
} as const satisfies Record<keyof ContactFilters, string>;

/** Un critère réellement posé, pour la console et le choix de route du GET serveur. */
export function filtersActive(f: ContactFilters): boolean {
  return Boolean(
    f.tags?.length || f.tagsExclude?.length || f.optIn || f.phonePrefix || f.phoneContains || f.nameSearch ||
    f.joignabiliteWhatsApp || f.risque ||
    f.fieldFilters?.some((ff) => ff.key.trim() !== '' &&
      (ff.op === 'empty' || ff.op === 'not_empty' || ff.op === 'is_true' || ff.op === 'is_false' || ff.value.trim() !== '')),
  );
}
