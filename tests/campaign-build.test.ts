import { describe, it, expect } from 'vitest';
import { buildRecipients } from '../src/campaign/build';
import type { BuildContact } from '../src/campaign/build';
import type { TemplateParam } from '../src/crm/template';

const mapping: TemplateParam[] = [{ position: 1, source: { type: 'attribute', key: 'name' } }];

const contacts: BuildContact[] = [
  { id: 'c1', phone_e164: '+33611111111', profile_name: 'Julie', optInStatus: 'opted_in' },
  { id: 'c2', phone_e164: '+33622222222', profile_name: 'Marc', optInStatus: 'unknown' },
  { id: 'c3', phone_e164: '+33611111111', profile_name: 'Doublon', optInStatus: 'opted_in' },
  { id: 'c4', phone_e164: null, profile_name: 'SansTel', optInStatus: 'opted_in' },
];

describe('buildRecipients', () => {
  it('marketing : opt-in filtré, dédup par numéro, params résolus', () => {
    const { recipients } = buildRecipients('marketing', mapping, contacts);
    expect(recipients.map((x) => x.contactId)).toEqual(['c1']); // c2 non opt-in, c3 doublon, c4 sans tel
    expect(recipients[0]?.resolvedParams).toEqual(['Julie']);
  });

  it('utility : inclut les contacts sans opt-in explicite', () => {
    const { recipients } = buildRecipients('utility', mapping, contacts);
    expect(recipients.map((x) => x.contactId)).toEqual(['c1', 'c2']); // c3 doublon, c4 sans tel
  });

  it('cible un contact SANS numéro par son BSUID (destinataire = bsuid)', () => {
    const withBsuid: BuildContact[] = [
      { id: 'b1', phone_e164: null, bsuid: 'BS_123', profile_name: 'Anon', optInStatus: 'opted_in' },
    ];
    const { recipients } = buildRecipients('marketing', mapping, withBsuid);
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({ contactId: 'b1', toE164: 'BS_123' });
  });

  it('numéro prioritaire sur le BSUID ; dédup par identité', () => {
    const mixed: BuildContact[] = [
      { id: 'p1', phone_e164: '+33699999999', bsuid: 'BS_A', profile_name: 'A', optInStatus: 'opted_in' },
      { id: 'b2', phone_e164: null, bsuid: 'BS_B', profile_name: 'B', optInStatus: 'opted_in' },
      { id: 'b3', phone_e164: null, bsuid: 'BS_B', profile_name: 'Doublon BSUID', optInStatus: 'opted_in' },
    ];
    const { recipients } = buildRecipients('marketing', mapping, mixed);
    expect(recipients.map((x) => x.toE164)).toEqual(['+33699999999', 'BS_B']); // p1 par numéro, b3 = doublon de b2
  });

  it('variable manquante (prénom absent) -> destinataire SAUTÉ + recensé dans skipped (jamais un envoi vide)', () => {
    const prenom: TemplateParam[] = [{ position: 1, source: { type: 'field', key: 'prenom' } }];
    const list: BuildContact[] = [
      { id: 'ok', phone_e164: '+33611111111', fields: { prenom: 'Marie' }, optInStatus: 'opted_in' },
      { id: 'ko', phone_e164: '+33622222222', fields: {}, optInStatus: 'opted_in' },
    ];
    const { recipients, skipped } = buildRecipients('marketing', prenom, list);
    expect(recipients.map((x) => x.contactId)).toEqual(['ok']);
    expect(recipients[0]?.resolvedParams).toEqual(['Marie']);
    expect(skipped).toEqual([{ contactId: 'ko', toE164: '+33622222222', reason: 'missing_variable', missing: [1] }]);
  });
});
