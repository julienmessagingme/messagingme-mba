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
  label: string;
  source: ParamSource;
}

/** Libellé + source de variable de chaque champ système. Typé en `Record` sur la liste de clés PURE : ajouter
 *  une clé à `FRONT_SYSTEM_FIELD_KEYS` sans lui donner de libellé ici ne compile pas. */
const SYSTEM_FIELD_META: Record<(typeof FRONT_SYSTEM_FIELD_KEYS)[number], Omit<SystemField, 'key'>> = {
  name: { label: 'Nom', source: { type: 'attribute', key: 'name' } },
  prenom: { label: 'Prénom', source: { type: 'field', key: 'prenom' } },
  phone: { label: 'Téléphone', source: { type: 'attribute', key: 'phone' } },
  bsuid: { label: 'BSUID', source: { type: 'attribute', key: 'bsuid' } },
  wa_id: { label: 'WhatsApp ID', source: { type: 'attribute', key: 'wa_id' } },
  email: { label: 'Email', source: { type: 'field', key: 'email' } },
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

/** Champs perso à afficher/proposer = les user fields HORS clés système (évite le doublon avec Prénom/Email système). */
export function customFieldsOnly(fields: UserFieldDef[]): UserFieldDef[] {
  return fields.filter((f) => !isSystemFieldKey(f.key));
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
