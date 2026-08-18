import { isContactFieldOp, type ContactFieldFilter, type ContactFilters } from './contact-store.pg';

/**
 * Construction d'un `ContactFilters` à partir de données NON FIABLES.
 *
 * Deux points d'entrée l'alimentent : les query params d'une URL (`parseFilters`, où tout arrive en chaînes
 * CSV ou JSON) et le corps JSON d'une action en masse (`normalizeContactFilters`, où tout arrive en tableaux).
 * Le DÉCODAGE diffère donc légitimement, mais les RÈGLES qui suivent (bornes, whitelist d'opérateurs, plafonds,
 * champs retenus) étaient recopiées ligne à ligne des deux côtés : deux écrans de ciblage qui divergent au
 * premier ajustement, donc deux populations de destinataires différentes pour un même filtre affiché.
 */

/** Plafonds : ils bornent une donnée cliente, pas un choix d'ergonomie. */
const MAX_TAGS = 50;
const MAX_FIELD_FILTERS = 20;
const MAX_FIELD_KEY = 120;
const MAX_FIELD_VALUE = 500;

/** Chaîne utile (non vide après trim), sinon undefined. */
export function texteFiltre(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Liste de tags dédupliquée, sans vides, plafonnée. */
export function tagsFiltre(v: string[]): string[] {
  return [...new Set(v.map(String).map((s) => s.trim()).filter((s) => s !== ''))].slice(0, MAX_TAGS);
}

/**
 * Filtres de champ perso normalisés. Chaque élément doit être un objet portant une `key` texte ; un opérateur
 * inconnu retombe sur `eq` et `empty`/`not_empty` n'ont pas de valeur. Les éléments non-objets (`[null]` d'un
 * corps JSON hostile) sont écartés avant lecture, sinon la route tombe en 500 sur `f.key`.
 */
export function normalizeFieldFilters(raw: unknown[]): ContactFieldFilter[] {
  return raw
    .filter((f): f is { key?: unknown; op?: unknown; value?: unknown } => f !== null && typeof f === 'object' && !Array.isArray(f))
    .filter((f) => typeof f.key === 'string')
    .map((f): ContactFieldFilter => ({
      key: String(f.key).slice(0, MAX_FIELD_KEY),
      op: isContactFieldOp(f.op) ? f.op : 'eq',
      value: typeof f.value === 'string' ? String(f.value).slice(0, MAX_FIELD_VALUE) : '',
    }))
    .slice(0, MAX_FIELD_FILTERS);
}

/** Entrées déjà décodées par l'appelant (chacun sait lire SA forme), avant application des règles communes. */
export interface EntreesFiltres {
  tags: string[];
  tagMode: unknown;
  tagsExclude: string[];
  optIn: unknown;
  phonePrefix: unknown;
  phoneContains: unknown;
  nameSearch: unknown;
  fieldFilters: ContactFieldFilter[];
}

/** Assemble le `ContactFilters` final : seules les clés réellement renseignées y figurent. */
export function buildContactFilters(e: EntreesFiltres): ContactFilters {
  const optIn = texteFiltre(e.optIn);
  const tags = tagsFiltre(e.tags);
  const tagsExclude = tagsFiltre(e.tagsExclude);
  return {
    ...(tags.length > 0 ? { tags } : {}),
    ...(e.tagMode === 'or' ? { tagMode: 'or' as const } : {}),
    ...(tagsExclude.length > 0 ? { tagsExclude } : {}),
    ...(optIn === 'opted_in' || optIn === 'opted_out' || optIn === 'unknown' ? { optIn } : {}),
    ...(texteFiltre(e.phonePrefix) ? { phonePrefix: texteFiltre(e.phonePrefix) } : {}),
    ...(texteFiltre(e.phoneContains) ? { phoneContains: texteFiltre(e.phoneContains) } : {}),
    ...(texteFiltre(e.nameSearch) ? { nameSearch: texteFiltre(e.nameSearch) } : {}),
    ...(e.fieldFilters.length > 0 ? { fieldFilters: e.fieldFilters } : {}),
  };
}
