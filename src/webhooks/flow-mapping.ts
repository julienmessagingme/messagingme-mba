import { extractFlowCompletions } from './inbound';
import { canonicalizeFieldValue } from '../crm/fields';
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

/** Écrit les valeurs saisies sur le contact (MERGE) + ouvre le gate marketing sur consentement explicite.
 *  No-op si contact inconnu (V1). Les retours sont ignorés ici -> `unknown`. */
export interface ContactFieldWriter {
  mergeFieldsByPhone(tenantId: string, waId: string, values: Record<string, unknown>): Promise<unknown>;
  /** Consentement marketing explicite capté par un Flow (composant OptIn coché) : opt_in_status='opted_in'. */
  markOptedIn(tenantId: string, waId: string, source: string): Promise<unknown>;
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
      if (Object.keys(mapped).length > 0) await writer.mergeFieldsByPhone(flow.tenantId, c.waId, mapped);
      if (consented) await writer.markOptedIn(flow.tenantId, c.waId, 'flow');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('flow mapping: complétion ignorée:', err instanceof Error ? err.message : err);
    }
  }
}
