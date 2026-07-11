import { slugify } from '../crm/fields';
import type { UserFieldType } from '../crm/types';

/** Id de l'écran d'entrée du flow. Le bouton FLOW du template pointe cet écran via `navigate_screen`
 *  (vérifié live : c'est l'id d'écran, PAS un mot réservé type FIRST_ENTRY_SCREEN). */
export const FLOW_ENTRY_SCREEN = 'FORM';

export type FlowFieldType = 'text' | 'email' | 'phone' | 'number' | 'textarea' | 'date';

export const FLOW_FIELD_TYPES: readonly FlowFieldType[] = ['text', 'email', 'phone', 'number', 'textarea', 'date'];
export function isFlowFieldType(t: unknown): t is FlowFieldType {
  return typeof t === 'string' && (FLOW_FIELD_TYPES as readonly string[]).includes(t);
}

/**
 * Convertit un type de champ Flow vers le type de user field du contact. Les types Flow `email`/`phone`/
 * `textarea` n'existent PAS dans UserFieldType (`text|number|date|boolean|url`) : sans cette normalisation,
 * `ensureField` lève « type de champ invalide » -> 500 sur le mapping par défaut d'un champ email/téléphone.
 */
export function flowFieldToUserFieldType(t: FlowFieldType): UserFieldType {
  if (t === 'number') return 'number';
  if (t === 'date') return 'date';
  return 'text'; // text | email | phone | textarea -> text
}

export interface FlowFieldInput {
  label: string;
  type: FlowFieldType;
  required: boolean;
}

/** Champ avec sa clé dérivée (slug du libellé). La clé sert de `name` du composant + de clé du payload. */
export interface FlowField extends FlowFieldInput {
  key: string;
}

/** Deux libellés distincts donnent la même clé slugifiée (ex. "Nom" / " nom "). */
export class DuplicateFieldKeyError extends Error {
  constructor(
    public readonly labelA: string,
    public readonly labelB: string,
    public readonly key: string,
  ) {
    super(`libellés « ${labelA} » et « ${labelB} » donnent la même clé « ${key} »`);
    this.name = 'DuplicateFieldKeyError';
  }
}

// --- Flow RICHE (phase 3) : éléments texte / image / champ dans l'ordre, + discriminant _ref ---

/** Clé de payload réservée au discriminant du flow (slugify strippe les `_` de tête -> pas de collision). */
export const FLOW_REF_KEY = '_ref';

export type FlowTextKind = 'heading' | 'subheading' | 'body' | 'caption';
export interface FlowTextEl { kind: FlowTextKind; text: string }
/** Image = base64 BRUT (sans préfixe data-URL), vérifié live. Pas le chemin carousel (media handle). */
export interface FlowImageEl { kind: 'image'; src: string }
export interface FlowFieldElInput extends FlowFieldInput { kind: 'field' }
export type FlowElementInput = FlowTextEl | FlowImageEl | FlowFieldElInput;
export interface FlowFieldEl extends FlowField { kind: 'field' }
export type FlowElement = FlowTextEl | FlowImageEl | FlowFieldEl;

export const FLOW_TEXT_KINDS: readonly FlowTextKind[] = ['heading', 'subheading', 'body', 'caption'];

/** Dérive les clés des éléments de type `field` (les autres passent tels quels). Collision -> erreur. */
export function deriveElements(elements: FlowElementInput[]): FlowElement[] {
  const byKey = new Map<string, string>();
  return elements.map((el) => {
    if (el.kind !== 'field') return el;
    const key = slugify(el.label);
    const prev = byKey.get(key);
    if (prev !== undefined) throw new DuplicateFieldKeyError(prev, el.label, key);
    byKey.set(key, el.label);
    return { ...el, key };
  });
}

/** Extrait les champs (kind='field') d'une liste d'éléments -> réutilisable pour FlowRow.fields + mapping. */
export function fieldsOf(elements: FlowElement[]): FlowField[] {
  return elements.filter((e): e is FlowFieldEl => e.kind === 'field').map(({ label, type, required, key }) => ({ label, type, required, key }));
}

const TEXT_COMPONENT: Record<FlowTextKind, string> = {
  heading: 'TextHeading',
  subheading: 'TextSubheading',
  body: 'TextBody',
  caption: 'TextCaption',
};

/** Composant Flow JSON d'un élément riche (texte / image / champ). */
function elementComponent(el: FlowElement): Record<string, unknown> {
  if (el.kind === 'image') return { type: 'Image', src: el.src, height: 200, 'scale-type': 'contain' };
  if (el.kind !== 'field') return { type: TEXT_COMPONENT[el.kind], text: el.text };
  return componentFor(el);
}

/**
 * Construit le flow_json RICHE : un écran terminal, éléments (texte/image/champ) dans l'ordre + Footer
 * `complete` dont le payload renvoie chaque champ (`${form.<key>}`) ET une constante `_ref` (discriminant
 * pour identifier le flow au retour du nfm_reply). Pur et déterministe. `ref` figé à la création.
 */
export function buildFlowElements(name: string, elements: FlowElement[], version: string, ref: string): Record<string, unknown> {
  const payload: Record<string, string> = {};
  for (const f of fieldsOf(elements)) payload[f.key] = `\${form.${f.key}}`;
  payload[FLOW_REF_KEY] = ref;
  return {
    version,
    screens: [
      {
        id: FLOW_ENTRY_SCREEN,
        title: name.slice(0, 30) || 'Formulaire',
        terminal: true,
        success: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [...elements.map(elementComponent), { type: 'Footer', label: 'Envoyer', 'on-click-action': { name: 'complete', payload } }],
        },
      },
    ],
  };
}

/** Composant Flow JSON d'un champ selon son type. */
function componentFor(f: FlowField): Record<string, unknown> {
  if (f.type === 'textarea') return { type: 'TextArea', name: f.key, label: f.label, required: f.required };
  if (f.type === 'date') return { type: 'DatePicker', name: f.key, label: f.label, required: f.required };
  const inputType = f.type; // text | email | phone | number -> input-type TextInput
  return { type: 'TextInput', name: f.key, label: f.label, 'input-type': inputType, required: f.required };
}
