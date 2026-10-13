import type { UserFieldKind } from '../../web/lib/partage/champs';

/** Les types d'un champ perso, partagés avec la console. */
export type UserFieldType = UserFieldKind;

export interface UserFieldDef {
  key: string;
  label: string;
  type: UserFieldType;
  /** Code public « fld_<client>_<ulid> ». Absent ou null pour un champ ancien que le backfill n'a pas traité. */
  code?: string | null;
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
  /** `line` = numéro de ligne dans le fichier (en-tête = 1, 1re donnée = 2). */
  errors: Array<{ line: number; reason: string }>;
}
