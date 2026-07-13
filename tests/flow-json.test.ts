import { describe, it, expect } from 'vitest';
import { deriveElements, fieldsOf, buildFlowElements, flowFieldToUserFieldType, DuplicateFieldKeyError, isFlowFieldType, FLOW_REF_KEY, type FlowElementInput } from '../src/meta/flow-json';
import { isUserFieldType } from '../src/crm/fields';

describe('isFlowFieldType', () => {
  it('reconnaît les types de champ valides (dont choix + optin), rejette le reste', () => {
    expect(isFlowFieldType('email')).toBe(true);
    expect(isFlowFieldType('date')).toBe(true);
    expect(isFlowFieldType('checkbox')).toBe(true);
    expect(isFlowFieldType('dropdown')).toBe(true);
    expect(isFlowFieldType('optin')).toBe(true);
    expect(isFlowFieldType('passcode')).toBe(true);
    expect(isFlowFieldType('foobar')).toBe(false);
    expect(isFlowFieldType(42)).toBe(false);
  });
});

describe('flowFieldToUserFieldType', () => {
  it('text-like -> text ; number -> number ; date -> date ; optin -> boolean', () => {
    expect(flowFieldToUserFieldType('email')).toBe('text');
    expect(flowFieldToUserFieldType('passcode')).toBe('text');
    expect(flowFieldToUserFieldType('dropdown')).toBe('text');
    expect(flowFieldToUserFieldType('checkbox')).toBe('text');
    expect(flowFieldToUserFieldType('number')).toBe('number');
    expect(flowFieldToUserFieldType('date')).toBe('date');
    expect(flowFieldToUserFieldType('optin')).toBe('boolean');
  });

  it('renvoie TOUJOURS un UserFieldType valide (jamais un type que ensureField rejetterait)', () => {
    for (const t of ['text', 'email', 'phone', 'number', 'passcode', 'textarea', 'date', 'dropdown', 'radio', 'checkbox', 'optin'] as const) {
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

describe('flow riche : nouveaux composants + bouton final', () => {
  function children(elements: FlowElementInput[], cta?: string): any[] {
    const j = buildFlowElements('F', deriveElements(elements), '7.2', 'r', cta) as any;
    return j.screens[0].layout.children;
  }

  it('choix -> Dropdown/RadioButtonsGroup/CheckboxGroup avec data-source [{id,title}]', () => {
    const kids = children([
      { kind: 'field', label: 'Ville', type: 'dropdown', required: true, options: ['Lyon', 'Nice'] },
      { kind: 'field', label: 'Canal', type: 'radio', required: false, options: ['Mail', 'SMS'] },
      { kind: 'field', label: 'Centres', type: 'checkbox', required: false, options: ['Sport', 'Ciné'] },
    ]);
    expect(kids[0]).toMatchObject({ type: 'Dropdown', name: 'ville', 'data-source': [{ id: 'Lyon', title: 'Lyon' }, { id: 'Nice', title: 'Nice' }] });
    expect(kids[1]).toMatchObject({ type: 'RadioButtonsGroup', name: 'canal' });
    expect(kids[2]).toMatchObject({ type: 'CheckboxGroup', name: 'centres' });
  });

  it('optin -> OptIn (pas de input-type) ; passcode -> TextInput input-type passcode', () => {
    const kids = children([
      { kind: 'field', label: 'J\'accepte', type: 'optin', required: true },
      { kind: 'field', label: 'Code', type: 'passcode', required: true },
    ]);
    expect(kids[0]).toMatchObject({ type: 'OptIn', name: 'j_accepte', required: true });
    expect(kids[0]['input-type']).toBeUndefined();
    expect(kids[1]).toMatchObject({ type: 'TextInput', name: 'code', 'input-type': 'passcode' });
  });

  it('bouton final : libellé personnalisé, défaut « Envoyer », tronqué à 30', () => {
    const withCta = children([{ kind: 'field', label: 'Nom', type: 'text', required: true }], 'Je réserve');
    expect(withCta.at(-1)).toMatchObject({ type: 'Footer', label: 'Je réserve' });
    const noCta = children([{ kind: 'field', label: 'Nom', type: 'text', required: true }]);
    expect(noCta.at(-1).label).toBe('Envoyer');
    const long = children([{ kind: 'field', label: 'Nom', type: 'text', required: true }], 'x'.repeat(50));
    expect(long.at(-1).label.length).toBe(30);
  });
});
