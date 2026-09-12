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
  /**
   * Joignabilité WhatsApp MÉMORISÉE (migration 0133). `connu_injoignable` = « écarte ceux qu'on SAIT
   * injoignables ». ⚠️ Un INCONNU n'est pas un injoignable : un contact jamais sollicité reste dans
   * l'audience, sinon le filtre viderait la liste de tout client qui démarre.
   */
  joignabiliteWhatsApp?: 'connu_injoignable';
  fieldFilters?: ContactFieldFilter[];
}

/** Cible d'une action en masse : ids explicites, OU filtres re-résolus côté serveur (+ exclusions des lignes décochées). */
export type BulkTarget = { ids: string[] } | { filters: ContactFilters; excludeIds?: string[] };

/** Un filtre est-il posé ? (distingue « aucun résultat » de « aucun contact du tout », et gate le chemin
 *  requêtable vs la liste par défaut). Partagé par le mini-CRM et la sélection de destinataires de campagne. */
export function filtersActive(f: ContactFilters): boolean {
  return Boolean(
    f.tags?.length || f.tagsExclude?.length || f.optIn || f.phonePrefix || f.phoneContains || f.nameSearch ||
    f.joignabiliteWhatsApp ||
    f.fieldFilters?.some((ff) => ff.op === 'empty' || ff.op === 'not_empty' || ff.value.trim() !== ''),
  );
}

/**
 * Des `ContactFilters` reconstruits depuis une source OPAQUE, membre par membre.
 *
 * 🔴 POURQUOI ÇA EXISTE (2026-09-08). Le brouillon de campagne enregistre ses filtres dans un `jsonb` que le
 * serveur ne valide pas (c'est « l'état d'un écran », il est opaque par contrat). Ils reviennent donc du
 * RÉSEAU, et les caster en `ContactFilters` était un `as` sur un payload externe, ce que les conventions du
 * dépôt interdisent. Le risque n'est pas théorique : `filtersActive` fait `ff.value.trim()` pendant le
 * RENDU, et une entrée sans `value` y jetterait. Le dépôt a déjà vécu exactement ça, un champ absent d'une
 * réponse 200 démontant l'écran entier de création de campagne.
 *
 * ⚠️ Ce qui n'est pas reconnu est JETÉ, jamais deviné : un filtre à moitié compris viserait la mauvaise
 * population, ce qui est pire que de repartir sans filtre et de le voir tout de suite à l'écran.
 */
export function filtresRepris(v: unknown): ContactFilters {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const texte = (k: string): string | undefined => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : undefined);
  const listeDeTextes = (k: string): string[] | undefined => {
    const l = Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return l.length > 0 ? l : undefined;
  };
  const ops: ContactFieldOp[] = ['eq', 'contains', 'not_contains', 'empty', 'not_empty'];
  const champs = (Array.isArray(o.fieldFilters) ? (o.fieldFilters as unknown[]) : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    // `value` est requis MÊME pour `empty`/`not_empty`, qui l'ignorent : le type le déclare non optionnel, et
    // c'est lui que `filtersActive` appelle `.trim()` sans détour.
    .filter((x) => typeof x.key === 'string' && typeof x.value === 'string' && ops.includes(x.op as ContactFieldOp))
    .map((x) => ({ key: x.key as string, op: x.op as ContactFieldOp, value: x.value as string }));
  return {
    ...(listeDeTextes('tags') ? { tags: listeDeTextes('tags')! } : {}),
    ...(listeDeTextes('tagsExclude') ? { tagsExclude: listeDeTextes('tagsExclude')! } : {}),
    ...(o.tagMode === 'or' || o.tagMode === 'and' ? { tagMode: o.tagMode as 'or' | 'and' } : {}),
    ...(o.optIn === 'opted_in' || o.optIn === 'opted_out' || o.optIn === 'unknown' ? { optIn: o.optIn } : {}),
    ...(texte('phonePrefix') ? { phonePrefix: texte('phonePrefix')! } : {}),
    ...(texte('phoneContains') ? { phoneContains: texte('phoneContains')! } : {}),
    ...(texte('nameSearch') ? { nameSearch: texte('nameSearch')! } : {}),
    ...(o.joignabiliteWhatsApp === 'connu_injoignable' ? { joignabiliteWhatsApp: 'connu_injoignable' as const } : {}),
    ...(champs.length > 0 ? { fieldFilters: champs } : {}),
  };
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
  if (f.joignabiliteWhatsApp) qs.set('joignabilite', f.joignabiliteWhatsApp);
  if (f.fieldFilters && f.fieldFilters.length > 0) qs.set('fields', JSON.stringify(f.fieldFilters));
  return qs;
}
