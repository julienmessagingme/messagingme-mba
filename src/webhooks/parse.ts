import { createHash } from 'node:crypto';

export type WebhookSource =
  | 'messages'
  | 'statuses'
  | 'messaging_handovers'
  | 'standby'
  | 'unknown';

export interface WebhookEvent {
  source: WebhookSource;
  /** Clé d'idempotence : un même événement redélivré produit la même clé. */
  dedupKey: string;
  /** L'objet événement brut (message, statut, echo, handover). */
  data: unknown;
}

/** Sérialisation canonique (clés triées) -> hash insensible à l'ordre des clés. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

function hash(source: WebhookSource, data: unknown): string {
  const h = createHash('sha256').update(stableStringify(data)).digest('hex').slice(0, 32);
  return `${source}:${h}`;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * Normalise un payload de webhook Meta (entry[].changes[].value) en une liste
 * d'événements portant chacun une clé d'idempotence.
 *
 * BSUID-native : on ne suppose JAMAIS la présence de `from`/`wa_id` (masqués
 * quand l'utilisateur a un username). L'identité d'idempotence vient de l'`id`
 * du message/statut, sinon d'un hash stable du contenu.
 */
export function parseWebhook(payload: unknown): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  const root = asRecord(payload);

  for (const entryRaw of asArray(root['entry'])) {
    const entry = asRecord(entryRaw);
    for (const changeRaw of asArray(entry['changes'])) {
      const change = asRecord(changeRaw);
      const field = typeof change['field'] === 'string' ? (change['field'] as string) : '';
      const value = asRecord(change['value']);

      // Messages entrants.
      for (const msgRaw of asArray(value['messages'])) {
        const msg = asRecord(msgRaw);
        const id = typeof msg['id'] === 'string' ? (msg['id'] as string) : undefined;
        events.push({
          source: 'messages',
          dedupKey: id ? `msg:${id}` : hash('messages', msg),
          data: msg,
        });
      }

      // Statuts de livraison (un même id reçoit sent/delivered/read -> clés distinctes).
      for (const stRaw of asArray(value['statuses'])) {
        const st = asRecord(stRaw);
        const id = typeof st['id'] === 'string' ? (st['id'] as string) : undefined;
        const status = typeof st['status'] === 'string' ? (st['status'] as string) : 'unknown';
        events.push({
          source: 'statuses',
          dedupKey: id ? `status:${id}:${status}` : hash('statuses', st),
          data: st,
        });
      }

      // Standby : echoes des messages envoyés depuis l'app (coexistence / MBA a le contrôle).
      for (const echoRaw of asArray(value['message_echoes'])) {
        const echo = asRecord(echoRaw);
        const id = typeof echo['id'] === 'string' ? (echo['id'] as string) : undefined;
        events.push({
          source: 'standby',
          dedupKey: id ? `standby:${id}` : hash('standby', echo),
          data: echo,
        });
      }

      // Changements de contrôle du thread (handover protocol). Shape peu documentée
      // -> clé par hash canonique du contenu (idempotent sur redélivrance identique,
      //    insensible à l'ordre des clés JSON).
      if (field === 'messaging_handovers') {
        events.push({
          source: 'messaging_handovers',
          dedupKey: hash('messaging_handovers', value),
          data: value,
        });
      }
    }
  }

  return events;
}
