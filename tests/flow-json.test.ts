import { describe, it, expect } from 'vitest';
import { deriveElements, fieldsOf, buildFlowElements, flowFieldToUserFieldType, DuplicateFieldKeyError, isFlowFieldType, FLOW_REF_KEY, type FlowElementInput } from '../src/meta/flow-json';
import { isUserFieldType } from '../src/crm/fields';

describe('isFlowFieldType', () => {
  it('reconnaît les types de champ valides, rejette le reste', () => {
    expect(isFlowFieldType('email')).toBe(true);
    expect(isFlowFieldType('date')).toBe(true);
    expect(isFlowFieldType('checkbox')).toBe(false);
    expect(isFlowFieldType(42)).toBe(false);
  });
});

describe('flowFieldToUserFieldType', () => {
  it('email/phone/textarea/text -> text ; number -> number ; date -> date', () => {
    expect(flowFieldToUserFieldType('email')).toBe('text');
    expect(flowFieldToUserFieldType('phone')).toBe('text');
    expect(flowFieldToUserFieldType('textarea')).toBe('text');
    expect(flowFieldToUserFieldType('text')).toBe('text');
    expect(flowFieldToUserFieldType('number')).toBe('number');
    expect(flowFieldToUserFieldType('date')).toBe('date');
  });

  it('renvoie TOUJOURS un UserFieldType valide (jamais un type que ensureField rejetterait)', () => {
    for (const t of ['text', 'email', 'phone', 'number', 'textarea', 'date'] as const) {
      expect(isUserFieldType(flowFieldToUserFieldType(t))).toBe(true);
    }
  });
});

describe('flow riche (elements + _ref)', () => {
  const input: FlowElementInput[] = [
    { kind: 'heading', text: 'Vos coordonnées' },
    { kind: 'body', text: 'On vous recontacte.' },
    { kind: 'image', src: 'BASE64DATA' },
    { kind: 'field', label: 'Nom', type: 'text', required: true },
    { kind: 'field', label: 'Email', type: 'email', required: false },
  ];

  it('deriveElements : ordre préservé, clés dérivées sur les champs seulement', () => {
    const els = deriveElements(input);
    expect(els.map((e) => e.kind)).toEqual(['heading', 'body', 'image', 'field', 'field']);
    expect(fieldsOf(els).map((f) => f.key)).toEqual(['nom', 'email']);
  });

  it('deriveElements : collision de clés de champ -> DuplicateFieldKeyError', () => {
    expect(() => deriveElements([{ kind: 'field', label: 'Nom', type: 'text', required: true }, { kind: 'field', label: ' nom ', type: 'text', required: false }])).toThrow(DuplicateFieldKeyError);
  });

  it('buildFlowElements : composants texte/image/champ dans l\'ordre + Footer complete', () => {
    const j = buildFlowElements('Contact', deriveElements(input), '7.2', 'flowREF1') as any;
    const kids = j.screens[0].layout.children;
    expect(kids[0]).toEqual({ type: 'TextHeading', text: 'Vos coordonnées' });
    expect(kids[1]).toEqual({ type: 'TextBody', text: 'On vous recontacte.' });
    expect(kids[2]).toMatchObject({ type: 'Image', src: 'BASE64DATA', 'scale-type': 'contain' });
    expect(kids[3]).toMatchObject({ type: 'TextInput', name: 'nom' });
    expect(kids.at(-1).type).toBe('Footer');
  });

  it('buildFlowElements : payload = chaque champ (${form.key}) + la constante _ref', () => {
    const j = buildFlowElements('Contact', deriveElements(input), '7.2', 'flowREF1') as any;
    const payload = j.screens[0].layout.children.at(-1)['on-click-action'].payload;
    expect(payload.nom).toBe('${form.nom}');
    expect(payload.email).toBe('${form.email}');
    expect(payload[FLOW_REF_KEY]).toBe('flowREF1');
  });

  it('buildFlowElements : déterministe', () => {
    const a = JSON.stringify(buildFlowElements('C', deriveElements(input), '7.2', 'r'));
    const b = JSON.stringify(buildFlowElements('C', deriveElements(input), '7.2', 'r'));
    expect(a).toBe(b);
  });
});
