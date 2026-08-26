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

  it('résumé du node email : les DEUX formes de `to`, et le compte des destinataires cachés', () => {
    const out = collectNodes([
      wf('w1', 'W', [
        // Ancienne forme OBJET : un bloc enregistré avant le 2026-08-25 doit rester lisible ici, sinon la
        // liste affiche un résumé vide sur un bloc qui envoie parfaitement.
        node({ id: 'n1', type: 'email', data: { to: { kind: 'literal', value: 'seul@ex.fr' } } }),
        node({ id: 'n2', type: 'email', data: { to: [{ kind: 'literal', value: 'un@ex.fr' }] } }),
        node({ id: 'n3', type: 'email', data: { to: [
          { kind: 'literal', value: 'un@ex.fr' },
          { kind: 'field', field: 'email_pro' },
          { kind: 'literal', value: 'trois@ex.fr' },
        ] } }),
        node({ id: 'n4', type: 'email', data: {} }), // non configuré
      ]),
    ]);
    expect(out[0]!.summary).toBe('Mail vers seul@ex.fr');
    expect(out[1]!.summary).toBe('Mail vers un@ex.fr');
    // Le 1er nommé (celui du « À »), les autres comptés : trois adresses entières déborderaient de la ligne.
    expect(out[2]!.summary).toBe('Mail vers un@ex.fr +2');
    expect(out[3]!.summary).toBe('');
  });

  it('résumé du node RCS : le texte du message, comme sur le canevas', () => {
    // Sans ce cas, `summarize` tombait sur `default` et rendait '' : « Contenu > Blocs » listait alors des
    // blocs RCS au résumé VIDE, indistinguables les uns des autres. Même incident que pour le bloc `wait`.
    const out = collectNodes([
      wf('w1', 'W', [
        node({ id: 'n1', type: 'rcs_message', data: { text: '  Bonjour\n\n  Julien  ' } }),
        node({ id: 'n2', type: 'rcs_message', data: {} }), // pas encore écrit -> vide, pas de placeholder
      ]),
    ]);
    expect(out[0]!.summary).toBe('Bonjour Julien');
    expect(out[1]!.summary).toBe('');
  });

  it('résumé du node QUESTION : la question, et le nombre de choix quand il y a un menu', () => {
    // Troisième bloc à risquer le résumé VIDE de la branche `default`, après `wait` et `rcs_message`. Les
    // lignes au libellé vide ne comptent pas : elles existent dans l'éditeur, pas pour le contact.
    const out = collectNodes([
      wf('w1', 'W', [
        node({ id: 'n1', type: 'question', data: { body: 'Quelle taille ?', rows: [{ title: 'S' }, { title: 'M' }] } }),
        node({ id: 'n2', type: 'question', data: { body: 'Ton code postal ?' } }),
        node({ id: 'n3', type: 'question', data: { body: 'Q', rows: [{ title: 'A' }, { title: '  ' }] } }),
        node({ id: 'n4', type: 'question', data: {} }),
        node({ id: 'n5', type: 'question', data: { body: 'Q', rows: 'pas un tableau' } }),
      ]),
    ]);
    expect(out[0]!.summary).toBe('Quelle taille ? (2 choix)');
    expect(out[1]!.summary).toBe('Ton code postal ?');
    expect(out[2]!.summary).toBe('Q (1 choix)');
    expect(out[3]!.summary).toBe('');
    expect(out[4]!.summary).toBe('Q');
  });

  it('résumé du node condition (combineur + pluriel), et data.clauses opaque -> pas de throw', () => {
    const rows = [
      wf('w1', 'W', [
        node({ id: 'n1', type: 'condition', data: { clauses: [] } }), // 0 clause
        node({ id: 'n2', type: 'condition', data: { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] } }), // 1, toutes
        node({ id: 'n3', type: 'condition', data: { match: 'any', clauses: [{ kind: 'tag' }, { kind: 'optin' }] } }), // 2, au moins une
        node({ id: 'n4', type: 'condition', data: { clauses: 'pas-un-array' } }), // opaque -> pas de throw
      ]),
    ];
    const out = collectNodes(rows);
    expect(out[0]!.summary).toBe('Condition');
    expect(out[1]!.summary).toBe('Si toutes de 1 condition');
    expect(out[2]!.summary).toBe('Si au moins une de 2 conditions');
    expect(out[3]!.summary).toBe('Condition');
  });

  it('extrait le nom libre du bloc (data.name) : trimé, espaces resserrés, borné 64, vide si absent', () => {
    const rows = [
      wf('w1', 'W', [
        node({ id: 'n1', type: 'tag', data: { tag: 'x', name: '  Relance   J+3  ' } }),
        node({ id: 'n2', type: 'tag', data: { tag: 'y' } }), // pas de nom
        node({ id: 'n3', type: 'tag', data: { tag: 'z', name: 'a'.repeat(100) } }), // borné
      ]),
    ];
    const out = collectNodes(rows);
    expect(out[0]!.name).toBe('Relance J+3');
    expect(out[1]!.name).toBe('');
    expect(out[2]!.name.length).toBe(64);
  });

  it('résumé du node action (4 sous-actions + set NOW)', () => {
    const rows = [
      wf('w1', 'W', [
        node({ id: 'n1', type: 'action', data: { actionKind: 'add_tag', tag: 'vip' } }),
        node({ id: 'n2', type: 'action', data: { actionKind: 'remove_tag', tag: 'vip' } }),
        node({ id: 'n3', type: 'action', data: { actionKind: 'set_field', fieldLabel: 'Ville', value: 'Lyon' } }),
        node({ id: 'n4', type: 'action', data: { actionKind: 'clear_field', fieldLabel: 'Ville' } }),
        node({ id: 'n5', type: 'action', data: { actionKind: 'set_field', fieldLabel: 'Vu', valueKind: 'now' } }),
      ]),
    ];
    const out = collectNodes(rows);
    expect(out[0]!.summary).toBe('+ vip');
    expect(out[1]!.summary).toBe('− vip');
    expect(out[2]!.summary).toBe('Ville = Lyon');
    expect(out[3]!.summary).toBe('Ville (vidé)');
    expect(out[4]!.summary).toBe('Vu = maintenant');
  });

  it('liste vide si aucun workflow', () => {
    expect(collectNodes([])).toEqual([]);
  });
});
