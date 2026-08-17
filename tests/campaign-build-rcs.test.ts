import { describe, it, expect } from 'vitest';
import { buildRecipients } from '../src/campaign/build';
import type { BuildContact } from '../src/campaign/build';

const avecNumero: BuildContact = { id: 'c1', phone_e164: '+33611', profile_name: 'A', fields: {}, optInStatus: 'opted_in' };
const bsuidSeul: BuildContact = { id: 'c2', phone_e164: null, bsuid: 'BSUID_xyz', profile_name: 'B', fields: {}, optInStatus: 'opted_in' } as BuildContact;

describe('buildRecipients sur le canal RCS', () => {
  it('ECARTE un contact identifie seulement par BSUID, avec son motif', () => {
    const r = buildRecipients('marketing', [], [avecNumero, bsuidSeul], undefined, 'rcs');
    expect(r.recipients.map((x) => x.contactId)).toEqual(['c1']);
    expect(r.skipped).toEqual([{ contactId: 'c2', toE164: 'BSUID_xyz', reason: 'no_phone_number' }]);
  });

  it('garde le BSUID sur WhatsApp : c est une identite valide la-bas', () => {
    const r = buildRecipients('marketing', [], [avecNumero, bsuidSeul], undefined, 'whatsapp');
    expect(r.recipients.map((x) => x.contactId)).toEqual(['c1', 'c2']);
    expect(r.skipped).toEqual([]);
  });

  it('sans canal explicite, comportement historique inchange (WhatsApp)', () => {
    const r = buildRecipients('marketing', [], [avecNumero, bsuidSeul]);
    expect(r.recipients).toHaveLength(2);
  });
});
