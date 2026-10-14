/** Contrat du mapping CSV renvoyé par l'aperçu et renvoyé à l'import. */
export type CsvColumnTarget = 'phone' | 'name' | 'custom' | 'ignore';
export type CsvColumnChoice =
  | { target: 'custom'; /** Clé technique exacte ; absente ou vide = dérivée de l'en-tête. */ key?: string }
  | { target: Exclude<CsvColumnTarget, 'custom'> };
export interface CsvColumnMapping {
  /** En-tête CSV -> cible. `key` n'a de sens que pour un champ personnalisé. */
  columns: Record<string, CsvColumnChoice>;
}

/** Clé technique dérivée d'un libellé, identique dans la console et sur le serveur. */
export function slugify(label: string): string {
  const key = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || 'field';
}

/** Une clé explicite vise un champ précis ; vide ou absente, elle vient de l'en-tête CSV. */
export function cleChampCsv(header: string, key?: string): string {
  return key ? key : slugify(header);
}
