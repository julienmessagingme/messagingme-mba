/**
 * Extraction des messages ENTRANTS d'un payload webhook Meta (réponses client, taps de
 * boutons quick-reply). On lit `value.metadata.phone_number_id` (pour mapper au tenant) et
 * chaque `value.messages[]`. BSUID-native : `from` peut manquer -> fallback `contacts[].wa_id`.
 */

export interface InboundMessage {
  phoneNumberId: string;
  waId: string;
  messageId: string;
  type: string;
  body: string | null;
  buttonPayload: string | null;
  profileName: string | null;
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
    if (br['id'] || br['title']) return { body: str(br['title']), buttonPayload: str(br['id']) };
    if (lr['id'] || lr['title']) return { body: str(lr['title']), buttonPayload: str(lr['id']) };
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

/** Mappe chaque message entrant à son tenant et l'enregistre. */
export async function processInbound(payload: unknown, store: InboxStore): Promise<void> {
  for (const m of extractInbound(payload)) {
    const tenantId = await store.phoneNumberTenant(m.phoneNumberId);
    if (tenantId) await store.recordInbound(tenantId, m);
  }
}
