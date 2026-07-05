export type UserFieldType = 'text' | 'number' | 'date' | 'boolean' | 'url';

export interface UserFieldDef {
  key: string;
  label: string;
  type: UserFieldType;
}

/** Cible d'une colonne CSV : attribut standard, champ perso, ou ignorée. */
export type ColumnTargetKind = 'phone' | 'name' | 'custom' | 'ignore';

export interface ColumnMapping {
  /** header CSV -> { cible, key du champ perso si custom } */
  columns: Record<string, { target: ColumnTargetKind; key?: string }>;
}

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  /** `line` = numéro de ligne dans le FICHIER (en-tête = 1, 1re donnée = 2). */
  errors: Array<{ line: number; reason: string }>;
}
