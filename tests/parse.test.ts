import { describe, it, expect } from 'vitest';
import { parseWebhook } from '../src/webhooks/parse';

describe('parseWebhook', () => {
  it('message entrant -> dedupKey msg:<id>', () => {
    const ev = parseWebhook({
      entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.A', text: { body: 'hi' } }] } }] }],
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]?.source).toBe('messages');
    expect(ev[0]?.dedupKey).toBe('msg:wamid.A');
  });

  it('message SANS from/wa_id (username) est toléré', () => {
    const ev = parseWebhook({
      entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.B' }], contacts: [{ user_id: 'US.123' }] } }] }],
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]?.dedupKey).toBe('msg:wamid.B');
  });

  it('statuts sent/delivered/read -> 3 clés distinctes', () => {
    const value = {
      statuses: [
        { id: 'wamid.X', status: 'sent' },
        { id: 'wamid.X', status: 'delivered' },
        { id: 'wamid.X', status: 'read' },
      ],
    };
    const ev = parseWebhook({ entry: [{ changes: [{ field: 'statuses', value }] }] });
    const keys = ev.map((e) => e.dedupKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toContain('status:wamid.X:sent');
  });

  it('statuts sans champ `status` -> clés distinctes (pas de collapse sur :unknown)', () => {
    const ev = parseWebhook({
      entry: [{ changes: [{ field: 'statuses', value: { statuses: [
        { id: 'wamid.Y', errors: [{ code: 1 }] },
        { id: 'wamid.Y', errors: [{ code: 2 }] },
      ] } }] }],
    });
    expect(ev).toHaveLength(2);
    expect(ev[0]?.dedupKey).not.toBe(ev[1]?.dedupKey);
  });

  it('standby (message_echoes) -> source standby', () => {
    const ev = parseWebhook({
      entry: [{ changes: [{ field: 'standby', value: { message_echoes: [{ id: 'wamid.E' }] } }] }],
    });
    expect(ev[0]?.source).toBe('standby');
    expect(ev[0]?.dedupKey).toBe('standby:wamid.E');
  });

  it('messaging_handovers -> clé stable, insensible à l ordre des clés JSON', () => {
    const a = parseWebhook({
      entry: [{ changes: [{ field: 'messaging_handovers', value: { a: 1, b: 2, control: { x: 1, y: 2 } } }] }],
    });
    // même contenu, clés dans un ordre différent -> doit produire la MÊME clé.
    const b = parseWebhook({
      entry: [{ changes: [{ field: 'messaging_handovers', value: { control: { y: 2, x: 1 }, b: 2, a: 1 } }] }],
    });
    expect(a[0]?.source).toBe('messaging_handovers');
    expect(a[0]?.dedupKey).toBe(b[0]?.dedupKey);
  });

  it('payload vide / null -> aucun event', () => {
    expect(parseWebhook({})).toHaveLength(0);
    expect(parseWebhook(null)).toHaveLength(0);
  });
});
