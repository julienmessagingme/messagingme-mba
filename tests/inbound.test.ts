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

  it('liste interactive (list_reply)', () => {
    const r = extractInbound(payload([{ id: 'wamid.3b', from: '33611', type: 'interactive', interactive: { list_reply: { id: 'row_2', title: 'Option B' } } }]));
    expect(r[0]).toMatchObject({ body: 'Option B', buttonPayload: 'row_2' });
  });

  it('fin de WhatsApp Flow (nfm_reply) -> corps + réponse structurée en payload', () => {
    const r = extractInbound(payload([{ id: 'wamid.5', from: '33611', type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow_rdv', body: 'Formulaire envoyé', response_json: '{"date":"2026-08-01"}' } } }]));
    expect(r[0]).toMatchObject({ type: 'interactive', body: 'Formulaire envoyé', buttonPayload: '{"date":"2026-08-01"}' });
  });

  it('sous-type interactif inconnu -> [interactif] (pas de perte silencieuse)', () => {
    const r = extractInbound(payload([{ id: 'wamid.6', from: '33611', type: 'interactive', interactive: { type: 'mystery' } }]));
    expect(r[0]).toMatchObject({ body: '[interactif]', buttonPayload: null });
  });

  it('réaction -> emoji', () => {
    const r = extractInbound(payload([{ id: 'wamid.7', from: '33611', type: 'reaction', reaction: { emoji: '👍', message_id: 'wamid.orig' } }]));
    expect(r[0]).toMatchObject({ type: 'reaction', body: '👍', buttonPayload: 'wamid.orig' });
  });

  it('image avec légende -> légende ; sans légende -> [image]', () => {
    const withCap = extractInbound(payload([{ id: 'wamid.8', from: '33611', type: 'image', image: { caption: 'Ma photo' } }]));
    expect(withCap[0]).toMatchObject({ type: 'image', body: 'Ma photo' });
    const noCap = extractInbound(payload([{ id: 'wamid.9', from: '33611', type: 'image', image: {} }]));
    expect(noCap[0]).toMatchObject({ type: 'image', body: '[image]' });
  });

  it('localisation -> nom/adresse', () => {
    const r = extractInbound(payload([{ id: 'wamid.10', from: '33611', type: 'location', location: { latitude: 48.8, longitude: 2.3, name: 'Tour Eiffel' } }]));
    expect(r[0]).toMatchObject({ type: 'location', body: 'Tour Eiffel' });
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
