import { describe, it, expect } from 'vitest';
import { extractInbound, processInbound } from '../src/webhooks/inbound';
import type { InboxStore, InboundMessage } from '../src/webhooks/inbound';

function payload(messages: unknown[], phoneNumberId = 'pn1', contacts?: unknown[]) {
  return {
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, contacts, messages } }] }],
  };
}

describe('extractInbound', () => {
  it('message texte', () => {
    const r = extractInbound(payload([{ id: 'wamid.1', from: '33611', type: 'text', text: { body: 'coucou' } }]));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ phoneNumberId: 'pn1', waId: '33611', messageId: 'wamid.1', type: 'text', body: 'coucou', buttonPayload: null });
  });

  it('tap de bouton quick-reply (type button)', () => {
    const r = extractInbound(payload([{ id: 'wamid.2', from: '33611', type: 'button', button: { text: 'Oui', payload: 'YES' } }]));
    expect(r[0]).toMatchObject({ type: 'button', body: 'Oui', buttonPayload: 'YES' });
  });

  it('bouton interactif (button_reply)', () => {
    const r = extractInbound(payload([{ id: 'wamid.3', from: '33611', type: 'interactive', interactive: { button_reply: { id: 'opt_1', title: 'Intéressé' } } }]));
    expect(r[0]).toMatchObject({ body: 'Intéressé', buttonPayload: 'opt_1' });
  });

  it('BSUID-native : from absent -> fallback contacts[].wa_id', () => {
    const r = extractInbound(payload([{ id: 'wamid.4', type: 'text', text: { body: 'x' } }], 'pn1', [{ wa_id: '33622', profile: { name: 'Marc' } }]));
    expect(r[0]).toMatchObject({ waId: '33622', profileName: 'Marc' });
  });

  it('sans phone_number_id ou sans id/wa_id -> ignoré', () => {
    expect(extractInbound({ entry: [{ changes: [{ value: { messages: [{ id: 'x', from: 'y', type: 'text' }] } }] }] })).toHaveLength(0);
    expect(extractInbound(payload([{ type: 'text', text: { body: 'x' } }]))).toHaveLength(0); // ni id ni wa_id
  });
});

class FakeInbox implements InboxStore {
  readonly recorded: Array<{ tenantId: string; m: InboundMessage }> = [];
  constructor(private readonly tenant: string | null) {}
  async phoneNumberTenant(): Promise<string | null> {
    return this.tenant;
  }
  async recordInbound(tenantId: string, m: InboundMessage): Promise<void> {
    this.recorded.push({ tenantId, m });
  }
}

describe('processInbound', () => {
  it('mappe au tenant et enregistre', async () => {
    const store = new FakeInbox('t1');
    await processInbound(payload([{ id: 'wamid.1', from: '33611', type: 'text', text: { body: 'hi' } }]), store);
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]).toMatchObject({ tenantId: 't1', m: { waId: '33611' } });
  });

  it('numéro inconnu (pas de tenant) -> rien enregistré', async () => {
    const store = new FakeInbox(null);
    await processInbound(payload([{ id: 'wamid.1', from: '33611', type: 'text', text: { body: 'hi' } }]), store);
    expect(store.recorded).toHaveLength(0);
  });
});
