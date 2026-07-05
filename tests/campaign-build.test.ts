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
    const r = buildRecipients('marketing', mapping, contacts);
    expect(r.map((x) => x.contactId)).toEqual(['c1']); // c2 non opt-in, c3 doublon, c4 sans tel
    expect(r[0]?.resolvedParams).toEqual(['Julie']);
  });

  it('utility : inclut les contacts sans opt-in explicite', () => {
    const r = buildRecipients('utility', mapping, contacts);
    expect(r.map((x) => x.contactId)).toEqual(['c1', 'c2']); // c3 doublon, c4 sans tel
  });
});
