import type { ParamSource, UserFieldDef } from './api';
import { FRONT_SYSTEM_FIELD_KEYS } from './codes';

/**
 * Champs de BASE (« système ») : toujours proposés comme source de variable, toujours présents dans Contenu > Champs,
 * NON supprimables/renommables. Miroir de `src/crm/fields.ts` (SYSTEM_FIELD_KEYS) côté serveur ; l'ordre = l'ordre
 * d'affichage. Chaque champ porte la `source` qui dit comment la variable se résout par contact :
 *  - attribut name/phone/bsuid/wa_id -> lu hors `contacts.fields` (profil, numéro, BSUID, wa_id dérivé) ;
 *  - champ prenom/email -> lu dans `contacts.fields` (valeur posée par import/inbox).
 */
export interface SystemField {
  key: string;
  /**
   * Libellé dans les DEUX langues, `[fr, en]`. Même convention que `NODE_META` : ce fichier est un `.ts` pur,
   * `useT()` y est inappelable, et le rendu fait `t(...f.label)`. Il n'a longtemps porté que le français, ce
   * qui affichait « Prénom » et « Téléphone » dans une console en anglais.
   */
  label: [string, string];
  source: ParamSource;
}

/** Libellé + source de variable de chaque champ système. Typé en `Record` sur la liste de clés PURE : ajouter
 *  une clé à `FRONT_SYSTEM_FIELD_KEYS` sans lui donner de libellé ici ne compile pas. */
const SYSTEM_FIELD_META: Record<(typeof FRONT_SYSTEM_FIELD_KEYS)[number], Omit<SystemField, 'key'>> = {
  name: { label: ['Nom', 'Name'], source: { type: 'attribute', key: 'name' } },
  prenom: { label: ['Prénom', 'First name'], source: { type: 'field', key: 'prenom' } },
  phone: { label: ['Téléphone', 'Phone'], source: { type: 'attribute', key: 'phone' } },
  bsuid: { label: ['BSUID', 'BSUID'], source: { type: 'attribute', key: 'bsuid' } },
  wa_id: { label: ['WhatsApp ID', 'WhatsApp ID'], source: { type: 'attribute', key: 'wa_id' } },
  email: { label: ['Email', 'Email'], source: { type: 'field', key: 'email' } },
};

/** CONSTRUIT à partir de la liste pure, dans son ordre. C'est ce qui rend le test de `web/lib/codes.ts`
 *  représentatif de ce que la page Champs affiche réellement : une seule source de vérité, pas deux. */
export const SYSTEM_FIELDS: SystemField[] = FRONT_SYSTEM_FIELD_KEYS.map((key) => ({ key, ...SYSTEM_FIELD_META[key] }));

export const SYSTEM_FIELD_KEYS: readonly string[] = SYSTEM_FIELDS.map((f) => f.key);

export function isSystemFieldKey(key: string): boolean {
  return SYSTEM_FIELD_KEYS.includes(key);
}

/** Clé du champ booléen de consentement par défaut. Définie dans `./flow-mapping` (module PUR, testé depuis la
 *  suite racine) et ré-exportée ici pour rester au même endroit que les autres helpers de champs. */
export { WHATSAPP_OPTIN_FIELD_KEY } from './flow-mapping';

/**
 * Champs SOCLE : des champs de base stockés dans `contacts.fields`, que le serveur MATÉRIALISE à la première
 * écriture (miroir de `SOCLE_FIELDS`, src/crm/fields.ts). Ils n'existent donc pas dans `user_fields` tant que
 * personne ne les a remplis, ce qui les rendait invisibles ET non ajoutables sur une fiche contact vierge :
 * un contact sans email était impossible à compléter depuis sa fiche (signalé par Julien le 2026-08-25).
 * Ils ont désormais leur ligne dédiée sur la fiche, toujours affichée, même vide.
 *
 * `tests/web-socle-fields-parity.test.ts` casse si les deux listes divergent.
 */
export const SOCLE_CLES: readonly string[] = ['prenom', 'email'];

/**
 * Identifiant WhatsApp d'un contact. Il n'est PAS stocké : il est DÉRIVÉ, exactement comme le fait la
 * résolution serveur (`MATCH_BY_WAID_SQL`, src/crm/contact-store.pg.ts) : les chiffres du numéro, ou le BSUID
 * à défaut. C'est la clé qui relie un contact à sa conversation, à ses parcours et à ses automations.
 *
 * Le dériver ici plutôt que de l'inventer côté écran garantit qu'on montre bien la MÊME valeur que celle sur
 * laquelle le serveur fait ses jointures : un « identifiant » affiché qui ne servirait à rien à la recherche
 * serait pire que pas d'identifiant du tout.
 */
export function waIdDuContact(c: { phoneE164?: string | null; bsuid?: string | null }): string | null {
  const chiffres = (c.phoneE164 ?? '').replace(/[^0-9]/g, '');
  return chiffres !== '' ? chiffres : (c.bsuid ?? null);
}

/** Champs perso à afficher/proposer = les user fields HORS clés système (évite le doublon avec Prénom/Email système). */
export function customFieldsOnly(fields: UserFieldDef[]): UserFieldDef[] {
  return fields.filter((f) => !isSystemFieldKey(f.key));
}

/**
 * Champs RÉSOLUBLES par le node « Envoi de mail » : variable `{{champ}}` d'un modèle, ou destinataire en mode
 * variable. La table de substitution email (`src/crm/render.ts::contactVars`) ne couvre que `phone`/`bsuid`
 * (ajoutés à part par le résolveur) et les clés de `contacts.fields` : `name` et `wa_id` sont des champs système
 * de type ATTRIBUT (pas stockés dans `contacts.fields`, cf. `SYSTEM_FIELDS`) et resteraient donc TOUJOURS vides
 * si on les proposait. Exclusion volontairement étroite (ces deux clés nommément), pas une règle générique sur
 * `source.type` : elle dériverait du contrat serveur sans le dire si `contactVars` change un jour.
 */
export function emailResolvableFields(fields: UserFieldDef[]): UserFieldDef[] {
  return fields.filter((f) => f.key !== 'name' && f.key !== 'wa_id');
}

/**
 * Variables de BASE réellement résolues dans un corps de message (mail ou RCS), avec leur clé SERVEUR.
 *
 * 🔴 Elles n'étaient proposées NULLE PART, et c'est le défaut signalé par Julien le 2026-08-25 (« je ne vois
 * pas le nom ou le numéro de tel »). La cause : la liste de champs vient de `GET /user-fields`, qui ne renvoie
 * que les champs PERSO du tenant (table `user_fields`). Les champs de base sont des constantes du front
 * (`SYSTEM_FIELDS`) qui n'avaient jamais été versées dans le sélecteur de variables.
 *
 * ⚠️ La CLÉ compte plus que le libellé, et c'est le deuxième piège. `contactVars` (`src/crm/render.ts`) ne
 * fournit que `phone`, `phone_e164`, `bsuid`, `profile_name` et les clés de `contacts.fields`. Le nom du
 * contact s'y appelle donc `profile_name`, PAS `name` : c'est exactement pour ça que `name` est exclu par
 * `emailResolvableFields` ci-dessus, il rendrait toujours du vide. Proposer « Nom » sans corriger la clé
 * aurait reproduit le défaut en le rendant invisible.
 *
 * `bsuid` n'est volontairement pas proposé : c'est un identifiant technique, il n'a rien à faire dans un
 * message lu par un humain.
 */
const VARS_DE_BASE: Array<{ key: string; label: [string, string] }> = [
  { key: 'profile_name', label: ['Nom', 'Name'] },
  { key: 'phone', label: ['Téléphone', 'Phone'] },
];

/**
 * Variables proposables dans un CORPS de message : les variables de base réellement résolues, PUIS les champs
 * perso du tenant. Distinct de `emailResolvableFields`, qui sert à choisir un champ CONTENANT une adresse
 * (destinataire du bloc email) : y proposer « Téléphone » serait un piège.
 *
 * Un champ perso qui porterait la même clé qu'une variable de base gagne : c'est lui que `contactVars`
 * renverra, puisqu'il écrase la clé système en fin de construction.
 */
export function emailVariableFields(fields: UserFieldDef[], t: (fr: string, en: string) => string): UserFieldDef[] {
  const perso = emailResolvableFields(fields);
  const dejaLa = new Set(perso.map((f) => f.key));
  const base: UserFieldDef[] = VARS_DE_BASE
    .filter((v) => !dejaLa.has(v.key))
    .map((v) => ({ key: v.key, label: t(v.label[0], v.label[1]), type: 'text' as const }));
  return [...base, ...perso];
}

/** Code public DÉTERMINISTE d'un champ SYSTÈME. Défini dans `./codes` (module PUR, testé depuis la suite
 *  racine) et ré-exporté ici pour rester avec les autres helpers de champs. */
export { systemFieldCode } from './codes';

/** Exemple d'aperçu lisible pour un champ système (miniature WhatsApp). Un champ perso -> `[libellé]`. */
export function systemFieldExample(key: string): string {
  switch (key) {
    case 'name':
      return 'Julie';
    case 'prenom':
      return 'Julie';
    case 'phone':
      return '+33 6 12 34 56 78';
    case 'bsuid':
      return 'BSU_ab12cd34';
    case 'wa_id':
      return '33612345678';
    case 'email':
      return 'julie@exemple.fr';
    default:
      return '…';
  }
}

/**
 * Valeur d'un champ perso d'un contact, insensible à la casse de la clé (les clés posées à l'import peuvent
 * être « prenom » comme « Prénom »). null si absente ou vide après trim.
 *
 * Partagée par le mini-CRM et l'écran Tags, qui en portaient chacun une copie.
 */
export function fieldValue(c: { fields?: Record<string, unknown> | null }, key: string): string | null {
  const f = c.fields ?? {};
  const v = f[key] ?? f[key.toLowerCase()];
  return v == null || String(v).trim() === '' ? null : String(v);
}

/**
 * Nombre de variables `{{n}}` DISTINCTES d'un corps de template : c'est ce nombre qui dit combien de valeurs
 * l'envoi doit fournir. Partagé par l'inbox et la création de campagne.
 *
 * ⚠️ La règle est aussi écrite côté serveur (`src/meta/template-components.ts`) : les deux builds ne
 * partagent aucun module, la synchro reste une convention, verrouillée par les tests de parité.
 */
export function varCountOf(body: string | undefined | null): number {
  return body ? new Set(body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size : 0;
}
