import { describe, it, expect } from 'vitest';
import { FakeRcsProvider } from '../src/rcs/fake';

describe('FakeRcsProvider', () => {
  it('renvoie null pour un numero declare non joignable', async () => {
    const p = new FakeRcsProvider({ unreachable: new Set(['+33600000001']) });
    expect(await p.capabilities('agent-1', '+33600000001')).toBeNull();
    expect(await p.capabilities('agent-1', '+33600000002')).not.toBeNull();
  });

  it('journalise chaque envoi avec son messageId et le rend tel quel', async () => {
    const p = new FakeRcsProvider();
    const r = await p.send('agent-1', '+33600000002', { kind: 'text', text: 'Bonjour' }, 'msg-42');
    expect(r).toEqual({ messageId: 'msg-42' });
    expect(p.sent).toEqual([
      { agentId: 'agent-1', e164: '+33600000002', msg: { kind: 'text', text: 'Bonjour' }, messageId: 'msg-42' },
    ]);
  });

  it('ignore un messageId deja utilise pour le meme agent (idempotence RBM)', async () => {
    const p = new FakeRcsProvider();
    await p.send('agent-1', '+33600000002', { kind: 'text', text: 'A' }, 'msg-1');
    await p.send('agent-1', '+33600000002', { kind: 'text', text: 'B' }, 'msg-1');
    expect(p.sent).toHaveLength(1);
  });

  it('ne confond PAS deux agents qui utilisent le meme messageId', async () => {
    const p = new FakeRcsProvider();
    await p.send('agent-1', '+33600000002', { kind: 'text', text: 'A' }, 'msg-1');
    await p.send('agent-2', '+33600000002', { kind: 'text', text: 'B' }, 'msg-1');
    expect(p.sent).toHaveLength(2);
  });
});
