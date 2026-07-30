// Types + sérialisation des filtres de contacts. Module PUR (aucune dépendance React/Next/navigateur au
// chargement) -> testable en unitaire depuis la suite racine (tests/web-contact-filters.test.ts) et importé
// par web/lib/api.ts. `filtersToQuery` est le MIROIR de `parseFilters` côté serveur (src/http/import.ts) :
// tout nouvel opérateur / critère doit être ajouté aux DEUX bouts en même temps (sinon filtre silencieusement
// no-op). Le test anti-drift verrouille ce contrat.

/** Opérateurs de filtre sur un champ perso. `eq`/`contains`/`not_contains` exigent une valeur ;
 *  `empty`/`not_empty` n'en prennent pas. Miroir de `ContactFieldOp` côté serveur. */
export type ContactFieldOp = 'eq' | 'contains' | 'not_contains' | 'empty' | 'not_empty';

/** Un filtre sur la valeur d'un champ perso (jsonb, valeur texte). `value` ignorée pour `empty`/`not_empty`. */
export interface ContactFieldFilter { key: string; op: ContactFieldOp; value: string }

/** Critères composables de la « Liste de contacts » (source de campagne) et du mini-CRM. Tous optionnels. */
export interface ContactFilters {
  tags?: string[];
  tagMode?: 'and' | 'or';
  /** « Ne possède pas » : exclut tout contact portant au moins un de ces tags. */
  tagsExclude?: string[];
  optIn?: 'opted_in' | 'opted_out' | 'unknown';
  phonePrefix?: string;
  phoneContains?: string;
  nameSearch?: string;
  fieldFilters?: ContactFieldFilter[];
}

/** Cible d'une action en masse : ids explicites, OU filtres re-résolus côté serveur (+ exclusions des lignes décochées). */
export type BulkTarget = { ids: string[] } | { filters: ContactFilters; excludeIds?: string[] };

/** Un filtre est-il posé ? (distingue « aucun résultat » de « aucun contact du tout », et gate le chemin
 *  requêtable vs la liste par défaut). Partagé par le mini-CRM et la sélection de destinataires de campagne. */
export function filtersActive(f: ContactFilters): boolean {
  return Boolean(
    f.tags?.length || f.tagsExclude?.length || f.optIn || f.phonePrefix || f.phoneContains || f.nameSearch ||
    f.fieldFilters?.some((ff) => ff.op === 'empty' || ff.op === 'not_empty' || ff.value.trim() !== ''),
  );
}

/** Encode des ContactFilters en query string (miroir de parseFilters côté serveur, src/http/import.ts). */
export function filtersToQuery(f: ContactFilters): URLSearchParams {
  const qs = new URLSearchParams();
  if (f.tags && f.tags.length > 0) qs.set('tags', f.tags.join(','));
  if (f.tagMode === 'or') qs.set('tagMode', 'or');
  if (f.tagsExclude && f.tagsExclude.length > 0) qs.set('tagsExclude', f.tagsExclude.join(','));
  if (f.optIn) qs.set('optIn', f.optIn);
  if (f.phonePrefix) qs.set('phonePrefix', f.phonePrefix);
  if (f.phoneContains) qs.set('phoneContains', f.phoneContains);
  if (f.nameSearch) qs.set('nameSearch', f.nameSearch);
  if (f.fieldFilters && f.fieldFilters.length > 0) qs.set('fields', JSON.stringify(f.fieldFilters));
  return qs;
}
