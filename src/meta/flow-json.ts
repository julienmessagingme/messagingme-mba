import { slugify } from '../crm/fields';
import type { UserFieldType } from '../crm/types';

/** Id de l'écran d'entrée du flow. Le bouton FLOW du template pointe cet écran via `navigate_screen`
 *  (vérifié live : c'est l'id d'écran, PAS un mot réservé type FIRST_ENTRY_SCREEN). */
export const FLOW_ENTRY_SCREEN = 'FORM';

export type FlowFieldType =
  | 'text' | 'email' | 'phone' | 'number' | 'passcode' // TextInput (input-type)
  | 'textarea' // TextArea
  | 'date' // DatePicker
  | 'dropdown' | 'radio' | 'checkbox' // choix à options (Dropdown / RadioButtonsGroup / CheckboxGroup)
  | 'optin'; // OptIn (consentement, booléen)

export const FLOW_FIELD_TYPES: readonly FlowFieldType[] = ['text', 'email', 'phone', 'number', 'passcode', 'textarea', 'date', 'dropdown', 'radio', 'checkbox', 'optin'];
export function isFlowFieldType(t: unknown): t is FlowFieldType {
  return typeof t === 'string' && (FLOW_FIELD_TYPES as readonly string[]).includes(t);
}

/** Types de champ Flow qui EXIGENT une liste d'options (data-source). */
export const CHOICE_FIELD_TYPES: readonly FlowFieldType[] = ['dropdown', 'radio', 'checkbox'];
export function isChoiceFieldType(t: FlowFieldType): boolean {
  return (CHOICE_FIELD_TYPES as readonly string[]).includes(t);
}

/**
 * Convertit un type de champ Flow vers le type de user field du contact. Les types Flow `email`/`phone`/
 * `textarea`/choix n'existent PAS dans UserFieldType (`text|number|date|boolean|url`) : sans cette
 * normalisation, `ensureField` lève « type de champ invalide » -> 500 sur le mapping par défaut.
 */
export function flowFieldToUserFieldType(t: FlowFieldType): UserFieldType {
  if (t === 'number') return 'number';
  if (t === 'date') return 'date';
  if (t === 'optin') return 'boolean';
  return 'text'; // text | email | phone | passcode | textarea | dropdown | radio | checkbox -> text
}

export interface FlowFieldInput {
  label: string;
  type: FlowFieldType;
  required: boolean;
  /** Options d'un champ de choix (dropdown/radio/checkbox). Ignoré pour les autres types. */
  options?: string[];
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

/**
 * Condition de visibilité d'un élément (Lot 7c). CÔTÉ INPUT, `field` = le LIBELLÉ du champ source (le front
 * ne connaît pas les clés dérivées) ; côté STOCKÉ, `fieldKey` = la clé dérivée (stable pour la génération).
 * V1 : source = dropdown/radio (valeur = libellé d'option, id==title) ou optin (booléen), sur le MÊME écran,
 * AVANT l'élément. Sondé live 2026-07-17 : un élément masqué est OMIS du payload complete (aucun écrasement).
 */
export interface VisibleIfInput { field: string; op: 'eq' | 'neq'; value: string | boolean }
export interface VisibleIf { fieldKey: string; op: 'eq' | 'neq'; value: string | boolean }

interface WithVisibleIfInput { visibleIf?: VisibleIfInput }
interface WithVisibleIf { visibleIf?: VisibleIf }

export interface FlowTextElInput extends WithVisibleIfInput { kind: FlowTextKind; text: string }
export interface FlowTextEl extends WithVisibleIf { kind: FlowTextKind; text: string }
/** Image = base64 BRUT (sans préfixe data-URL), vérifié live. Pas le chemin carousel (media handle). */
export interface FlowImageElInput extends WithVisibleIfInput { kind: 'image'; src: string }
export interface FlowImageEl extends WithVisibleIf { kind: 'image'; src: string }
export interface FlowFieldElInput extends FlowFieldInput, WithVisibleIfInput { kind: 'field' }
export type FlowElementInput = FlowTextElInput | FlowImageElInput | FlowFieldElInput;
export interface FlowFieldEl extends FlowField, WithVisibleIf { kind: 'field' }
export type FlowElement = FlowTextEl | FlowImageEl | FlowFieldEl;

/** Écran d'un formulaire multi-écrans. `cta` = libellé du Footer de CET écran s'il est intermédiaire
 *  (défaut « Continuer ») ; le DERNIER écran porte le cta global du flow (défaut « Envoyer »). */
export interface FlowScreenInput { title?: string; cta?: string; elements: FlowElementInput[] }
export interface FlowScreenDef { title?: string; cta?: string; elements: FlowElement[] }

/** Meta borne le routing à 10 branches ; on borne pareil le nombre d'écrans. */
export const MAX_SCREENS = 10;

/** Id d'écran : lettres + underscores UNIQUEMENT (sondé live : un chiffre est REJETÉ par la validation
 *  Meta). Écran 1 = FORM pour toujours (navigate_screen des templates approuvés + flow_action_payload). */
export function screenId(index: number): string {
  return index === 0 ? FLOW_ENTRY_SCREEN : `${FLOW_ENTRY_SCREEN}_${String.fromCharCode(65 + index)}`; // FORM, FORM_B, FORM_C…
}

/** Condition invalide (source inconnue, après l'élément, autre écran, mauvais type, valeur hors options…). */
export class VisibleIfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisibleIfError';
  }
}

export const FLOW_TEXT_KINDS: readonly FlowTextKind[] = ['heading', 'subheading', 'body', 'caption'];

/** Dérive les clés des éléments de type `field` (les autres passent tels quels). Collision -> erreur.
 *  Mono-écran historique : conservé pour les appels directs, la dérivation multi passe par deriveScreens. */
export function deriveElements(elements: FlowElementInput[]): FlowElement[] {
  return deriveScreens([{ elements }])[0]!.elements;
}

/** Types de champ admissibles comme SOURCE d'une condition de visibilité (V1). checkbox exclu : sa valeur
 *  est un tableau (multi-sélection), une égalité simple ne s'y applique pas. */
const VISIBLE_SOURCE_TYPES: readonly FlowFieldType[] = ['dropdown', 'radio', 'optin'];

/**
 * Dérive les clés de champ de TOUS les écrans (unicité GLOBALE : le payload complete et le mapping sont
 * plats) + résout/valide les `visibleIf` (libellé source -> clé). Collision -> DuplicateFieldKeyError ;
 * condition invalide -> VisibleIfError. L'ordre écran par écran est préservé.
 */
export function deriveScreens(screens: FlowScreenInput[]): FlowScreenDef[] {
  const byKey = new Map<string, string>(); // clé -> libellé (collisions inter-écrans comprises)
  // 1re passe : clés globales (le visibleIf INPUT est retiré, il est résolu en clés à la 2e passe).
  const derived: FlowScreenDef[] = screens.map((s) => ({
    ...(s.title !== undefined ? { title: s.title } : {}),
    ...(s.cta !== undefined ? { cta: s.cta } : {}),
    elements: s.elements.map((el): FlowElement => {
      const { visibleIf: _vi, ...rest } = el;
      if (rest.kind !== 'field') return rest as FlowElement;
      const key = slugify(rest.label);
      const prev = byKey.get(key);
      if (prev !== undefined) throw new DuplicateFieldKeyError(prev, rest.label, key);
      byKey.set(key, rest.label);
      return { ...rest, key } as FlowElement;
    }),
  }));
  // 2e passe : résolution des visibleIf (source = champ du MÊME écran, situé AVANT, type admissible).
  screens.forEach((s, si) => {
    s.elements.forEach((el, ei) => {
      const v = el.visibleIf;
      if (v === undefined) return;
      const label = String(v.field ?? '').trim();
      const before = derived[si]!.elements.slice(0, ei).filter((e): e is FlowFieldEl => e.kind === 'field');
      const source = before.find((f) => f.label === label);
      if (!source) throw new VisibleIfError(`condition de visibilité : champ source « ${label} » introuvable AVANT l'élément sur le même écran`);
      if (!VISIBLE_SOURCE_TYPES.includes(source.type)) {
        throw new VisibleIfError(`condition de visibilité : le champ source « ${label} » doit être une liste (choix unique) ou un consentement`);
      }
      if (v.op !== 'eq' && v.op !== 'neq') throw new VisibleIfError('condition de visibilité : opérateur inconnu (eq/neq)');
      if (source.type === 'optin') {
        if (typeof v.value !== 'boolean') throw new VisibleIfError(`condition de visibilité : « ${label} » est un consentement, la valeur doit être coché/non coché`);
      } else {
        if (typeof v.value !== 'string' || !(source.options ?? []).includes(v.value)) {
          throw new VisibleIfError(`condition de visibilité : la valeur doit être une option de « ${label} »`);
        }
        // La valeur s'insère dans une expression Flow JSON entre quotes simples : pas d'échappement documenté
        // par Meta -> on refuse les caractères qui casseraient l'expression plutôt que de générer un flow invalide.
        if (v.value.includes("'") || v.value.includes('`')) {
          throw new VisibleIfError(`condition de visibilité : l'option « ${v.value} » contient une apostrophe ou un accent grave, non supporté dans une condition`);
        }
      }
      (derived[si]!.elements[ei] as { visibleIf?: VisibleIf }).visibleIf = { fieldKey: source.key, op: v.op, value: v.value };
    });
  });
  return derived;
}

/** Extrait les champs (kind='field') d'une liste d'éléments -> réutilisable pour FlowRow.fields + mapping. */
export function fieldsOf(elements: FlowElement[]): FlowField[] {
  return elements.filter((e): e is FlowFieldEl => e.kind === 'field').map(({ label, type, required, key }) => ({ label, type, required, key }));
}

/** Tous les champs d'un formulaire multi-écrans, aplatis dans l'ordre (écran par écran). */
export function fieldsOfScreens(screens: FlowScreenDef[]): FlowField[] {
  return screens.flatMap((s) => fieldsOf(s.elements));
}

/**
 * Normalise la colonne `flows.elements` (jsonb polymorphe, AUCUNE migration) vers des écrans :
 * - null / vide -> null (flow legacy pré-modèle-riche, gardes 422 existantes) ;
 * - tableau plat (mono-écran historique) -> [{ elements }] ;
 * - { screens: [...] } (forme multi, écrite par le Lot 7) -> telle quelle.
 */
export function screensOf(stored: unknown): FlowScreenDef[] | null {
  if (stored == null) return null;
  if (Array.isArray(stored)) return stored.length === 0 ? null : [{ elements: stored as FlowElement[] }];
  const obj = stored as { screens?: unknown };
  if (Array.isArray(obj.screens) && obj.screens.length > 0) return obj.screens as FlowScreenDef[];
  return null;
}

const TEXT_COMPONENT: Record<FlowTextKind, string> = {
  heading: 'TextHeading',
  subheading: 'TextSubheading',
  body: 'TextBody',
  caption: 'TextCaption',
};

/**
 * Expression Flow JSON de la propriété `visible` (backticks = expression imbriquée, v6.0+, sondée OK en
 * 7.2). optin -> booléen nu ; dropdown/radio -> comparaison au libellé d'option (id==title). La valeur a
 * été validée sans apostrophe/backtick à la dérivation.
 */
function visibleExpr(v: VisibleIf): string {
  const op = v.op === 'eq' ? '==' : '!=';
  const rhs = typeof v.value === 'boolean' ? String(v.value) : `'${v.value}'`;
  return `\`\${form.${v.fieldKey}} ${op} ${rhs}\``;
}

/** Composant Flow JSON d'un élément riche (texte / image / champ), avec sa condition de visibilité éventuelle. */
function elementComponent(el: FlowElement): Record<string, unknown> {
  const visible = el.visibleIf ? { visible: visibleExpr(el.visibleIf) } : {};
  if (el.kind === 'image') return { type: 'Image', src: el.src, height: 200, 'scale-type': 'contain', ...visible };
  if (el.kind !== 'field') return { type: TEXT_COMPONENT[el.kind], text: el.text, ...visible };
  return { ...componentFor(el), ...visible };
}

/**
 * Construit le flow_json multi-écrans. Ids d'écrans FORM, FORM_B, FORM_C… (lettres+underscores UNIQUEMENT,
 * sondé : un chiffre est rejeté ; l'écran 1 reste FORM, baké dans les templates approuvés). PAS de
 * routing_model (facultatif sans endpoint, sondé en 7.2 et 7.3). Écrans intermédiaires : Footer `navigate`
 * (payload {}) ; écran final terminal : Footer `complete` dont le payload agrège TOUS les champs — refs
 * globales `\${screen.<ID>.form.<clé>}` pour les écrans précédents (résolution dans les payloads sondée),
 * `\${form.<clé>}` pour le dernier — plus la constante `_ref` (discriminant du retour nfm_reply). Un champ
 * masqué (visible) ou vide est OMIS du payload par Meta (sondé) : le mapping webhook reste intact.
 * Pur et déterministe. `ref` figé à la création.
 */
export function buildFlowScreens(name: string, screens: FlowScreenDef[], version: string, ref: string, cta?: string): Record<string, unknown> {
  const last = screens.length - 1;
  const payload: Record<string, string> = {};
  screens.forEach((s, i) => {
    for (const f of fieldsOf(s.elements)) {
      payload[f.key] = i === last ? `\${form.${f.key}}` : `\${screen.${screenId(i)}.form.${f.key}}`;
    }
  });
  payload[FLOW_REF_KEY] = ref;
  const finalLabel = (cta ?? '').trim().slice(0, 30) || 'Envoyer';
  return {
    version,
    screens: screens.map((s, i) => {
      const footer = i === last
        ? { type: 'Footer', label: finalLabel, 'on-click-action': { name: 'complete', payload } }
        : { type: 'Footer', label: (s.cta ?? '').trim().slice(0, 30) || 'Continuer', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: screenId(i + 1) }, payload: {} } };
      return {
        id: screenId(i),
        title: (s.title ?? '').trim().slice(0, 30) || name.slice(0, 30) || 'Formulaire',
        ...(i === last ? { terminal: true, success: true } : {}),
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [...s.elements.map(elementComponent), footer],
        },
      };
    }),
  };
}

/** Mono-écran historique : enveloppe d'un seul écran (compat interne + tests existants). */
export function buildFlowElements(name: string, elements: FlowElement[], version: string, ref: string, cta?: string): Record<string, unknown> {
  return buildFlowScreens(name, [{ elements }], version, ref, cta);
}

/** Composant Flow JSON d'un champ selon son type. */
function componentFor(f: FlowField): Record<string, unknown> {
  const base = { name: f.key, label: f.label, required: f.required };
  if (f.type === 'textarea') return { type: 'TextArea', ...base };
  if (f.type === 'date') return { type: 'DatePicker', ...base };
  if (f.type === 'optin') return { type: 'OptIn', ...base };
  if (isChoiceFieldType(f.type)) {
    // Meta attend un `data-source` [{id,title}]. id = title -> la valeur renvoyée est le libellé lisible.
    const dataSource = (f.options ?? []).map((o) => ({ id: o, title: o }));
    const type = f.type === 'dropdown' ? 'Dropdown' : f.type === 'radio' ? 'RadioButtonsGroup' : 'CheckboxGroup';
    return { type, ...base, 'data-source': dataSource };
  }
  // text | email | phone | number | passcode -> TextInput input-type
  return { type: 'TextInput', ...base, 'input-type': f.type };
}
