import { describe, it, expect } from 'vitest';
import { buildWorkflowTemplateComponents } from '../src/workflow/template-send';
import { resolveHintParams } from '../src/crm/template';
import type { WorkflowButton } from '../src/workflow/engine';

// Le chemin RÉEL de prod (worker.ts) construit les components via buildWorkflowTemplateComponents : on teste CETTE
// fonction. Elle fournit N params (répare 132000) MAIS signale les positions manquantes -> le worker saute l'envoi
// (jamais `text:''` -> pas de 132012). L'exemple Meta = échantillon de design, JAMAIS envoyé comme vraie valeur.

const contact = { phone_e164: '+33611', profile_name: 'Marc', fields: { prenom: 'Léa', ville: 'Lyon' } };

function bodyOf(components: unknown[]): { type: string; text: string }[] {
  const body = components.find((c) => (c as { type?: string }).type === 'body') as { parameters?: Array<{ type: string; text: string }> } | undefined;
  return body?.parameters ?? [];
}

describe('resolveHintParams (colle les attributs du contact, longueur N exacte, signale les manquants)', () => {
  it('indice mappé -> valeur du contact, rien de manquant', () => {
    const out = resolveHintParams([{ position: 1, source: { type: 'field', key: 'prenom' } }], 1, contact);
    expect(out).toEqual({ values: ['Léa'], missing: [] });
  });
  it('indice mappé mais champ vide -> position MANQUANTE (pas l\'exemple, pas un envoi vide)', () => {
    const out = resolveHintParams([{ position: 1, source: { type: 'field', key: 'inexistant' } }], 1, contact);
    expect(out.missing).toEqual([1]);
  });
  it('positions NON mappées -> manquantes, mais toujours N valeurs', () => {
    const out = resolveHintParams([{ position: 1, source: { type: 'field', key: 'prenom' } }], 3, contact);
    expect(out.values).toHaveLength(3);
    expect(out.missing).toEqual([2, 3]);
  });
  it('attribute name -> profile_name', () => {
    const out = resolveHintParams([{ position: 1, source: { type: 'attribute', key: 'name' } }], 1, contact);
    expect(out).toEqual({ values: ['Marc'], missing: [] });
  });
  it('aucun hint -> N valeurs, N positions manquantes (le destinataire sera sauté, pas envoyé vide)', () => {
    expect(resolveHintParams([], 2, contact)).toEqual({ values: ['', ''], missing: [1, 2] });
  });
});

describe('buildWorkflowTemplateComponents (chemin envoi workflow)', () => {
  const qrButtons: WorkflowButton[] = [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Site' }, { type: 'QUICK_REPLY', text: 'Non' }];

  it('template à 1 variable mappée prenom -> 1 param body = prénom, aucun manquant', () => {
    const { components, missing } = buildWorkflowTemplateComponents({
      hints: [{ position: 1, source: { type: 'field', key: 'prenom' } }],
      varCount: 1, contact, buttons: [],
    });
    expect(bodyOf(components)).toEqual([{ type: 'text', text: 'Léa' }]);
    expect(missing).toEqual([]);
  });

  it('variables non résolues -> `missing` signalé (le worker saute l\'envoi, plus de 132000/132012)', () => {
    const { missing } = buildWorkflowTemplateComponents({ hints: [], varCount: 2, contact, buttons: [] });
    expect(missing).toEqual([1, 2]);
  });

  it('varCount=0 -> aucun component body, aucun manquant', () => {
    const { components, missing } = buildWorkflowTemplateComponents({ hints: [], varCount: 0, contact, buttons: [] });
    expect(components.find((x) => (x as { type?: string }).type === 'body')).toBeUndefined();
    expect(missing).toEqual([]);
  });

  it('payload contrôlé sur chaque quick-reply, en ignorant les boutons URL, index préservé', () => {
    const { components } = buildWorkflowTemplateComponents({ hints: [], varCount: 0, contact, buttons: qrButtons });
    const btns = components.filter((x) => (x as { type?: string }).type === 'button') as Array<{ index: string; parameters: Array<{ payload: string }> }>;
    expect(btns.map((b) => b.index)).toEqual(['0', '2']); // le bouton URL (index 1) est exclu
    expect(btns.map((b) => b.parameters[0]!.payload)).toEqual(['btn:0', 'btn:2']);
  });

  it('body AVANT boutons (ordre attendu par l\'API Cloud)', () => {
    const { components } = buildWorkflowTemplateComponents({
      hints: [{ position: 1, source: { type: 'field', key: 'prenom' } }],
      varCount: 1, contact, buttons: qrButtons,
    });
    const types = components.map((x) => (x as { type?: string }).type);
    expect(types.indexOf('body')).toBeLessThan(types.indexOf('button'));
  });

  // Campagne workflow, 1er template : les variables sont DÉJÀ résolues par contact -> explicitParams court-circuite
  // la résolution par hints (chemin identique aux campagnes template directes).
  it('explicitParams : utilise les valeurs fournies directement (aucune résolution par hints)', () => {
    const { components, missing } = buildWorkflowTemplateComponents({
      hints: [{ position: 1, source: { type: 'field', key: 'prenom' } }], // ignorés
      varCount: 1, contact, buttons: [], explicitParams: ['Valeur explicite'],
    });
    expect(bodyOf(components)).toEqual([{ type: 'text', text: 'Valeur explicite' }]);
    expect(missing).toEqual([]);
  });

  it('explicitParams avec une valeur vide -> position missing (l\'appelant saute, jamais text:\'\')', () => {
    const { missing } = buildWorkflowTemplateComponents({ hints: [], varCount: 2, contact, buttons: [], explicitParams: ['Léa', ''] });
    expect(missing).toEqual([2]);
  });

  it('explicitParams: [] -> aucun component body, aucun manquant', () => {
    const { components, missing } = buildWorkflowTemplateComponents({ hints: [], varCount: 0, contact, buttons: [], explicitParams: [] });
    expect(components.find((x) => (x as { type?: string }).type === 'body')).toBeUndefined();
    expect(missing).toEqual([]);
  });

  it('explicitParams : boutons quick-reply toujours ajoutés (payload contrôlé)', () => {
    const { components } = buildWorkflowTemplateComponents({ hints: [], varCount: 1, contact, buttons: qrButtons, explicitParams: ['X'] });
    const btns = components.filter((x) => (x as { type?: string }).type === 'button') as Array<{ index: string }>;
    expect(btns.map((b) => b.index)).toEqual(['0', '2']); // le bouton URL (index 1) est exclu
  });
});
