import { extractFlowCompletions } from './inbound';

/** Retrouve le tenant + le mapping (clé champ -> clé user field) d'un flow par son `ref`. */
export interface FlowMappingLookup {
  findByRef(ref: string): Promise<{ tenantId: string; mapping: Record<string, string> } | null>;
}

/** Écrit les valeurs saisies sur le contact (MERGE), par tenant + wa_id. No-op si contact inconnu (V1).
 *  Le retour (nombre de contacts touchés) est ignoré ici -> `unknown`. */
export interface ContactFieldWriter {
  mergeFieldsByPhone(tenantId: string, waId: string, values: Record<string, unknown>): Promise<unknown>;
}

/**
 * Applique les valeurs d'un WhatsApp Flow rempli aux user fields mappés du contact.
 * On itère sur NOTRE mapping (clé champ -> clé user field), jamais sur les valeurs brutes reçues : ainsi
 * `_ref` / `flow_token` (absents du mapping) ne sont JAMAIS écrits sur le contact. Chaque complétion est
 * isolée dans un try/catch — cette étape partage le job webhook des STATUTS de livraison, elle ne doit
 * jamais le faire échouer (un throw déclencherait un rejeu/DLQ qui rejouerait aussi les statuts et
 * gonflerait le compteur de fréquence marketing).
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
      for (const [fieldKey, target] of Object.entries(flow.mapping)) {
        if (Object.prototype.hasOwnProperty.call(c.values, fieldKey)) mapped[target] = c.values[fieldKey];
      }
      if (Object.keys(mapped).length === 0) continue;
      await writer.mergeFieldsByPhone(flow.tenantId, c.waId, mapped);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('flow mapping: complétion ignorée:', err instanceof Error ? err.message : err);
    }
  }
}
