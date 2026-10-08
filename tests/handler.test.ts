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
    await handleWebhookJob(payload, { store });
    await handleWebhookJob(payload, { store });
    expect(store.inserts).toHaveLength(1);
  });

  it('propage l erreur du store (pour retry/DLQ)', async () => {
    const boom: EventStore = {
      insertEvent: async () => {
        throw new Error('db down');
      },
    };
    await expect(handleWebhookJob(payload, { store: boom })).rejects.toThrow('db down');
  });
});

/**
 * 🔴 Le numéro destinataire arrive jusqu'à l'INSERTION, pas seulement jusqu'au parseur. Depuis 0093, le parseur le
 * portait et le store savait l'écrire, chacun testé seul ; le handler, entre les deux, recopiait l'événement sans lui.
 * La colonne `webhook_events.phone_number_id` est restée vide en production (147 événements sur 24 h, tous à null,
 * mesuré le 2026-10-07), donc aucune ligne n'était effaçable par espace ni par contact.
 */
describe('handleWebhookJob : le numéro destinataire est enregistré avec l’événement', () => {
  const inseres = async (recu: unknown) => {
    const store = new FakeStore();
    await handleWebhookJob(recu, { store });
    return store.inserts.map((e) => [e.source, e.phoneNumberId]);
  };

  it('message, statut et écho : `metadata.phone_number_id`', async () => {
    const value = { metadata: { phone_number_id: 'pn-42' } };
    expect(await inseres({
      entry: [{ changes: [
        { field: 'messages', value: { ...value, messages: [{ id: 'wamid.A' }] } },
        { field: 'statuses', value: { ...value, statuses: [{ id: 'wamid.A', status: 'sent' }] } },
        { field: 'standby', value: { ...value, standby: { message_echoes: [{ id: 'wamid.E' }] } } },
      ] }],
    })).toEqual([['messages', 'pn-42'], ['statuses', 'pn-42'], ['standby', 'pn-42']]);
  });

  it('bascule de contrôle, forme réelle sans `metadata` : `recipient.phone_number_id`', async () => {
    // Forme mesurée le 2026-09-10 (`tests/handover-reel.test.ts`) : le numéro business est dans `recipient`.
    expect(await inseres({
      entry: [{ changes: [{
        field: 'messaging_handovers',
        value: {
          type: 'control_passed',
          sender: { phone_number: '33633921577' },
          recipient: { phone_number_id: 'pn-42', display_phone_number: '33525680250' },
          control_passed: { previous_owner_app_role: 'meta_business_agent' },
        },
      }] }],
    })).toEqual([['messaging_handovers', 'pn-42']]);
  });

  it('deux numéros dans le même payload : chaque ligne garde celui de SON change', async () => {
    expect(await inseres({
      entry: [
        { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn-A' }, messages: [{ id: 'wamid.A' }] } }] },
        { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn-B' }, messages: [{ id: 'wamid.B' }] } }] },
      ],
    })).toEqual([['messages', 'pn-A'], ['messages', 'pn-B']]);
  });
});
