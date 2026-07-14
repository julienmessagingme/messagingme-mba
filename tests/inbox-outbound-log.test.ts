import { describe, it, expect } from 'vitest';
import { logTemplateSent, type OutboundLogger } from '../src/inbox/outbound-log';

type Msg = { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null };

describe('logTemplateSent (journal best-effort du template envoyé par un workflow)', () => {
  it('appelle recordOutboundByWaId avec le bon wamid + type template', async () => {
    const calls: Array<{ tenantId: string; waId: string; msg: Msg }> = [];
    const inbox: OutboundLogger = { recordOutboundByWaId: async (tenantId, waId, msg) => { calls.push({ tenantId, waId, msg }); } };
    await logTemplateSent(inbox, 't1', '33611', 'promo', 'wamid-Z');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tenantId: 't1', waId: '33611' });
    expect(calls[0]!.msg).toMatchObject({ type: 'template', templateName: 'promo', messageId: 'wamid-Z' });
    expect(calls[0]!.msg.body).toContain('promo');
  });

  it('BEST-EFFORT : un recordOutboundByWaId qui throw ne propage pas (ne casse pas l\'envoi)', async () => {
    const inbox: OutboundLogger = { recordOutboundByWaId: async () => { throw new Error('db down'); } };
    await expect(logTemplateSent(inbox, 't1', '33611', 'promo', 'wamid-Z')).resolves.toBeUndefined();
  });
});
