import { describe, it, expect } from 'vitest';
import { extractDelivery, processStatuses } from '../src/webhooks/delivery';
import type { DeliveryStore, DeliveryStatus } from '../src/webhooks/delivery';
import { handleWebhookJob } from '../src/webhooks/handler';
import type { EventStore, StoredEvent } from '../src/webhooks/store';

describe('extractDelivery', () => {
  it('extrait id + status', () => {
    expect(extractDelivery({ id: 'wamid.X', status: 'delivered' })).toEqual({ messageId: 'wamid.X', status: 'delivered', error: null });
  });
  it('failed -> capture l erreur', () => {
    const d = extractDelivery({ id: 'wamid.X', status: 'failed', errors: [{ code: 131049, title: 'blocked' }] });
    expect(d?.status).toBe('failed');
    expect(d?.error).toContain('blocked');
  });
  it('status inconnu ou id absent -> null', () => {
    expect(extractDelivery({ id: 'x', status: 'queued' })).toBeNull();
    expect(extractDelivery({ status: 'sent' })).toBeNull();
    expect(extractDelivery(null)).toBeNull();
  });
});

class FakeDelivery implements DeliveryStore {
  readonly calls: Array<{ messageId: string; status: DeliveryStatus; error: string | null }> = [];
  async updateDeliveryByMessageId(messageId: string, status: DeliveryStatus, error: string | null): Promise<number> {
    this.calls.push({ messageId, status, error });
    return 1;
  }
}
class FakeEvents implements EventStore {
  readonly events: StoredEvent[] = [];
  async insertEvent(e: StoredEvent): Promise<boolean> {
    this.events.push(e);
    return true;
  }
}

describe('processStatuses via handleWebhookJob', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              statuses: [
                { id: 'wamid.1', status: 'sent' },
                { id: 'wamid.1', status: 'read' },
              ],
              messages: [{ id: 'wamid.in', type: 'text' }],
            },
          },
        ],
      },
    ],
  };

  it('applique les statuts aux destinataires, ignore les messages entrants', async () => {
    const delivery = new FakeDelivery();
    const events = new FakeEvents();
    await handleWebhookJob(payload, events, delivery);
    expect(delivery.calls.map((c) => `${c.messageId}:${c.status}`)).toEqual(['wamid.1:sent', 'wamid.1:read']);
    // Les événements (statuts + message entrant) sont tous stockés.
    expect(events.events.length).toBeGreaterThanOrEqual(3);
  });

  it('sans delivery store -> ne casse pas (rétro-compat)', async () => {
    const events = new FakeEvents();
    await expect(handleWebhookJob(payload, events)).resolves.toBeUndefined();
  });
});
