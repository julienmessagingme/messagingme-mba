import { describe, it, expect, vi } from 'vitest';
import { processWorkflowAdvance } from '../src/webhooks/workflow-advance';

const payload = {
  entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'PN1' },
    contacts: [{ wa_id: '33600' }],
    messages: [
      { id: 'm1', from: '33600', type: 'text', text: { body: 'oui' } },
      { id: 'm2', from: '33601', type: 'text', text: { body: 'ok' } },
    ],
  } }] }],
};

describe('processWorkflowAdvance', () => {
  it('avance chaque message entrant (tenant résolu via phoneNumberTenant)', async () => {
    const calls: string[] = [];
    await processWorkflowAdvance(payload, {
      phoneNumberTenant: async () => 't1',
      advance: async (t, w, m) => { calls.push(`${t}:${w}:${m}`); },
    });
    expect(calls).toEqual(['t1:33600:m1', 't1:33601:m2']);
  });

  it('ISOLÉ par message : une erreur sur un contact n\'empêche pas l\'avance des autres', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const done: string[] = [];
    await processWorkflowAdvance(payload, {
      phoneNumberTenant: async () => 't1',
      advance: async (_t, _w, m) => { if (m === 'm1') throw new Error('boom'); done.push(m); },
    });
    expect(done).toEqual(['m2']); // m1 a throw mais m2 est quand même traité
    vi.restoreAllMocks();
  });

  it('numéro non rattaché à un tenant -> pas d\'avance', async () => {
    const calls: string[] = [];
    await processWorkflowAdvance(payload, {
      phoneNumberTenant: async () => null,
      advance: async (_t, _w, m) => { calls.push(m); },
    });
    expect(calls).toEqual([]);
  });
});
