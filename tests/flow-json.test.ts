import { describe, it, expect } from 'vitest';
import { deriveFieldKeys, buildFlowJson, DuplicateFieldKeyError, isFlowFieldType } from '../src/meta/flow-json';
import type { FlowFieldInput } from '../src/meta/flow-json';

describe('deriveFieldKeys', () => {
  it('slugifie chaque libellé (accents/casse/séparateurs), ordre préservé', () => {
    const fields: FlowFieldInput[] = [
      { label: 'Nom complet', type: 'text', required: true },
      { label: 'Adresse e-mail', type: 'email', required: true },
      { label: 'Téléphone', type: 'phone', required: false },
    ];
    const out = deriveFieldKeys(fields);
    expect(out.map((f) => f.key)).toEqual(['nom_complet', 'adresse_e_mail', 'telephone']);
    expect(out.map((f) => f.label)).toEqual(['Nom complet', 'Adresse e-mail', 'Téléphone']); // ordre + labels intacts
  });

  it('collision de clés -> DuplicateFieldKeyError (pas de fusion silencieuse)', () => {
    const fields: FlowFieldInput[] = [
      { label: 'Nom', type: 'text', required: true },
      { label: ' nom ', type: 'text', required: false }, // slug identique -> "nom"
    ];
    expect(() => deriveFieldKeys(fields)).toThrow(DuplicateFieldKeyError);
  });

  it('isFlowFieldType', () => {
    expect(isFlowFieldType('email')).toBe(true);
    expect(isFlowFieldType('checkbox')).toBe(false);
    expect(isFlowFieldType(42)).toBe(false);
  });
});

describe('buildFlowJson', () => {
  const fields = deriveFieldKeys([
    { label: 'Nom', type: 'text', required: true },
    { label: 'Email', type: 'email', required: true },
    { label: 'Téléphone', type: 'phone', required: false },
    { label: 'Âge', type: 'number', required: false },
    { label: 'Message', type: 'textarea', required: false },
    { label: 'Date de naissance', type: 'date', required: false },
  ]);

  it('un écran terminal, mapping composant par type, Footer en dernier', () => {
    const j = buildFlowJson('Contact', fields, '7.2') as any;
    expect(j.version).toBe('7.2');
    const screen = j.screens[0];
    expect(screen.terminal).toBe(true);
    expect(screen.layout.type).toBe('SingleColumnLayout');
    const kids = screen.layout.children;
    // un composant par champ + le Footer
    expect(kids).toHaveLength(fields.length + 1);
    expect(kids[0]).toMatchObject({ type: 'TextInput', name: 'nom', 'input-type': 'text', required: true });
    expect(kids[1]).toMatchObject({ type: 'TextInput', name: 'email', 'input-type': 'email' });
    expect(kids[2]).toMatchObject({ type: 'TextInput', name: 'telephone', 'input-type': 'phone', required: false });
    expect(kids[3]).toMatchObject({ type: 'TextInput', name: 'age', 'input-type': 'number' });
    expect(kids[4]).toMatchObject({ type: 'TextArea', name: 'message' });
    expect(kids[5]).toMatchObject({ type: 'DatePicker', name: 'date_de_naissance' });
    expect(kids[kids.length - 1].type).toBe('Footer');
  });

  it("le Footer complète avec ${form.<key>} pour CHAQUE champ", () => {
    const j = buildFlowJson('Contact', fields, '7.2') as any;
    const footer = j.screens[0].layout.children.at(-1);
    expect(footer['on-click-action'].name).toBe('complete');
    const payload = footer['on-click-action'].payload;
    for (const f of fields) expect(payload[f.key]).toBe('${form.' + f.key + '}');
  });

  it('required se propage fidèlement', () => {
    const j = buildFlowJson('X', fields, '7.2') as any;
    const kids = j.screens[0].layout.children;
    expect(kids[0].required).toBe(true); // Nom
    expect(kids[2].required).toBe(false); // Téléphone
  });

  it('déterministe (même entrée -> JSON strictement identique)', () => {
    const a = JSON.stringify(buildFlowJson('Contact', fields, '7.2'));
    const b = JSON.stringify(buildFlowJson('Contact', fields, '7.2'));
    expect(a).toBe(b);
  });
});

import { deriveElements, fieldsOf, buildFlowElements, FLOW_REF_KEY, type FlowElementInput } from '../src/meta/flow-json';

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
