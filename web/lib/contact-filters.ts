// Reprise des brouillons et sérialisation des filtres de contacts. Le contrat pur partagé avec le serveur
// (types, opérateurs et noms des query params) vit dans `partage/contact-filters`.

import { estNiveauRisque } from './risque';
import {
  CONTACT_FIELD_OPS, CONTACT_FILTER_QUERY_KEYS, OPERATEURS_FICHE_SEULS,
  type ContactFieldOp, type ContactFieldFilter, type ContactFilters, type OperateurFicheSeul,
} from './partage/contact-filters';
export { filtersActive, OPERATEURS_FICHE_SEULS } from './partage/contact-filters';
export type { ContactFieldOp, ContactFieldFilter, ContactFilters, BulkTarget, OperateurFicheSeul } from './partage/contact-filters';

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
  // 🔴 Les opérateurs de la dernière analyse en font partie : un brouillon repris qui les jetterait perdrait son
  // filtre d'analyse, et sa campagne partirait à une audience plus large que celle qu'on avait construite.
  const ops: ReadonlyArray<ContactFieldOp | OperateurFicheSeul> = [...CONTACT_FIELD_OPS, ...OPERATEURS_FICHE_SEULS];
  const champs = (Array.isArray(o.fieldFilters) ? (o.fieldFilters as unknown[]) : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    // `value` est requis MÊME pour `empty`/`not_empty`, qui l'ignorent : le type le déclare non optionnel, et
    // c'est lui que `filtersActive` appelle `.trim()` sans détour.
    .filter((x) => typeof x.key === 'string' && typeof x.value === 'string' && ops.includes(x.op as ContactFieldOp))
    .map((x) => ({ key: x.key as string, op: x.op as ContactFieldOp | OperateurFicheSeul, value: x.value as string }));
  return {
    ...(listeDeTextes('tags') ? { tags: listeDeTextes('tags')! } : {}),
    ...(listeDeTextes('tagsExclude') ? { tagsExclude: listeDeTextes('tagsExclude')! } : {}),
    ...(o.tagMode === 'or' || o.tagMode === 'and' ? { tagMode: o.tagMode as 'or' | 'and' } : {}),
    ...(o.optIn === 'opted_in' || o.optIn === 'opted_out' || o.optIn === 'unknown' ? { optIn: o.optIn } : {}),
    ...(texte('phonePrefix') ? { phonePrefix: texte('phonePrefix')! } : {}),
    ...(texte('phoneContains') ? { phoneContains: texte('phoneContains')! } : {}),
    ...(texte('nameSearch') ? { nameSearch: texte('nameSearch')! } : {}),
    ...(o.joignabiliteWhatsApp === 'connu_injoignable' ? { joignabiliteWhatsApp: 'connu_injoignable' as const } : {}),
    ...(estNiveauRisque(o.risque) ? { risque: o.risque } : {}),
    ...(champs.length > 0 ? { fieldFilters: champs } : {}),
  };
}

/** Encode des ContactFilters en query string (miroir de parseFilters côté serveur, src/http/import.ts). */
export function filtersToQuery(f: ContactFilters): URLSearchParams {
  const qs = new URLSearchParams();
  const k = CONTACT_FILTER_QUERY_KEYS;
  if (f.tags && f.tags.length > 0) qs.set(k.tags, f.tags.join(','));
  if (f.tagMode === 'or') qs.set(k.tagMode, 'or');
  if (f.tagsExclude && f.tagsExclude.length > 0) qs.set(k.tagsExclude, f.tagsExclude.join(','));
  if (f.optIn) qs.set(k.optIn, f.optIn);
  if (f.phonePrefix) qs.set(k.phonePrefix, f.phonePrefix);
  if (f.phoneContains) qs.set(k.phoneContains, f.phoneContains);
  if (f.nameSearch) qs.set(k.nameSearch, f.nameSearch);
  if (f.joignabiliteWhatsApp) qs.set(k.joignabiliteWhatsApp, f.joignabiliteWhatsApp);
  if (f.risque) qs.set(k.risque, f.risque);
  if (f.fieldFilters && f.fieldFilters.length > 0) qs.set(k.fieldFilters, JSON.stringify(f.fieldFilters));
  return qs;
}
