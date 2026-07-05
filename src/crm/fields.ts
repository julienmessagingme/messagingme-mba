import type { UserFieldDef, UserFieldType } from './types';

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Label -> key slug : minuscules, sans accents, séparateurs -> `_`. */
export function slugify(label: string): string {
  const s = label
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'field';
}

export const USER_FIELD_TYPES: readonly UserFieldType[] = ['text', 'number', 'date', 'boolean', 'url'];

export function isUserFieldType(t: string): t is UserFieldType {
  return (USER_FIELD_TYPES as readonly string[]).includes(t);
}

export interface UserFieldStore {
  list(tenantId: string): Promise<UserFieldDef[]>;
  upsert(tenantId: string, def: UserFieldDef): Promise<void>;
}

/** Crée le champ perso s'il n'existe pas (idempotent). Rejette un type invalide. */
export async function ensureField(
  store: UserFieldStore,
  tenantId: string,
  label: string,
  type: UserFieldType = 'text',
): Promise<UserFieldDef> {
  if (!isUserFieldType(type)) throw new Error(`type de champ invalide: ${type}`);
  const key = slugify(label);
  const existing = (await store.list(tenantId)).find((f) => f.key === key);
  if (existing) return existing;
  const def: UserFieldDef = { key, label, type };
  await store.upsert(tenantId, def);
  return def;
}
