import { createHash } from 'node:crypto';
import { asArray, asRecord } from './json';

export type WebhookSource =
  | 'messages'
  | 'statuses'
  | 'messaging_handovers'
  | 'standby';

export interface WebhookEvent {
  source: WebhookSource;
  /** Clé d'idempotence : un même événement redélivré produit la même clé. */
  dedupKey: string;
  /** L'objet événement brut (message, statut, echo, handover). */
  data: unknown;
  /**
   * Numéro Meta DESTINATAIRE de l'événement (`value.metadata.phone_number_id`), quand Meta le donne.
   *
   * C'est le seul rattachement à un espace que porte un payload Meta : `phone_numbers` fait le lien. Il est
   * remonté ici pour être STOCKÉ avec l'événement, faute de quoi une ligne de `webhook_events` n'est
   * attribuable à personne et ne peut donc jamais être effacée sur demande (PLAN.md 5.2).
   */
  phoneNumberId?: string;
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

/**
 * Normalise un payload de webhook Meta (entry[].changes[].value) en une liste
 * d'événements portant chacun une clé d'idempotence.
 *
 * BSUID-native : on ne suppose JAMAIS la présence de `from`/`wa_id` (masqués
 * quand l'utilisateur a un username). L'identité d'idempotence vient de l'`id`
 * du message/statut, sinon d'un hash stable du contenu.
 */
/**
 * Ce payload ne contient-il QUE des accusés de livraison (`statuses`) ?
 *
 * 🔴 Sert à router le webhook vers la file des ACCUSÉS plutôt que celle des ENTRANTS (lot 6). Une campagne de
 * 5 000 messages produit trois accusés par destinataire ; sur une file unique, cette rafale passait DEVANT la
 * réponse d'un vrai client, qui attendait derrière quinze mille jobs.
 *
 * Le test est volontairement STRICT et conservateur : il faut au moins un `statuses`, et RIEN d'autre. Un
 * payload mixte (jamais observé, mais Meta ne le promet nulle part) part sur la file des entrants, qui
 * traite aussi les accusés : on ne perd donc jamais rien, on ne fait que renoncer à l'optimisation.
 */
export function nAQueDesAccuses(payload: unknown): boolean {
  const root = asRecord(payload);
  const entries = asArray(root['entry']);
  if (entries.length === 0) return false;
  let accuses = 0;
  for (const entryRaw of entries) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      const change = asRecord(changeRaw);
      const value = asRecord(change['value']);
      // Tout ce qui n'est pas un accusé disqualifie le payload : messages, echoes, et le champ de handover,
      // dont la valeur ne porte AUCUNE des clés ci-dessous.
      if (asArray(value['messages']).length > 0) return false;
      if (asArray(value['message_echoes']).length > 0) return false;
      if (change['field'] === 'messaging_handovers') return false;
      accuses += asArray(value['statuses']).length;
    }
  }
  return accuses > 0;
}

export function parseWebhook(payload: unknown): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  const root = asRecord(payload);

  for (const entryRaw of asArray(root['entry'])) {
    const entry = asRecord(entryRaw);
    for (const changeRaw of asArray(entry['changes'])) {
      const change = asRecord(changeRaw);
      const field = typeof change['field'] === 'string' ? (change['field'] as string) : '';
      const value = asRecord(change['value']);
      // Lu UNE fois par `change` : tous les événements qu'il porte visent le même numéro.
      const pnId = asRecord(value['metadata'])['phone_number_id'];
      const meta = typeof pnId === 'string' && pnId !== '' ? { phoneNumberId: pnId } : {};

      // Messages entrants.
      for (const msgRaw of asArray(value['messages'])) {
        const msg = asRecord(msgRaw);
        const id = typeof msg['id'] === 'string' ? (msg['id'] as string) : undefined;
        events.push({
          source: 'messages',
          dedupKey: id ? `msg:${id}` : hash('messages', msg),
          data: msg,
          ...meta,
        });
      }

      // Statuts de livraison (un même id reçoit sent/delivered/read -> clés distinctes).
      for (const stRaw of asArray(value['statuses'])) {
        const st = asRecord(stRaw);
        const id = typeof st['id'] === 'string' ? (st['id'] as string) : undefined;
        const status = typeof st['status'] === 'string' ? (st['status'] as string) : undefined;
        // Si id ET status présents -> clé sémantique ; sinon hash canonique (deux
        // statuts réellement différents sans champ `status` ne collapsent pas).
        events.push({
          source: 'statuses',
          dedupKey: id && status ? `status:${id}:${status}` : hash('statuses', st),
          data: st,
          ...meta,
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
          ...meta,
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
          ...meta,
        });
      }
    }
  }

  return events;
}
