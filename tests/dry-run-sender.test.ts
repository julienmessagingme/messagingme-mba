import { describe, it, expect } from 'vitest';
import { DryRunSender } from '../src/campaign/dry-run-sender';

describe('DryRunSender', () => {
  it('sendMarketing renvoie un message-id synthétique sans réseau', async () => {
    const s = new DryRunSender();
    const res = await s.sendMarketing({ to: '+33611', template: { name: 't', language: 'fr' } });
    expect(res.messageId).toMatch(/^dryrun-\+33611-/);
  });

  it('sendTemplate renvoie un message-id synthétique', async () => {
    const s = new DryRunSender();
    const res = await s.sendTemplate('+33622', { name: 't', language: 'fr' });
    expect(res.messageId).toMatch(/^dryrun-\+33622-/);
  });

  it('deux envois -> deux message-ids distincts', async () => {
    const s = new DryRunSender();
    const a = await s.sendTemplate('+33611', { name: 't', language: 'fr' });
    const b = await s.sendTemplate('+33611', { name: 't', language: 'fr' });
    expect(a.messageId).not.toBe(b.messageId);
  });
});
