/**
 * Extraction des messages ENTRANTS d'un payload webhook Meta (réponses client, taps de
 * boutons quick-reply). On lit `value.metadata.phone_number_id` (pour mapper au tenant) et
 * chaque `value.messages[]`. BSUID-native : `from` peut manquer -> fallback `contacts[].wa_id`.
 */

import { FLOW_REF_KEY } from '../meta/flow-json';

export interface InboundMessage {
  phoneNumberId: string;
  waId: string;
  messageId: string;
  type: string;
  body: string | null;
  buttonPayload: string | null;
  profileName: string | null;
}

/** Complétion d'un WhatsApp Flow (nfm_reply parsé) : le discriminant `ref` identifie le flow (donc le
 *  tenant + le mapping), `values` porte les champs saisis (clés = clés de champ du flow). */
export interface FlowCompletion {
  phoneNumberId: string;
  waId: string;
  ref: string;
  values: Record<string, unknown>;
}

export interface InboxStore {
  /** Tenant propriétaire du numéro (mappe le message entrant à un tenant). null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Upsert la conversation (par tenant+wa_id) et insère le message (idempotent par wamid). */
  recordInbound(tenantId: string, m: InboundMessage): Promise<void>;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Corps + payload de bouton selon le type de message entrant. */
function contentOf(msg: Record<string, unknown>): { body: string | null; buttonPayload: string | null } {
  const type = str(msg['type']) ?? '';
  if (type === 'text') return { body: str(asRecord(msg['text'])['body']), buttonPayload: null };
  if (type === 'button') {
    const btn = asRecord(msg['button']);
    return { body: str(btn['text']), buttonPayload: str(btn['payload']) };
  }
  if (type === 'interactive') {
    const it = asRecord(msg['interactive']);
    const br = asRecord(it['button_reply']);
    const lr = asRecord(it['list_reply']);
    const nfm = asRecord(it['nfm_reply']);
    if (br['id'] || br['title']) return { body: str(br['title']), buttonPayload: str(br['id']) };
    if (lr['id'] || lr['title']) return { body: str(lr['title']), buttonPayload: str(lr['id']) };
    // Fin de WhatsApp Flow (nfm_reply) : garder le libellé + la réponse structurée en payload.
    if (nfm['name'] || nfm['body'] || nfm['response_json']) {
      const rj = nfm['response_json'];
      return {
        body: str(nfm['body']) ?? str(nfm['name']) ?? '[formulaire]',
        buttonPayload: typeof rj === 'string' ? rj.slice(0, 2000) : str(nfm['name']),
      };
    }
    // Sous-type interactif inconnu : ne pas perdre le fait qu'il y a eu une interaction.
    return { body: '[interactif]', buttonPayload: null };
  }
  if (type === 'reaction') {
    const r = asRecord(msg['reaction']);
    return { body: str(r['emoji']), buttonPayload: str(r['message_id']) };
  }
  // Médias : garder la légende si présente, sinon un libellé de type (aperçu non vide).
  if (type === 'image' || type === 'video' || type === 'document' || type === 'audio' || type === 'sticker') {
    return { body: str(asRecord(msg[type])['caption']) ?? `[${type}]`, buttonPayload: null };
  }
  if (type === 'location') {
    const loc = asRecord(msg['location']);
    return { body: str(loc['name']) ?? str(loc['address']) ?? '[localisation]', buttonPayload: null };
  }
  return { body: null, buttonPayload: null };
}

export function extractInbound(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      const value = asRecord(asRecord(changeRaw)['value']);
      const phoneNumberId = str(asRecord(value['metadata'])['phone_number_id']);
      if (!phoneNumberId) continue;
      const contacts = asArray(value['contacts']).map(asRecord);
      const fallbackWaId = str(contacts[0]?.['wa_id']);
      const profileName = str(asRecord(contacts[0]?.['profile'])['name']);
      for (const msgRaw of asArray(value['messages'])) {
        const msg = asRecord(msgRaw);
        const messageId = str(msg['id']);
        const waId = str(msg['from']) ?? fallbackWaId;
        if (!messageId || !waId) continue;
        const { body, buttonPayload } = contentOf(msg);
        out.push({
          phoneNumberId,
          waId,
          messageId,
          type: str(msg['type']) ?? 'unknown',
          body,
          buttonPayload,
          profileName,
        });
      }
    }
  }
  return out;
}

/**
 * Extrait les complétions de WhatsApp Flow (nfm_reply) d'un payload webhook. Parse `response_json` et
 * isole le discriminant `_ref` (FLOW_REF_KEY) : sans lui on ne sait pas à quel flow/mapping rattacher les
 * valeurs -> on ignore (flow hors de notre générateur). Le `_ref` est retiré des `values`. Ne lève JAMAIS
 * (JSON illisible -> complétion ignorée) : c'est de la donnée externe non fiable.
 */
export function extractFlowCompletions(payload: unknown): FlowCompletion[] {
  const out: FlowCompletion[] = [];
  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      const value = asRecord(asRecord(changeRaw)['value']);
      const phoneNumberId = str(asRecord(value['metadata'])['phone_number_id']);
      if (!phoneNumberId) continue;
      const contacts = asArray(value['contacts']).map(asRecord);
      const fallbackWaId = str(contacts[0]?.['wa_id']);
      for (const msgRaw of asArray(value['messages'])) {
        const msg = asRecord(msgRaw);
        if (str(msg['type']) !== 'interactive') continue;
        const rj = asRecord(asRecord(msg['interactive'])['nfm_reply'])['response_json'];
        if (typeof rj !== 'string') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(rj);
        } catch {
          continue;
        }
        const obj = asRecord(parsed);
        const ref = str(obj[FLOW_REF_KEY]);
        if (!ref) continue;
        const waId = str(msg['from']) ?? fallbackWaId;
        if (!waId) continue;
        const values: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) if (k !== FLOW_REF_KEY) values[k] = v;
        out.push({ phoneNumberId, waId, ref, values });
      }
    }
  }
  return out;
}

/** Auto-création d'une fiche contact depuis un message entrant (par numéro OU BSUID). */
export type InboundContactUpsert = (tenantId: string, m: InboundMessage) => Promise<void>;

/**
 * Mappe chaque message entrant à son tenant et l'enregistre. Si `upsertContact` est fourni, crée/rafraîchit
 * la fiche contact AVANT `recordInbound` (pour que la conversation se lie au contact). L'auto-création est
 * ISOLÉE (best-effort) : un échec ne casse pas l'enregistrement inbox (cœur du webhook).
 */
export async function processInbound(payload: unknown, store: InboxStore, upsertContact?: InboundContactUpsert): Promise<void> {
  for (const m of extractInbound(payload)) {
    const tenantId = await store.phoneNumberTenant(m.phoneNumberId);
    if (!tenantId) continue;
    if (upsertContact) {
      try {
        await upsertContact(tenantId, m);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('processInbound: auto-création contact ignorée:', err instanceof Error ? err.message : err);
      }
    }
    await store.recordInbound(tenantId, m);
  }
}
