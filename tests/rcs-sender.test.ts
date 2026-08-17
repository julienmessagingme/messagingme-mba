import { describe, it, expect } from 'vitest';
import { RcsSender } from '../src/rcs/sender';
import type { RcsOptoutStore } from '../src/rcs/sender';
import { Reachability } from '../src/rcs/reachability';
import type { ReachabilityStore } from '../src/rcs/reachability';
import { FakeRcsProvider } from '../src/rcs/fake';

class SansCache implements ReachabilityStore {
  async get() {
    return null;
  }
  async put() {
    /* rien */
  }
}

class Optout implements RcsOptoutStore {
  readonly vus: string[] = [];
  constructor(private readonly sortis: Set<string>) {}
  async isOptedOut(_tenantId: string, e164: string) {
    this.vus.push(e164);
    return this.sortis.has(e164);
  }
}

function monter(nonJoignables: string[] = [], optesOut: string[] = []) {
  const provider = new FakeRcsProvider({ unreachable: new Set(nonJoignables) });
  const optout = new Optout(new Set(optesOut));
  const sender = new RcsSender(provider, new Reachability(provider, new SansCache(), () => 0), optout);
  return { provider, optout, sender };
}

describe('RcsSender', () => {
  it('envoie quand le numero est joignable et consentant', async () => {
    const { provider, sender } = monter();
    const r = await sender.sendTo('t1', 'agent-1', '+33600000002', { kind: 'text', text: 'Bonjour' }, 'msg-1');
    expect(r).toEqual({ messageId: 'msg-1' });
    expect(provider.sent).toHaveLength(1);
  });

  it('n envoie RIEN a un numero non joignable', async () => {
    const { provider, sender } = monter(['+33600000001']);
    const r = await sender.sendTo('t1', 'agent-1', '+33600000001', { kind: 'text', text: 'Bonjour' }, 'msg-1');
    expect(r).toEqual({ skipped: 'not_rcs_reachable' });
    expect(provider.sent).toHaveLength(0);
  });

  it('n envoie RIEN a un contact opte-out', async () => {
    const { provider, sender } = monter([], ['+33600000002']);
    const r = await sender.sendTo('t1', 'agent-1', '+33600000002', { kind: 'text', text: 'Bonjour' }, 'msg-1');
    expect(r).toEqual({ skipped: 'rcs_optout' });
    expect(provider.sent).toHaveLength(0);
  });

  it('verifie l opt-out AVANT la joignabilite (un STOP ne coute pas un appel de capacite)', async () => {
    const { provider, optout, sender } = monter([], ['+33600000002']);
    await sender.sendTo('t1', 'agent-1', '+33600000002', { kind: 'text', text: 'Bonjour' }, 'msg-1');
    expect(optout.vus).toEqual(['+33600000002']);
    // Aucun appel de capacité : le provider factice n'a rien vu passer du tout.
    expect(provider.sent).toHaveLength(0);
  });
});
