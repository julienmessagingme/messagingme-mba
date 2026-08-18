import { extractFlowCompletions } from './inbound';
import { canonicalizeFieldValue } from '../crm/fields';
import type { AuditSink } from '../audit/journal';
import { flowFieldToUserFieldType } from '../meta/flow-json';
import type { FlowFieldType } from '../meta/flow-json';

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
 * Cible spéciale du champ de BASE « Nom » : c'est un attribut (profile_name), pas une clé de contacts.fields.
 * SENTINELLE `@profile_name` : le `@` ne peut JAMAIS être produit par slugify (le mapping par défaut d'un champ
 * est `slug(label)`, jamais `@...`), donc SEUL le choix EXPLICITE du champ de base « Nom » cible profile_name.
 * Un champ libellé « Name » laissé en mapping par défaut slugifie en `name` (≠ sentinelle) -> va dans fields, comme
 * avant. ⚠️ Doit rester STRICTEMENT égale à PROFILE_NAME_SAVE_KEY côté web (test anti-drift). */
export const PROFILE_NAME_TARGET = '@profile_name';

/** Écrit les valeurs saisies sur le contact (MERGE) + ouvre le gate marketing sur consentement explicite.
 *  No-op si contact inconnu (V1). Les retours sont ignorés ici -> `unknown`. */
export interface ContactFieldWriter {
  mergeFieldsByPhone(tenantId: string, waId: string, values: Record<string, unknown>): Promise<unknown>;
  /** Consentement marketing explicite capté par un Flow (composant OptIn coché) : opt_in_status='opted_in'.
   *  Rend l'identifiant du contact touché (`null` si numéro inconnu), pour le journal d'audit. */
  markOptedIn(tenantId: string, waId: string, source: string): Promise<string | null>;
  /** Champ de base « Nom » (profile_name) : écrit hors de contacts.fields. */
  setProfileNameByPhone(tenantId: string, waId: string, name: string): Promise<unknown>;
}

/**
 * Applique les valeurs d'un WhatsApp Flow rempli aux user fields mappés du contact.
 * On itère sur NOTRE mapping (clé champ -> clé user field), jamais sur les valeurs brutes reçues : ainsi
 * `_ref` / `flow_token` (absents du mapping) ne sont JAMAIS écrits sur le contact.
 * - Les valeurs BOOLÉENNES sont canonicalisées (`'true'`/`'false'`) ; les autres types gardent la valeur brute
 *   reçue de Meta (pas de régression sur checkbox/tableaux/texte).
 * - Si un champ de type Flow `optin` (consentement) vaut canoniquement `'true'`, on ouvre le gate marketing
 *   du contact (`markOptedIn`), en plus d'écrire le champ. Un champ booléen ORDINAIRE à `true` n'ouvre RIEN
 *   (seul le composant OptIn de Meta a cette portée).
 * Chaque complétion est isolée dans un try/catch : cette étape partage le job webhook des STATUTS de
 * livraison, elle ne doit jamais le faire échouer (un throw rejouerait aussi les statuts en DLQ).
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
        // Le consentement donné par la personne elle-même dans WhatsApp est la preuve la plus forte qu'on
        // possède : un journal qui ne consignerait que les bascules d'opérateur passerait à côté de l'essentiel.
        // Acteur `null` = le système, pas un humain. Numéro inconnu -> rien à journaliser.
        if (contactId && audit) {
          await audit(flow.tenantId, { userId: null, email: null }, 'contact.optin', { kind: 'contact', id: contactId }, { source: 'flow' });
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('flow mapping: complétion ignorée:', err instanceof Error ? err.message : err);
    }
  }
}
