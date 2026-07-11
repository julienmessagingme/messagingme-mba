import { describe, it, expect } from 'vitest';
import { extractFlowCompletions } from '../src/webhooks/inbound';
import { processFlowCompletions } from '../src/webhooks/flow-mapping';
import type { FlowMappingLookup, ContactFieldWriter } from '../src/webhooks/flow-mapping';

function nfm(responseJson: unknown, opts: { from?: string; contacts?: unknown[]; phoneNumberId?: string } = {}) {
  return {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: opts.phoneNumberId ?? 'pn1' },
              contacts: opts.contacts,
              messages: [
                {
                  id: 'wamid.f1',
                  ...(opts.from ? { from: opts.from } : {}),
                  type: 'interactive',
                  interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow_x', response_json: typeof responseJson === 'string' ? responseJson : JSON.stringify(responseJson) } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('extractFlowCompletions', () => {
  it('parse response_json, isole _ref, retire _ref des values', () => {
    const r = extractFlowCompletions(nfm({ _ref: 'REF123', nom: 'Marc', date_rdv: '2026-08-01', flow_token: 'tok' }, { from: '33611' }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ waId: '33611', ref: 'REF123' });
    expect(r[0]!.values).toEqual({ nom: 'Marc', date_rdv: '2026-08-01', flow_token: 'tok' }); // _ref retiré, le reste conservé
    expect(r[0]!.values).not.toHaveProperty('_ref');
  });

  it('sans _ref -> ignoré (flow hors de notre générateur)', () => {
    expect(extractFlowCompletions(nfm({ nom: 'Marc' }, { from: '33611' }))).toHaveLength(0);
  });

  it('response_json illisible -> ignoré, ne lève pas', () => {
    expect(extractFlowCompletions(nfm('{pas du json', { from: '33611' }))).toHaveLength(0);
  });

  it('BSUID : from absent -> fallback contacts[].wa_id', () => {
    const r = extractFlowCompletions(nfm({ _ref: 'R', nom: 'X' }, { contacts: [{ wa_id: '33622' }] }));
    expect(r[0]).toMatchObject({ waId: '33622', ref: 'R' });
  });

  it('message non-interactif -> ignoré', () => {
    const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' }, messages: [{ id: 'w', from: '33611', type: 'text', text: { body: 'hi' } }] } }] }] };
    expect(extractFlowCompletions(payload)).toHaveLength(0);
  });
});

class FakeLookup implements FlowMappingLookup {
  constructor(private readonly row: { tenantId: string; mapping: Record<string, string> } | null) {}
  async findByRef(): Promise<{ tenantId: string; mapping: Record<string, string> } | null> {
    return this.row;
  }
}
class FakeWriter implements ContactFieldWriter {
  readonly writes: Array<{ tenantId: string; waId: string; values: Record<string, unknown> }> = [];
  constructor(private readonly throwOnce = false) {}
  async mergeFieldsByPhone(tenantId: string, waId: string, values: Record<string, unknown>): Promise<void> {
    if (this.throwOnce && this.writes.length === 0) {
      this.writes.push({ tenantId, waId, values }); // marque la tentative pour ne throw qu'une fois
      throw new Error('db down');
    }
    this.writes.push({ tenantId, waId, values });
  }
}

describe('processFlowCompletions', () => {
  it('mappe clé champ -> clé user field et écrit sur le contact ; _ref/flow_token jamais écrits', async () => {
    const lookup = new FakeLookup({ tenantId: 't1', mapping: { nom: 'prenom', date_rdv: 'date_rendez_vous' } });
    const writer = new FakeWriter();
    await processFlowCompletions(nfm({ _ref: 'R', nom: 'Marc', date_rdv: '2026-08-01', flow_token: 'tok' }, { from: '33611' }), lookup, writer);
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]).toEqual({ tenantId: 't1', waId: '33611', values: { prenom: 'Marc', date_rendez_vous: '2026-08-01' } });
    expect(writer.writes[0]!.values).not.toHaveProperty('flow_token');
    expect(writer.writes[0]!.values).not.toHaveProperty('_ref');
  });

  it('ref inconnu (findByRef null) -> aucune écriture', async () => {
    const writer = new FakeWriter();
    await processFlowCompletions(nfm({ _ref: 'ghost', nom: 'X' }, { from: '33611' }), new FakeLookup(null), writer);
    expect(writer.writes).toHaveLength(0);
  });

  it('aucun champ mappé présent -> aucune écriture (pas de merge vide)', async () => {
    const writer = new FakeWriter();
    // le mapping cible 'email' mais la complétion ne renvoie que 'nom'
    await processFlowCompletions(nfm({ _ref: 'R', nom: 'X' }, { from: '33611' }), new FakeLookup({ tenantId: 't1', mapping: { email: 'email' } }), writer);
    expect(writer.writes).toHaveLength(0);
  });

  it('writer qui throw -> ISOLÉ, ne propage pas (le job statuts ne doit pas échouer)', async () => {
    const lookup = new FakeLookup({ tenantId: 't1', mapping: { nom: 'nom' } });
    const writer = new FakeWriter(true);
    await expect(
      processFlowCompletions(nfm({ _ref: 'R', nom: 'Marc' }, { from: '33611' }), lookup, writer),
    ).resolves.toBeUndefined(); // ne rejette pas
  });
});
