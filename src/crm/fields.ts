import type { UserFieldDef, UserFieldType } from './types';
import { normaliserDate } from './date-iso';
import { estCleReservee } from './champs-fiche';
import { slugify } from '../../web/lib/partage/cle-champ';
export { slugify } from '../../web/lib/partage/cle-champ';
import {
  SOCLE_FIELDS, SYSTEM_FIELD_KEYS as CLES_SYSTEME, SYSTEM_FIELD_LABELS, USER_FIELD_KINDS,
} from '../../web/lib/partage/champs';

export const USER_FIELD_TYPES: readonly UserFieldType[] = USER_FIELD_KINDS;

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
 * Clés des champs de base (« système », partagées avec la console) : toujours proposés, ni supprimables ni
 * renommables. Sert de garde sur PATCH/DELETE d'un user field.
 */
export const SYSTEM_FIELD_KEYS: readonly string[] = CLES_SYSTEME;

export function isSystemFieldKey(key: string): boolean {
  return (SYSTEM_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * Slugs interdits à la création et au renommage : les clés système, plus le slug de chaque libellé de base dans
 * les deux langues. Les clés sont anglaises et l'écran affiche du français : sans les libellés, créer « Nom » (slug
 * `nom`) produirait un doublon visible dans tous les sélecteurs, et qu'aucun chemin d'écriture ne remplirait.
 */
const SLUGS_RESERVES: ReadonlySet<string> = new Set([
  ...SYSTEM_FIELD_KEYS,
  ...Object.values(SYSTEM_FIELD_LABELS).flat().map((l) => slugify(l)),
]);

/**
 * Ce libellé fabriquerait-il un doublon d'un champ de base ? Séparée d'`isSystemFieldKey`, qui garde aussi la
 * modification et la suppression : l'élargir rendrait indélébiles les doublons déjà créés.
 */
export function isReservedFieldLabel(label: string): boolean {
  const slug = slugify(label);
  // Et la clé d'un champ FIXE de la fiche (`analyse_sentiment`, `external_id`...) : sa CLÉ seulement, jamais un mot
  // voisin (« satisfaction » reste libre, un Flow de satisfaction peut l'avoir créé).
  return SLUGS_RESERVES.has(slug) || estCleReservee(slug);
}

/**
 * Le champ socle correspondant à cette clé, ou undefined si ce n'en est pas un. Les champs socles
 * (`SOCLE_FIELDS`, partagés avec la console) sont les deux seuls champs système stockés dans `contacts.fields`.
 * Aucun chemin d'inscription ne les crée : ils sont matérialisés à la première écriture (cf. `defPourEcriture`),
 * sans quoi saisir un prénom sur un espace neuf rendrait « champ inconnu ».
 */
export function socleField(key: string): { key: string; label: string; type: UserFieldType } | undefined {
  return SOCLE_FIELDS.find((f) => f.key === key);
}

/** Dépendances minimales pour retrouver un champ au moment d'écrire une valeur sur une fiche. */
export interface ChampsPourEcriture {
  champs: { list(tenantId: string): Promise<UserFieldDef[]> };
  ensureSocleField(tenantId: string, key: string, label: string, type: UserFieldDef['type']): Promise<void>;
}

/**
 * Définition d'un champ pour valider une valeur saisie. Un champ socle (`prenom`/`email`) absent est matérialisé
 * à la volée ; tout autre champ inconnu reste refusé, pour qu'une faute de frappe ne crée pas un champ fantôme.
 * Le mini-CRM et le MCP partagent cette règle sans dépendre d'une route HTTP.
 */
export async function defPourEcriture(deps: ChampsPourEcriture, tenantId: string, key: string): Promise<UserFieldDef | undefined> {
  const lu = async (): Promise<UserFieldDef | undefined> => (await deps.champs.list(tenantId)).find((d) => d.key === key);
  const def = await lu();
  if (def) return def;
  const socle = socleField(key);
  if (!socle) return undefined;
  await deps.ensureSocleField(tenantId, socle.key, socle.label, socle.type);
  return lu();
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
