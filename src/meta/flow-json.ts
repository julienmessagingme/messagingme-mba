import { slugify } from '../crm/fields';

/** Id de l'écran d'entrée du flow. Le bouton FLOW du template pointe cet écran via `navigate_screen`
 *  (vérifié live : c'est l'id d'écran, PAS un mot réservé type FIRST_ENTRY_SCREEN). */
export const FLOW_ENTRY_SCREEN = 'FORM';

export type FlowFieldType = 'text' | 'email' | 'phone' | 'number' | 'textarea' | 'date';

export const FLOW_FIELD_TYPES: readonly FlowFieldType[] = ['text', 'email', 'phone', 'number', 'textarea', 'date'];
export function isFlowFieldType(t: unknown): t is FlowFieldType {
  return typeof t === 'string' && (FLOW_FIELD_TYPES as readonly string[]).includes(t);
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

/**
 * Dérive une clé stable par champ (slug du libellé, réutilise crm/fields.ts:slugify). Lève
 * DuplicateFieldKeyError sur collision : PAS de fusion silencieuse (contrairement à l'import CSV) —
 * une clé de formulaire qui disparaît en prod ne se découvre qu'après publication du flow, trop tard.
 */
export function deriveFieldKeys(fields: FlowFieldInput[]): FlowField[] {
  const byKey = new Map<string, string>(); // key -> premier label
  const out: FlowField[] = [];
  for (const f of fields) {
    const key = slugify(f.label);
    const prev = byKey.get(key);
    if (prev !== undefined) throw new DuplicateFieldKeyError(prev, f.label, key);
    byKey.set(key, f.label);
    out.push({ ...f, key });
  }
  return out;
}

/** Composant Flow JSON d'un champ selon son type. */
function componentFor(f: FlowField): Record<string, unknown> {
  if (f.type === 'textarea') return { type: 'TextArea', name: f.key, label: f.label, required: f.required };
  if (f.type === 'date') return { type: 'DatePicker', name: f.key, label: f.label, required: f.required };
  const inputType = f.type; // text | email | phone | number -> input-type TextInput
  return { type: 'TextInput', name: f.key, label: f.label, 'input-type': inputType, required: f.required };
}

/**
 * Construit le flow_json Meta : UN seul écran terminal, SingleColumnLayout, un composant par champ +
 * un Footer dont l'action `complete` renvoie chaque champ saisi (`${form.<key>}`). Pur et déterministe
 * (même entrée -> même sortie). Statique : pas d'endpoint, pas de data_api_version/routing_model.
 */
export function buildFlowJson(name: string, fields: FlowField[], version: string): Record<string, unknown> {
  const payload: Record<string, string> = {};
  for (const f of fields) payload[f.key] = `\${form.${f.key}}`;
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
          children: [...fields.map(componentFor), { type: 'Footer', label: 'Envoyer', 'on-click-action': { name: 'complete', payload } }],
        },
      },
    ],
  };
}
