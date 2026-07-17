import { describe, it, expect } from 'vitest';
import { collectNodes } from '../src/workflow/node-list';
import type { WorkflowRow } from '../src/workflow/store.pg';
import type { WorkflowNode } from '../src/workflow/graph';

function node(partial: Partial<WorkflowNode> & Pick<WorkflowNode, 'id' | 'type'>): WorkflowNode {
  return { position: { x: 0, y: 0 }, data: {}, ...partial };
}

function wf(id: string, name: string, nodes: WorkflowNode[]): WorkflowRow {
  return { id, tenantId: 't1', name, code: `scn_ab_${'0'.repeat(26)}`, graph: { nodes, edges: [] }, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
}

const CODE = 'nod_ab_0123456789ABCDEFGHJKMNPQRS'; // 26 chars ULID-like

describe('collectNodes', () => {
  it('aplati les nodes de tous les workflows, en conservant workflowId/name', () => {
    const rows = [
      wf('w1', 'Bienvenue', [node({ id: 'n1', type: 'template', data: { code: CODE, templateName: 'hello' } })]),
      wf('w2', 'Relance', [node({ id: 'n2', type: 'tag', data: { tag: 'chaud' } })]),
    ];
    const out = collectNodes(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ workflowId: 'w1', workflowName: 'Bienvenue', type: 'template', code: CODE, summary: 'hello' });
    expect(out[1]).toMatchObject({ workflowId: 'w2', workflowName: 'Relance', type: 'tag', summary: 'chaud' });
  });

  it('filtre par type quand il est fourni', () => {
    const rows = [
      wf('w1', 'Mix', [
        node({ id: 'n1', type: 'template', data: { templateName: 't' } }),
        node({ id: 'n2', type: 'flow', data: { flowName: 'f' } }),
        node({ id: 'n3', type: 'template', data: { templateName: 'u' } }),
      ]),
    ];
    const out = collectNodes(rows, 'template');
    expect(out).toHaveLength(2);
    expect(out.every((n) => n.type === 'template')).toBe(true);
  });

  it('code absent, malformé, ou d’un autre motif -> null (jamais fabriqué)', () => {
    const rows = [
      wf('w1', 'W', [
        node({ id: 'n1', type: 'inbox', data: {} }), // pas de code
        node({ id: 'n2', type: 'tag', data: { code: 'pas-un-code', tag: 'x' } }), // malformé
        node({ id: 'n3', type: 'tag', data: { code: 42, tag: 'y' } }), // pas une string
      ]),
    ];
    const out = collectNodes(rows);
    expect(out.map((n) => n.code)).toEqual([null, null, null]);
  });

  it('résumés dérivés par type, coercés et bornés (pas de throw sur data opaque)', () => {
    const rows = [
      wf('w1', 'W', [
        node({ id: 'n1', type: 'quick_message', data: { body: '  ligne1\n\n  ligne2  ' } }),
        // Forme RÉELLE produite par le builder : fieldLabel (affiché) + fieldKey + value.
        node({ id: 'n2', type: 'field', data: { fieldKey: 'ville', fieldLabel: 'Ville', value: 'Paris' } }),
        node({ id: 'n3', type: 'field', data: { fieldKey: 'consent', fieldLabel: 'Consentement' } }), // valeur absente
        node({ id: 'n4', type: 'flow', data: {} }), // rien
        node({ id: 'n5', type: 'template', data: { templateName: 'x'.repeat(300) } }), // borné
        node({ id: 'n6', type: 'field', data: { key: 'legacy_key', value: 'v' } }), // fallback très ancien
      ]),
    ];
    const out = collectNodes(rows);
    expect(out[0]!.summary).toBe('ligne1 ligne2');
    expect(out[1]!.summary).toBe('Ville = Paris');
    expect(out[2]!.summary).toBe('Consentement');
    expect(out[3]!.summary).toBe('');
    expect(out[4]!.summary.length).toBe(120);
    expect(out[5]!.summary).toBe('legacy_key = v');
  });

  it('liste vide si aucun workflow', () => {
    expect(collectNodes([])).toEqual([]);
  });
});
