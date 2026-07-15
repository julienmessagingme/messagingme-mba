import type { ParamSource, UserFieldDef } from './api';

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

export const SYSTEM_FIELDS: SystemField[] = [
  { key: 'name', label: 'Nom', source: { type: 'attribute', key: 'name' } },
  { key: 'prenom', label: 'Prénom', source: { type: 'field', key: 'prenom' } },
  { key: 'phone', label: 'Téléphone', source: { type: 'attribute', key: 'phone' } },
  { key: 'bsuid', label: 'BSUID', source: { type: 'attribute', key: 'bsuid' } },
  { key: 'wa_id', label: 'WhatsApp ID', source: { type: 'attribute', key: 'wa_id' } },
  { key: 'email', label: 'Email', source: { type: 'field', key: 'email' } },
];

export const SYSTEM_FIELD_KEYS: readonly string[] = SYSTEM_FIELDS.map((f) => f.key);

export function isSystemFieldKey(key: string): boolean {
  return SYSTEM_FIELD_KEYS.includes(key);
}

/** Champs perso à afficher/proposer = les user fields HORS clés système (évite le doublon avec Prénom/Email système). */
export function customFieldsOnly(fields: UserFieldDef[]): UserFieldDef[] {
  return fields.filter((f) => !isSystemFieldKey(f.key));
}

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
