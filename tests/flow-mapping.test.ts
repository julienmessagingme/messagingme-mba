import { describe, it, expect } from 'vitest';
import { extractFlowCompletions } from '../src/webhooks/inbound';
import { processFlowCompletions } from '../src/webhooks/flow-mapping';
import type { FlowMappingLookup, ContactFieldWriter } from '../src/webhooks/flow-mapping';
import type { FlowFieldType } from '../src/meta/flow-json';

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

interface LookupRow { tenantId: string; mapping: Record<string, string>; fieldTypes?: Record<string, FlowFieldType>; optinFieldKeys?: string[] }
class FakeLookup implements FlowMappingLookup {
  constructor(private readonly row: LookupRow | null) {}
  async findByRef(): Promise<{ tenantId: string; mapping: Record<string, string>; fieldTypes: Record<string, FlowFieldType>; optinFieldKeys: string[] } | null> {
    if (!this.row) return null;
    return { tenantId: this.row.tenantId, mapping: this.row.mapping, fieldTypes: this.row.fieldTypes ?? {}, optinFieldKeys: this.row.optinFieldKeys ?? [] };
  }
}
class FakeWriter implements ContactFieldWriter {
  readonly writes: Array<{ tenantId: string; waId: string; values: Record<string, unknown> }> = [];
  readonly optIns: Array<{ tenantId: string; waId: string; source: string }> = [];
  constructor(private readonly throwOnce = false) {}
  async mergeFieldsByPhone(tenantId: string, waId: string, values: Record<string, unknown>): Promise<void> {
    if (this.throwOnce && this.writes.length === 0) {
      this.writes.push({ tenantId, waId, values }); // marque la tentative pour ne throw qu'une fois
      throw new Error('db down');
    }
    this.writes.push({ tenantId, waId, values });
  }
  async markOptedIn(tenantId: string, waId: string, source: string): Promise<void> {
    this.optIns.push({ tenantId, waId, source });
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
    expect(writer.optIns).toHaveLength(0); // aucun champ optin -> pas de consentement
  });

  it('OptIn coché (true) -> champ booléen canonique « true » + markOptedIn(source=flow) une fois', async () => {
    const lookup = new FakeLookup({ tenantId: 't1', mapping: { consent: 'whatsapp_optin' }, fieldTypes: { consent: 'optin' }, optinFieldKeys: ['consent'] });
    const writer = new FakeWriter();
    await processFlowCompletions(nfm({ _ref: 'R', consent: true }, { from: '33611' }), lookup, writer);
    expect(writer.writes).toEqual([{ tenantId: 't1', waId: '33611', values: { whatsapp_optin: 'true' } }]);
    expect(writer.optIns).toEqual([{ tenantId: 't1', waId: '33611', source: 'flow' }]);
  });

  it('OptIn décoché (false) -> champ « false », markOptedIn JAMAIS appelé', async () => {
    const lookup = new FakeLookup({ tenantId: 't1', mapping: { consent: 'whatsapp_optin' }, fieldTypes: { consent: 'optin' }, optinFieldKeys: ['consent'] });
    const writer = new FakeWriter();
    await processFlowCompletions(nfm({ _ref: 'R', consent: false }, { from: '33611' }), lookup, writer);
    expect(writer.writes).toEqual([{ tenantId: 't1', waId: '33611', values: { whatsapp_optin: 'false' } }]);
    expect(writer.optIns).toHaveLength(0);
  });

  it('OptIn absent du payload -> ni champ ni consentement (le contact n\'a pas répondu à cet écran)', async () => {
    const lookup = new FakeLookup({ tenantId: 't1', mapping: { consent: 'whatsapp_optin', nom: 'prenom' }, fieldTypes: { consent: 'optin', nom: 'text' }, optinFieldKeys: ['consent'] });
    const writer = new FakeWriter();
    await processFlowCompletions(nfm({ _ref: 'R', nom: 'Marc' }, { from: '33611' }), lookup, writer);
    expect(writer.writes).toEqual([{ tenantId: 't1', waId: '33611', values: { prenom: 'Marc' } }]);
    expect(writer.optIns).toHaveLength(0);
  });

  it('DÉCOUPLAGE : un champ NON-optin dont la valeur vaut « true » n\'ouvre PAS le gate marketing', async () => {
    // Seul le composant OptIn de Meta a la portée « consentement ». Un champ texte « true » ne compte pas.
    const lookup = new FakeLookup({ tenantId: 't1', mapping: { agree: 'a_accepte' }, fieldTypes: { agree: 'text' }, optinFieldKeys: [] });
    const writer = new FakeWriter();
    await processFlowCompletions(nfm({ _ref: 'R', agree: 'true' }, { from: '33611' }), lookup, writer);
    expect(writer.writes).toEqual([{ tenantId: 't1', waId: '33611', values: { a_accepte: 'true' } }]);
    expect(writer.optIns).toHaveLength(0);
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
