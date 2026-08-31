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

/**
 * Le numéro DESTINATAIRE est le seul rattachement à un espace que porte un payload Meta. Il est remonté pour
 * être STOCKÉ avec l'événement : sans lui, une ligne de `webhook_events` n'est attribuable à personne et ne
 * peut donc jamais être effacée sur demande (PLAN.md 5.2, migration 0093).
 */
describe('parseWebhook : le numéro destinataire suit l’événement', () => {
  const value = (extra: Record<string, unknown>) => ({ metadata: { display_phone_number: '+33525680250', phone_number_id: 'pn-42' }, ...extra });

  it('message entrant, statut, echo et handover portent tous le phone_number_id', () => {
    const ev = parseWebhook({
      entry: [{ changes: [
        { field: 'messages', value: value({ messages: [{ id: 'wamid.A' }] }) },
        { field: 'statuses', value: value({ statuses: [{ id: 'wamid.A', status: 'sent' }] }) },
        { field: 'messages', value: value({ message_echoes: [{ id: 'wamid.E' }] }) },
        { field: 'messaging_handovers', value: value({ control_passed: {} }) },
      ] }],
    });
    expect(ev).toHaveLength(4);
    for (const e of ev) expect(e.phoneNumberId).toBe('pn-42');
  });

  it('métadonnées absentes ou vides -> pas de champ inventé', () => {
    const sans = parseWebhook({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.A' }] } }] }] });
    expect(sans[0]?.phoneNumberId).toBeUndefined();
    const vide = parseWebhook({
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '' }, messages: [{ id: 'wamid.A' }] } }] }],
    });
    expect(vide[0]?.phoneNumberId).toBeUndefined();
  });

  it('deux numéros dans le même lot -> chaque événement garde le SIEN', () => {
    const ev = parseWebhook({
      entry: [
        { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn-A' }, messages: [{ id: 'wamid.A' }] } }] },
        { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn-B' }, messages: [{ id: 'wamid.B' }] } }] },
      ],
    });
    expect(ev.map((e) => e.phoneNumberId)).toEqual(['pn-A', 'pn-B']);
  });
});
