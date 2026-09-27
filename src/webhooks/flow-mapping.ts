import { extractFlowCompletions } from './inbound';
import { canonicalizeFieldValue } from '../crm/fields';
import type { AuditSink } from '../audit/journal';
import { flowFieldToUserFieldType } from '../meta/flow-json';
import type { FlowFieldType } from '../meta/flow-json';
import { messageDe } from '../lib/erreur';

/** Retrouve le tenant + le mapping (clé champ -> clé user field) + les types de champ + les champs OptIn. */
export interface FlowMappingLookup {
  findByRef(ref: string): Promise<{
    tenantId: string;
    mapping: Record<string, string>;
    fieldTypes: Record<string, FlowFieldType>;
    optinFieldKeys: string[];
  } | null>;
}

/**
 * Cible spéciale du champ de base « Nom » : un attribut (profile_name), pas une clé de contacts.fields. Le `@` ne
 * peut pas sortir de slugify : seul le choix explicite du champ « Nom » cible profile_name, un champ libellé
 * « Name » laissé par défaut va dans fields. Doit rester égale à PROFILE_NAME_SAVE_KEY côté web (test anti-drift).
 */
export const PROFILE_NAME_TARGET = '@profile_name';

/** Écrit les valeurs saisies sur le contact (fusion) et ouvre le gate marketing sur consentement explicite.
 *  Rien pour un contact inconnu. Retours ignorés ici, d'où `unknown`. */
export interface ContactFieldWriter {
  mergeFieldsByPhone(tenantId: string, waId: string, values: Record<string, unknown>): Promise<unknown>;
  /** Consentement marketing explicite capté par un Flow (composant OptIn coché) : opt_in_status='opted_in'.
   *  Rend l'identifiant du contact touché (`null` si numéro inconnu), pour le journal d'audit. */
  markOptedIn(tenantId: string, waId: string, source: string): Promise<string | null>;
  /** Champ de base « Nom » (profile_name) : écrit hors de contacts.fields. */
  setProfileNameByPhone(tenantId: string, waId: string, name: string): Promise<unknown>;
}

/**
 * Applique les valeurs d'un WhatsApp Flow rempli aux user fields mappés du contact, en itérant sur notre
 * mapping, jamais sur les valeurs reçues : `_ref` et `flow_token` ne sont jamais écrits. Les booléens sont
 * canonicalisés, le reste garde la valeur brute. 🔴 Seul un champ Flow `optin` à `'true'` ouvre le gate
 * marketing (`markOptedIn`) ; un booléen ordinaire n'ouvre rien. Chaque complétion est isolée : cette étape
 * partage le job des statuts de livraison, qu'un throw rejouerait en DLQ.
 */
export async function processFlowCompletions(
  payload: unknown,
  lookup: FlowMappingLookup,
  writer: ContactFieldWriter,
  audit?: AuditSink,
): Promise<void> {
  for (const c of extractFlowCompletions(payload)) {
    try {
      const flow = await lookup.findByRef(c.ref);
      if (!flow) continue;
      const mapped: Record<string, unknown> = {};
      let consented = false;
      for (const [fieldKey, target] of Object.entries(flow.mapping)) {
        if (!Object.prototype.hasOwnProperty.call(c.values, fieldKey)) continue;
        const userType = flowFieldToUserFieldType(flow.fieldTypes[fieldKey] ?? 'text');
        const value = userType === 'boolean'
          ? canonicalizeFieldValue('boolean', String(c.values[fieldKey]))
          : c.values[fieldKey];
        mapped[target] = value;
        if (flow.optinFieldKeys.includes(fieldKey) && value === 'true') consented = true;
      }
      // Le champ de base « Nom » (target 'name') est un attribut (profile_name), pas une clé de contacts.fields :
      // on le sort du merge et on le route à part. Le reste est mergé dans fields comme d'habitude.
      let profileName: string | undefined;
      if (Object.prototype.hasOwnProperty.call(mapped, PROFILE_NAME_TARGET)) {
        const v = mapped[PROFILE_NAME_TARGET];
        profileName = typeof v === 'string' ? v : String(v ?? '');
        delete mapped[PROFILE_NAME_TARGET];
      }
      if (Object.keys(mapped).length > 0) await writer.mergeFieldsByPhone(flow.tenantId, c.waId, mapped);
      if (profileName !== undefined && profileName.trim() !== '') await writer.setProfileNameByPhone(flow.tenantId, c.waId, profileName.trim());
      if (consented) {
        const contactId = await writer.markOptedIn(flow.tenantId, c.waId, 'flow');
        // Le consentement donné par la personne elle-même dans WhatsApp est la preuve la plus forte : il se journalise.
        // Acteur `null` = le système. Numéro inconnu -> rien à journaliser.
        if (contactId && audit) {
          await audit(flow.tenantId, { userId: null, email: null }, 'contact.optin', { kind: 'contact', id: contactId }, { source: 'flow' });
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('flow mapping: complétion ignorée:', messageDe(err));
    }
  }
}
