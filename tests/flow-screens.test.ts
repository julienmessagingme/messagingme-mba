import { describe, it, expect } from 'vitest';
import {
  buildFlowScreens, buildFlowElements, deriveScreens, screensOf, fieldsOfScreens, screenId,
  DuplicateFieldKeyError, VisibleIfError, FLOW_REF_KEY,
} from '../src/meta/flow-json';
import type { FlowScreenInput } from '../src/meta/flow-json';

/**
 * Lot 7 : générateur multi-écrans + conditions de visibilité. Contrats SONDÉS LIVE (2026-07-17, WABA réel) :
 * ids d'écrans lettres+underscores UNIQUEMENT (chiffre rejeté), pas de routing_model sans endpoint, refs
 * globales ${screen.<ID>.form.<clé>} résolues dans les payloads d'action (PAS dans les textes), champ
 * masqué/vide OMIS du payload complete.
 */

const twoScreens: FlowScreenInput[] = [
  {
    title: 'Étape 1',
    elements: [
      { kind: 'heading', text: 'Vos coordonnées' },
      { kind: 'field', label: 'Prénom', type: 'text', required: true },
    ],
  },
  {
    elements: [
      { kind: 'field', label: 'Email', type: 'email', required: true },
    ],
  },
];

describe('screenId', () => {
  it('FORM (figé, templates approuvés) puis FORM_B, FORM_C… — lettres+underscores uniquement (sonde : chiffre REJETÉ)', () => {
    expect(screenId(0)).toBe('FORM');
    expect(screenId(1)).toBe('FORM_B');
    expect(screenId(2)).toBe('FORM_C');
    expect(screenId(9)).toBe('FORM_J');
    for (let i = 0; i < 10; i += 1) expect(screenId(i)).toMatch(/^[A-Z_]+$/);
  });
});

describe('buildFlowScreens (multi-écrans)', () => {
  const fj = buildFlowScreens('Contact', deriveScreens(twoScreens), '7.2', 'ref-1', 'Valider') as {
    version: string;
    routing_model?: unknown;
    screens: Array<{
      id: string; title: string; terminal?: boolean; success?: boolean; data: unknown;
      layout: { children: Array<Record<string, unknown>> };
    }>;
  };

  it('2 écrans, ids FORM/FORM_B, PAS de routing_model (facultatif sans endpoint, sondé 7.2/7.3)', () => {
    expect(fj.version).toBe('7.2');
    expect(fj.routing_model).toBeUndefined();
    expect(fj.screens.map((s) => s.id)).toEqual(['FORM', 'FORM_B']);
  });

  it('écran intermédiaire : Footer navigate -> écran suivant, payload {} (refs globales, pas de data-passing), label Continuer', () => {
    const footer = fj.screens[0]!.layout.children.at(-1)! as { type: string; label: string; 'on-click-action': { name: string; next: { type: string; name: string }; payload: unknown } };
    expect(footer.type).toBe('Footer');
    expect(footer.label).toBe('Continuer');
    expect(footer['on-click-action'].name).toBe('navigate');
    expect(footer['on-click-action'].next).toEqual({ type: 'screen', name: 'FORM_B' });
    expect(footer['on-click-action'].payload).toEqual({});
    expect(fj.screens[0]!.terminal).toBeUndefined(); // seul le dernier écran est terminal
  });

  it('écran final : terminal+success, Footer complete AGRÈGE tout — ${screen.FORM.form.x} (écran 1) + ${form.y} (dernier) + _ref', () => {
    const last = fj.screens[1]!;
    expect(last.terminal).toBe(true);
    expect(last.success).toBe(true);
    const footer = last.layout.children.at(-1)! as { label: string; 'on-click-action': { name: string; payload: Record<string, string> } };
    expect(footer.label).toBe('Valider');
    expect(footer['on-click-action'].name).toBe('complete');
    expect(footer['on-click-action'].payload).toEqual({
      prenom: '${screen.FORM.form.prenom}',
      email: '${form.email}',
      [FLOW_REF_KEY]: 'ref-1',
    });
  });

  it('titre d\'écran : celui de l\'écran, sinon le nom du flow ; cta intermédiaire par écran', () => {
    expect(fj.screens[0]!.title).toBe('Étape 1');
    expect(fj.screens[1]!.title).toBe('Contact');
    const withCta = buildFlowScreens('X', deriveScreens([
      { cta: 'Étape suivante', elements: [{ kind: 'field', label: 'A', type: 'text', required: false }] },
      { elements: [{ kind: 'field', label: 'B', type: 'text', required: false }] },
    ]), '7.2', 'r') as typeof fj;
    const footer = withCta.screens[0]!.layout.children.at(-1)! as { label: string };
    expect(footer.label).toBe('Étape suivante');
  });

  it('déterminisme : deux générations identiques', () => {
    const a = JSON.stringify(buildFlowScreens('C', deriveScreens(twoScreens), '7.2', 'r'));
    const b = JSON.stringify(buildFlowScreens('C', deriveScreens(twoScreens), '7.2', 'r'));
    expect(a).toBe(b);
  });

  it('mono-écran via buildFlowScreens === buildFlowElements (wrapper, non-régression du généré)', () => {
    const els = deriveScreens([{ elements: [{ kind: 'field', label: 'Nom', type: 'text', required: true }] }])[0]!.elements;
    expect(JSON.stringify(buildFlowScreens('F', [{ elements: els }], '7.2', 'r', 'Go')))
      .toBe(JSON.stringify(buildFlowElements('F', els, '7.2', 'r', 'Go')));
  });
});

describe('deriveScreens : unicité GLOBALE des clés + visibleIf', () => {
  it('collision de clés INTER-écrans -> DuplicateFieldKeyError (payload complete et mapping sont plats)', () => {
    expect(() => deriveScreens([
      { elements: [{ kind: 'field', label: 'Nom', type: 'text', required: true }] },
      { elements: [{ kind: 'field', label: ' nom ', type: 'text', required: true }] },
    ])).toThrow(DuplicateFieldKeyError);
  });

  it('visibleIf résolu : libellé source -> clé dérivée (fieldKey)', () => {
    const [s] = deriveScreens([{
      elements: [
        { kind: 'field', label: 'Rappel ?', type: 'radio', required: true, options: ['Oui', 'Non'] },
        { kind: 'field', label: 'Téléphone', type: 'phone', required: true, visibleIf: { field: 'Rappel ?', op: 'eq', value: 'Oui' } },
      ],
    }]);
    const tel = s!.elements[1]! as { visibleIf?: unknown };
    expect(tel.visibleIf).toEqual({ fieldKey: 'rappel', op: 'eq', value: 'Oui' });
  });

  it('source inconnue / située APRÈS / sur un AUTRE écran -> VisibleIfError', () => {
    const cond = { field: 'Rappel ?', op: 'eq' as const, value: 'Oui' };
    const radio = { kind: 'field' as const, label: 'Rappel ?', type: 'radio' as const, required: true, options: ['Oui', 'Non'] };
    // inconnue
    expect(() => deriveScreens([{ elements: [{ kind: 'field', label: 'T', type: 'text', required: false, visibleIf: cond }] }])).toThrow(VisibleIfError);
    // après
    expect(() => deriveScreens([{ elements: [{ kind: 'field', label: 'T', type: 'text', required: false, visibleIf: cond }, radio] }])).toThrow(VisibleIfError);
    // autre écran (V1 : même écran uniquement)
    expect(() => deriveScreens([
      { elements: [radio] },
      { elements: [{ kind: 'field', label: 'T', type: 'text', required: false, visibleIf: cond }] },
    ])).toThrow(VisibleIfError);
  });

  it('source non admissible (texte libre, checkbox multi) -> VisibleIfError ; valeur hors options -> VisibleIfError', () => {
    expect(() => deriveScreens([{
      elements: [
        { kind: 'field', label: 'Ville', type: 'text', required: false },
        { kind: 'field', label: 'T', type: 'text', required: false, visibleIf: { field: 'Ville', op: 'eq', value: 'Lyon' } },
      ],
    }])).toThrow(VisibleIfError);
    expect(() => deriveScreens([{
      elements: [
        { kind: 'field', label: 'Choix', type: 'checkbox', required: false, options: ['A', 'B'] },
        { kind: 'field', label: 'T', type: 'text', required: false, visibleIf: { field: 'Choix', op: 'eq', value: 'A' } },
      ],
    }])).toThrow(VisibleIfError);
    expect(() => deriveScreens([{
      elements: [
        { kind: 'field', label: 'Rappel ?', type: 'radio', required: true, options: ['Oui', 'Non'] },
        { kind: 'field', label: 'T', type: 'text', required: false, visibleIf: { field: 'Rappel ?', op: 'eq', value: 'Peut-être' } },
      ],
    }])).toThrow(VisibleIfError);
  });

  it('optin source : valeur booléenne exigée ; apostrophe dans la valeur refusée (expression non échappable)', () => {
    const optin = { kind: 'field' as const, label: 'Consentement', type: 'optin' as const, required: false };
    expect(() => deriveScreens([{
      elements: [optin, { kind: 'field', label: 'T', type: 'text', required: false, visibleIf: { field: 'Consentement', op: 'eq', value: 'oui' } }],
    }])).toThrow(VisibleIfError);
    const [ok] = deriveScreens([{
      elements: [optin, { kind: 'field', label: 'T', type: 'text', required: false, visibleIf: { field: 'Consentement', op: 'eq', value: true } }],
    }]);
    expect((ok!.elements[1] as { visibleIf?: unknown }).visibleIf).toEqual({ fieldKey: 'consentement', op: 'eq', value: true });
    expect(() => deriveScreens([{
      elements: [
        { kind: 'field', label: 'Choix', type: 'radio', required: false, options: ["L'autre", 'B'] },
        { kind: 'field', label: 'T', type: 'text', required: false, visibleIf: { field: 'Choix', op: 'eq', value: "L'autre" } },
      ],
    }])).toThrow(VisibleIfError);
  });
});

describe('génération de la propriété visible (backticks v6.0+, sondée en 7.2)', () => {
  it('radio eq/neq -> `${form.clé} == \'Option\'` ; optin -> booléen nu ; posée sur textes ET champs', () => {
    const screens = deriveScreens([{
      elements: [
        { kind: 'field', label: 'Rappel ?', type: 'radio', required: true, options: ['Oui', 'Non'] },
        { kind: 'body', text: 'On te rappelle vite', visibleIf: { field: 'Rappel ?', op: 'eq', value: 'Oui' } },
        { kind: 'field', label: 'Téléphone', type: 'phone', required: true, visibleIf: { field: 'Rappel ?', op: 'neq', value: 'Non' } },
        { kind: 'field', label: 'Consentement', type: 'optin', required: false },
        { kind: 'field', label: 'Email', type: 'email', required: false, visibleIf: { field: 'Consentement', op: 'eq', value: true } },
      ],
    }]);
    const fj = buildFlowScreens('X', screens, '7.2', 'r') as { screens: Array<{ layout: { children: Array<Record<string, unknown>> } }> };
    const children = fj.screens[0]!.layout.children;
    expect(children[1]!['visible']).toBe("`${form.rappel} == 'Oui'`");
    expect(children[2]!['visible']).toBe("`${form.rappel} != 'Non'`");
    expect(children[4]!['visible']).toBe('`${form.consentement} == true`');
    expect(children[0]!['visible']).toBeUndefined(); // pas de condition -> pas de propriété
    // Le payload complete référence AUSSI les champs conditionnels (omis par Meta s'ils sont masqués, sondé).
    const footer = children.at(-1)! as { 'on-click-action': { payload: Record<string, string> } };
    expect(footer['on-click-action'].payload['telephone']).toBe('${form.telephone}');
  });
});

describe('screensOf (normalisation de la colonne jsonb, AUCUNE migration)', () => {
  it('null/vide -> null (legacy) ; tableau plat -> 1 écran ; { screens } -> tel quel ; objet inconnu -> null', () => {
    expect(screensOf(null)).toBeNull();
    expect(screensOf(undefined)).toBeNull();
    expect(screensOf([])).toBeNull();
    const flat = [{ kind: 'field', label: 'Nom', type: 'text', required: true, key: 'nom' }];
    expect(screensOf(flat)).toEqual([{ elements: flat }]);
    const multi = { screens: [{ title: 'A', elements: flat }, { elements: [] }] };
    expect(screensOf(multi)).toEqual(multi.screens);
    expect(screensOf({})).toBeNull();
    expect(screensOf({ screens: [] })).toBeNull();
  });
});

describe('fieldsOfScreens', () => {
  it('aplati écran par écran, ordre préservé', () => {
    const screens = deriveScreens(twoScreens);
    expect(fieldsOfScreens(screens).map((f) => f.key)).toEqual(['prenom', 'email']);
  });
});
