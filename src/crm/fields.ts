import type { UserFieldDef, UserFieldType } from './types';
import { normaliserDate } from './date-iso';

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

export const USER_FIELD_TYPES: readonly UserFieldType[] = ['text', 'number', 'date', 'datetime', 'boolean', 'url'];

export function isUserFieldType(t: string): t is UserFieldType {
  return (USER_FIELD_TYPES as readonly string[]).includes(t);
}

/** Clé + libellé du champ booléen de consentement par défaut (WhatsApp opt-in), créé à la volée quand un
 *  écran OptIn de flow n'a pas de cible explicite. Clé stable, jamais dérivée d'un libellé mutable. */
export const WHATSAPP_OPTIN_FIELD_KEY = 'whatsapp_optin';
export const WHATSAPP_OPTIN_FIELD_LABEL = 'Consentement WhatsApp';

/**
 * Clés et libellés des champs qui portent la publicité Click-to-WhatsApp d'où vient un contact. Meta n'envoie
 * l'origine que sur le premier message après le clic : ne pas la poser à cet instant, c'est la perdre. Des
 * champs plutôt qu'une colonne : l'origine devient filtrable, utilisable en variable et segmentable sans
 * migration. Clés stables, jamais dérivées d'un libellé mutable.
 */
export const CTWA_AD_ID_FIELD_KEY = 'pub_id';
export const CTWA_AD_ID_FIELD_LABEL = 'Pub (identifiant)';
export const CTWA_AD_TITLE_FIELD_KEY = 'pub_titre';
export const CTWA_AD_TITLE_FIELD_LABEL = 'Pub (titre)';

/** Valide une valeur (string) selon le type déclaré du user field. Vide -> invalide (utiliser un retrait).
 *  Valeurs stockées en string. Partagée par la fiche contact, l'import CSV et le report de WhatsApp Flow. */
export function validateFieldValue(type: UserFieldType, value: string): boolean {
  const v = value.trim();
  if (v === '') return false;
  if (v.length > 1000) return false;
  if (type === 'number') return Number.isFinite(Number(v));
  // date et datetime : tout ce qui est non ambigu (voir `date-iso.ts`) est accepté, le reste refusé.
  if (type === 'date' || type === 'datetime') return normaliserDate(v, type).ok;
  if (type === 'boolean') return ['true', 'false', 'oui', 'non', '1', '0'].includes(v.toLowerCase());
  if (type === 'url') return /^https?:\/\/\S+$/i.test(v);
  return true; // text
}

const BOOLEAN_TRUE_TOKENS = new Set(['true', 'oui', '1']);
const BOOLEAN_FALSE_TOKENS = new Set(['false', 'non', '0']);

/**
 * Canonicalise une valeur vers une forme de stockage stable et comparable. `boolean` -> `'true'`/`'false'`
 * strict, pour que le gate opt-in et les filtres CRM (`fields ->> key = 'true'`) restent fiables ; les autres
 * types -> trim. Ne lève jamais : une valeur non reconnue ressort trimée, `validateFieldValue` étant la barrière.
 */
export function canonicalizeFieldValue(type: UserFieldType, value: string): string {
  const v = value.trim();
  // Une date est stockée sous sa forme internationale, quelle que soit sa forme d'arrivée, pour pouvoir la
  // comparer et la trier.
  if (type === 'date' || type === 'datetime') {
    const n = normaliserDate(v, type);
    return n.ok ? n.iso : v;
  }
  if (type !== 'boolean') return v;
  const low = v.toLowerCase();
  if (BOOLEAN_TRUE_TOKENS.has(low)) return 'true';
  if (BOOLEAN_FALSE_TOKENS.has(low)) return 'false';
  return v;
}

/**
 * Clés des champs de base (« système ») : toujours proposés, ni supprimables ni renommables. Attributs du
 * contact (name/phone/bsuid/wa_id, hors `contacts.fields`) et champs socles (prenom/email). Miroir :
 * `web/lib/fields.ts` (SYSTEM_FIELDS). Sert de garde sur PATCH/DELETE d'un user field.
 */
export const SYSTEM_FIELD_KEYS: readonly string[] = ['name', 'phone', 'bsuid', 'wa_id', 'prenom', 'email'];

export function isSystemFieldKey(key: string): boolean {
  return (SYSTEM_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * Libellés des champs de base, dans les deux langues (miroir de `web/lib/fields.ts` SYSTEM_FIELD_META, tenu par
 * un test). Les clés sont anglaises et l'écran affiche du français : sans cette liste, créer « Nom » (slug `nom`)
 * produirait un doublon visible dans tous les sélecteurs, et qu'aucun chemin d'écriture ne remplirait.
 */
export const SYSTEM_FIELD_LABELS: readonly string[] = [
  'Nom', 'Name',
  'Prénom', 'First name',
  'Téléphone', 'Phone',
  'BSUID',
  'WhatsApp ID',
  'Email',
];

/** Slugs interdits à la création et au renommage : les clés système, plus le slug de chaque libellé de base. */
const SLUGS_RESERVES: ReadonlySet<string> = new Set([
  ...SYSTEM_FIELD_KEYS,
  ...SYSTEM_FIELD_LABELS.map((l) => slugify(l)),
]);

/**
 * Ce libellé fabriquerait-il un doublon d'un champ de base ? Séparée d'`isSystemFieldKey`, qui garde aussi la
 * modification et la suppression : l'élargir rendrait indélébiles les doublons déjà créés.
 */
export function isReservedFieldLabel(label: string): boolean {
  return SLUGS_RESERVES.has(slugify(label));
}

/**
 * Champs socles : les deux seuls champs système stockés dans `contacts.fields` (les autres sont des attributs).
 * Aucun chemin d'inscription ne les crée : ils sont matérialisés à la première écriture (cf. `http/contacts.ts`),
 * sans quoi saisir un prénom sur un espace neuf rendrait « champ inconnu ».
 */
export const SOCLE_FIELDS: ReadonlyArray<{ key: string; label: string; type: UserFieldType }> = [
  { key: 'prenom', label: 'Prénom', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
];
/** Le champ socle correspondant à cette clé, ou undefined si ce n'en est pas un. */
export function socleField(key: string): { key: string; label: string; type: UserFieldType } | undefined {
  return SOCLE_FIELDS.find((f) => f.key === key);
}

export interface UserFieldStore {
  list(tenantId: string): Promise<UserFieldDef[]>;
  upsert(tenantId: string, def: UserFieldDef): Promise<void>;
}

/** Crée le champ perso s'il n'existe pas (idempotent, dédup par slug du libellé). Rejette un type invalide. */
export async function ensureField(
  store: UserFieldStore,
  tenantId: string,
  label: string,
  type: UserFieldType = 'text',
): Promise<UserFieldDef> {
  return ensureFieldByKey(store, tenantId, slugify(label), label, type);
}

/** Crée le champ perso à une clé explicite s'il n'existe pas (idempotent par clé) : pour le champ canonique de
 *  consentement, dont la clé reste stable si le client renomme le libellé. Un champ existant est conservé tel quel. */
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
