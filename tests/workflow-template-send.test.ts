import { describe, it, expect } from 'vitest';
import { buildWorkflowTemplateComponents } from '../src/workflow/template-send';
import { resolveHintParams } from '../src/crm/template';
import type { WorkflowButton } from '../src/workflow/engine';

// Le chemin RÉEL de prod (worker.ts) construit les components via buildWorkflowTemplateComponents : on teste CETTE
// fonction (pas un fake d'executor), justement le piège Lot 5. Elle corrige l'erreur 132000 en fournissant N params.

const contact = { phone_e164: '+33611', profile_name: 'Marc', fields: { prenom: 'Léa', ville: 'Lyon' } };

function bodyOf(components: unknown[]): { type: string; text: string }[] {
  const body = components.find((c) => (c as { type?: string }).type === 'body') as { parameters?: Array<{ type: string; text: string }> } | undefined;
  return body?.parameters ?? [];
}

describe('resolveHintParams (colle les attributs du contact, longueur N exacte)', () => {
  it('indice mappé -> valeur du contact', () => {
    const out = resolveHintParams([{ position: 1, source: { type: 'field', key: 'prenom' } }], 1, contact, ['exempleA']);
    expect(out).toEqual(['Léa']);
  });
  it('indice mappé mais champ vide -> repli sur l\'exemple', () => {
    const out = resolveHintParams([{ position: 1, source: { type: 'field', key: 'inexistant' } }], 1, contact, ['exempleA']);
    expect(out).toEqual(['exempleA']);
  });
  it('position NON mappée -> exemple du template, jamais moins de N', () => {
    const out = resolveHintParams([{ position: 1, source: { type: 'field', key: 'prenom' } }], 3, contact, ['e1', 'e2', 'e3']);
    expect(out).toEqual(['Léa', 'e2', 'e3']); // 3 valeurs exactement
  });
  it('attribute name -> profile_name', () => {
    const out = resolveHintParams([{ position: 1, source: { type: 'attribute', key: 'name' } }], 1, contact, []);
    expect(out).toEqual(['Marc']);
  });
  it('aucun hint, aucun exemple -> chaînes vides mais bien N valeurs', () => {
    expect(resolveHintParams([], 2, contact, [])).toEqual(['', '']);
  });
});

describe('buildWorkflowTemplateComponents (chemin envoi workflow)', () => {
  const qrButtons: WorkflowButton[] = [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Site' }, { type: 'QUICK_REPLY', text: 'Non' }];

  it('template à 1 variable mappée prenom -> 1 param body = prénom du contact', () => {
    const c = buildWorkflowTemplateComponents({
      hints: [{ position: 1, source: { type: 'field', key: 'prenom' } }],
      varCount: 1, contact, examples: ['exemple'], buttons: [],
    });
    expect(bodyOf(c)).toEqual([{ type: 'text', text: 'Léa' }]);
  });

  it('N params exacts même sans hints (répare 132000) : varCount=2 -> 2 params (exemples)', () => {
    const c = buildWorkflowTemplateComponents({ hints: [], varCount: 2, contact, examples: ['e1', 'e2'], buttons: [] });
    expect(bodyOf(c)).toHaveLength(2);
    expect(bodyOf(c)).toEqual([{ type: 'text', text: 'e1' }, { type: 'text', text: 'e2' }]);
  });

  it('varCount=0 -> aucun component body', () => {
    const c = buildWorkflowTemplateComponents({ hints: [], varCount: 0, contact, examples: [], buttons: [] });
    expect(c.find((x) => (x as { type?: string }).type === 'body')).toBeUndefined();
  });

  it('payload contrôlé sur chaque quick-reply, en ignorant les boutons URL, index préservé', () => {
    const c = buildWorkflowTemplateComponents({ hints: [], varCount: 0, contact, examples: [], buttons: qrButtons });
    const btns = c.filter((x) => (x as { type?: string }).type === 'button') as Array<{ index: string; parameters: Array<{ payload: string }> }>;
    expect(btns.map((b) => b.index)).toEqual(['0', '2']); // le bouton URL (index 1) est exclu
    expect(btns.map((b) => b.parameters[0]!.payload)).toEqual(['btn:0', 'btn:2']);
  });

  it('body AVANT boutons (ordre attendu par l\'API Cloud)', () => {
    const c = buildWorkflowTemplateComponents({
      hints: [{ position: 1, source: { type: 'field', key: 'prenom' } }],
      varCount: 1, contact, examples: ['x'], buttons: qrButtons,
    });
    const types = c.map((x) => (x as { type?: string }).type);
    expect(types.indexOf('body')).toBeLessThan(types.indexOf('button'));
  });
});
