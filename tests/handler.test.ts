import { describe, it, expect } from 'vitest';
import { handleWebhookJob } from '../src/webhooks/handler';
import type { EventStore, StoredEvent } from '../src/webhooks/store';

class FakeStore implements EventStore {
  readonly seen = new Set<string>();
  readonly inserts: StoredEvent[] = [];
  async insertEvent(e: StoredEvent): Promise<boolean> {
    if (this.seen.has(e.dedupKey)) return false;
    this.seen.add(e.dedupKey);
    this.inserts.push(e);
    return true;
  }
}

const payload = {
  entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.DUP' }] } }] }],
};

describe('handleWebhookJob', () => {
  it('deux fois le même event -> une seule insertion (idempotent)', async () => {
    const store = new FakeStore();
    await handleWebhookJob(payload, store);
    await handleWebhookJob(payload, store);
    expect(store.inserts).toHaveLength(1);
  });

  it('propage l erreur du store (pour retry/DLQ)', async () => {
    const boom: EventStore = {
      insertEvent: async () => {
        throw new Error('db down');
      },
    };
    await expect(handleWebhookJob(payload, boom)).rejects.toThrow('db down');
  });
});
