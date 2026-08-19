import { describe, it, expect } from 'vitest';
import { actionOf } from '../src/workflow/engine';
import type { WorkflowNode } from '../src/workflow/graph';

/** Node « Envoi de mail » minimal, `data` opaque comme les autres types (cf. graph.ts : parseGraph ne le
 *  valide pas, actionOf lit défensivement). */
const node = (data: Record<string, unknown>): WorkflowNode => ({ id: 'n1', type: 'email', position: { x: 0, y: 0 }, data });

describe('node email : actionOf', () => {
  it('rend l’action sendEmail quand emailAccountId, templateId et un destinataire littéral sont fournis', () => {
    const a = actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'x@ex.fr' } }));
    expect(a).toEqual({ kind: 'sendEmail', emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'x@ex.fr' } });
  });

  it('rend l’action sendEmail quand le destinataire est une variable de champ', () => {
    const a = actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: { kind: 'field', field: 'email_pro' } }));
    expect(a).toEqual({ kind: 'sendEmail', emailAccountId: 'a1', templateId: 't1', to: { kind: 'field', field: 'email_pro' } });
  });

  it('rend null si emailAccountId manque', () => {
    expect(actionOf(node({ templateId: 't1', to: { kind: 'literal', value: 'x@ex.fr' } }))).toBeNull();
  });

  it('rend null si templateId manque', () => {
    expect(actionOf(node({ emailAccountId: 'a1', to: { kind: 'literal', value: 'x@ex.fr' } }))).toBeNull();
  });

  it('rend null si le destinataire est invalide (kind field avec un champ vide)', () => {
    expect(actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: { kind: 'field', field: '' } }))).toBeNull();
  });

  it('rend null si le destinataire est absent', () => {
    expect(actionOf(node({ emailAccountId: 'a1', templateId: 't1' }))).toBeNull();
  });

  it('rend null sur un bloc totalement vide (data = {})', () => {
    expect(actionOf(node({}))).toBeNull();
  });

  it('tolère les espaces autour des identifiants (trim) sans changer la validité', () => {
    const a = actionOf(node({ emailAccountId: '  a1  ', templateId: '  t1  ', to: { kind: 'literal', value: 'x@ex.fr' } }));
    expect(a).toEqual({ kind: 'sendEmail', emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'x@ex.fr' } });
  });
});
