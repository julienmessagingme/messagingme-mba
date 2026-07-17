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

/** Clé + libellé du champ booléen de consentement par défaut (WhatsApp opt-in). Créé à la volée quand un
 *  écran OptIn de flow n'a pas de cible explicite. La clé est STABLE (jamais dérivée d'un libellé mutable). */
export const WHATSAPP_OPTIN_FIELD_KEY = 'whatsapp_optin';
export const WHATSAPP_OPTIN_FIELD_LABEL = 'Consentement WhatsApp';

/** Valide une valeur (string) selon le type déclaré du user field. Vide -> invalide (utiliser un retrait).
 *  Les valeurs sont stockées en STRING (cohérent avec String(v) de la substitution campagne). Déplacée depuis
 *  http/contacts.ts (comportement identique) pour être partagée par la fiche contact, l'import CSV et le
 *  report de WhatsApp Flow. */
export function validateFieldValue(type: UserFieldType, value: string): boolean {
  const v = value.trim();
  if (v === '') return false;
  if (v.length > 1000) return false;
  if (type === 'number') return Number.isFinite(Number(v));
  if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  if (type === 'boolean') return ['true', 'false', 'oui', 'non', '1', '0'].includes(v.toLowerCase());
  if (type === 'url') return /^https?:\/\/\S+$/i.test(v);
  return true; // text
}

const BOOLEAN_TRUE_TOKENS = new Set(['true', 'oui', '1']);
const BOOLEAN_FALSE_TOKENS = new Set(['false', 'non', '0']);

/**
 * Canonicalise une valeur vers sa forme de stockage stable et comparable. `boolean` -> `'true'`/`'false'`
 * STRICT (jamais `'oui'`/`'1'`), pour que le gate opt-in, les filtres CRM (égalité `fields ->> key = 'true'`)
 * et toute comparaison ultérieure restent fiables. Les autres types -> trim (stockage STRING inchangé).
 * Défensif : une valeur booléenne non reconnue est renvoyée trimée telle quelle (jamais de throw) ; la
 * validation en amont (validateFieldValue) reste la barrière qui rejette l'invalide sur les chemins validés.
 */
export function canonicalizeFieldValue(type: UserFieldType, value: string): string {
  const v = value.trim();
  if (type !== 'boolean') return v;
  const low = v.toLowerCase();
  if (BOOLEAN_TRUE_TOKENS.has(low)) return 'true';
  if (BOOLEAN_FALSE_TOKENS.has(low)) return 'false';
  return v;
}

/**
 * Clés des champs de BASE (« système ») : toujours proposés, non supprimables ni renommables par l'utilisateur.
 * Attributs du contact (name/phone/bsuid/wa_id, résolus hors `contacts.fields`) + champs socles (prenom/email).
 * Miroir côté front : `web/lib/fields.ts` (SYSTEM_FIELDS). Sert de garde sur PATCH/DELETE d'un user field.
 */
export const SYSTEM_FIELD_KEYS: readonly string[] = ['name', 'phone', 'bsuid', 'wa_id', 'prenom', 'email'];

export function isSystemFieldKey(key: string): boolean {
  return (SYSTEM_FIELD_KEYS as readonly string[]).includes(key);
}

export interface UserFieldStore {
  list(tenantId: string): Promise<UserFieldDef[]>;
  upsert(tenantId: string, def: UserFieldDef): Promise<void>;
}

/** Crée le champ perso s'il n'existe pas (idempotent, dédup PAR SLUG du libellé). Rejette un type invalide. */
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

/** Crée le champ perso à une CLÉ EXPLICITE s'il n'existe pas (idempotent PAR CLÉ, pas par slug du libellé) :
 *  sert au champ canonique de consentement, dont la clé doit rester stable même si le client renomme le
 *  libellé. Un champ existant à cette clé est CONSERVÉ tel quel (type inclus, on ne le réécrit pas). */
export async function ensureFieldByKey(
  store: UserFieldStore,
  tenantId: string,
  key: string,
  label: string,
  type: UserFieldType = 'text',
): Promise<UserFieldDef> {
  if (!isUserFieldType(type)) throw new Error(`type de champ invalide: ${type}`);
  const existing = (await store.list(tenantId)).find((f) => f.key === key);
  if (existing) return existing;
  const def: UserFieldDef = { key, label, type };
  await store.upsert(tenantId, def);
  return def;
}
