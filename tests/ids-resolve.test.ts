import { describe, it, expect } from 'vitest';
import { resolveScenario, resolveNode, resolveFieldKey } from '../src/ids/resolve';
import type { WorkflowLister, FieldLister } from '../src/ids/resolve';
import type { WorkflowGraph } from '../src/workflow/graph';
import type { UserFieldDef } from '../src/crm/types';

const g = (nodes: WorkflowGraph['nodes'] = []): WorkflowGraph => ({ nodes, edges: [] });
function wfLister(rows: Array<{ id: string; name: string; code?: string | null; graph?: WorkflowGraph }>): WorkflowLister {
  return { list: async () => rows.map((r) => ({ id: r.id, name: r.name, code: r.code ?? null, graph: r.graph ?? g() })) };
}
const fieldLister = (defs: UserFieldDef[]): FieldLister => ({ list: async () => defs });

describe('resolveScenario', () => {
  it('par code scn_ exact', async () => {
    const r = await resolveScenario('t1', 'scn_ab_X', wfLister([{ id: 'w1', name: 'Onb', code: 'scn_ab_X' }]));
    expect(r).toMatchObject({ ok: true, value: { id: 'w1', name: 'Onb' } });
  });
  it('code scn_ introuvable -> not_found', async () => {
    const r = await resolveScenario('t1', 'scn_ab_MISS', wfLister([{ id: 'w1', name: 'Onb', code: 'scn_ab_X' }]));
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });
  it('par nom (insensible casse)', async () => {
    const r = await resolveScenario('t1', '  onboarding ', wfLister([{ id: 'w1', name: 'Onboarding' }]));
    expect(r).toMatchObject({ ok: true, value: { id: 'w1' } });
  });
  it('nom ambigu (2 workflows même nom) -> ambiguous', async () => {
    const r = await resolveScenario('t1', 'Relance', wfLister([{ id: 'w1', name: 'Relance' }, { id: 'w2', name: 'relance' }]));
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'ambiguous') expect(r.matches).toHaveLength(2);
    else throw new Error('attendu ambiguous');
  });
  it('nom introuvable -> not_found', async () => {
    expect(await resolveScenario('t1', 'X', wfLister([{ id: 'w1', name: 'Y' }]))).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('resolveNode', () => {
  it('scanne les graphes, trouve le node par data.code', async () => {
    const graph = g([{ id: 'n2', type: 'tag', position: { x: 0, y: 0 }, data: { code: 'nod_ab_Y', tag: 'x' } }]);
    const r = await resolveNode('t1', 'nod_ab_Y', wfLister([{ id: 'w1', name: 'W', graph }]));
    expect(r).toMatchObject({ ok: true, value: { workflowId: 'w1', nodeId: 'n2' } });
  });
  it('code non nod_ -> not_found direct', async () => {
    expect(await resolveNode('t1', 'scn_ab_X', wfLister([]))).toEqual({ ok: false, reason: 'not_found' });
  });
  it('nod_ absent des graphes -> not_found', async () => {
    expect(await resolveNode('t1', 'nod_ab_MISS', wfLister([{ id: 'w1', name: 'W', graph: g() }]))).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('resolveFieldKey', () => {
  const defs: UserFieldDef[] = [
    { key: 'ville', label: 'Ville', type: 'text', code: 'fld_ab_VILLE' },
    { key: 'consent', label: 'Consentement', type: 'boolean', code: 'fld_ab_CONS' },
  ];
  it('champ système _sys_ résolu sans DB', async () => {
    const r = await resolveFieldKey('t1', 'fld_ab_sys_email', fieldLister([]));
    expect(r).toEqual({ ok: true, key: 'email', type: 'text', known: true });
  });
  it('_sys_ clé inconnue -> not_found', async () => {
    expect(await resolveFieldKey('t1', 'fld_ab_sys_pasunchamp', fieldLister([]))).toEqual({ ok: false, reason: 'not_found' });
  });
  it('par code fld_ existant / absent', async () => {
    expect(await resolveFieldKey('t1', 'fld_ab_CONS', fieldLister(defs))).toEqual({ ok: true, key: 'consent', type: 'boolean', known: true });
    expect(await resolveFieldKey('t1', 'fld_ab_MISS', fieldLister(defs))).toEqual({ ok: false, reason: 'not_found' });
  });
  it('par clé technique existante -> connue', async () => {
    expect(await resolveFieldKey('t1', 'ville', fieldLister(defs))).toEqual({ ok: true, key: 'ville', type: 'text', known: true });
  });
  it('clé inconnue -> known:false (auto-création amont), clé slugifiée, type texte', async () => {
    expect(await resolveFieldKey('t1', 'Code Postal', fieldLister(defs))).toEqual({ ok: true, key: 'code_postal', type: 'text', known: false });
  });
});
