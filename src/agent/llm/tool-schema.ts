/**
 * Dérive le JSON Schema d'un outil, tel qu'il est envoyé au modèle.
 *
 * 🔴 C'EST ICI QUE LE MODÈLE PERD LA MAIN SUR LA CIBLE, et c'est tout l'intérêt de ce module. Chaque
 * paramètre porte une `source` :
 *
 *  - `modele`  : le modèle le remplit. SEULS ceux-là entrent dans le schéma.
 *  - `contact` : dérivé du numéro authentifié par la signature du webhook Meta, ou d'un champ de la fiche
 *                contact. Le modèle ne le VOIT pas, il ne peut donc pas le fabriquer.
 *  - `fixe`    : constante du tenant (identifiant de compte, code boutique).
 *
 * Sans cette séparation, un connecteur client serait un IDOR offert au premier venu qui écrit sur le
 * numéro : il suffirait de demander à l'agent la commande de quelqu'un d'autre. Les paramètres `contact` et
 * `fixe` sont injectés par le runtime au moment de l'appel, jamais négociés avec le modèle.
 */

export type SourceParam = 'modele' | 'contact' | 'fixe';

/** Types portables entre fournisseurs. Volontairement réduit : pas d'objet imbriqué ni de tableau tant que
 *  personne n'en a besoin (le cadrage borne la profondeur à 10, on est très en deçà). */
export type TypeParam = 'string' | 'number' | 'integer' | 'boolean';

export interface ParamOutil {
  name: string;
  type: TypeParam;
  source: SourceParam;
  description?: string;
  required?: boolean;
  /** Valeurs autorisées. Une énumération fermée empêche le modèle d'inventer une valeur hors domaine. */
  enum?: string[];
  /** `source: 'contact'` : le champ de la fiche contact d'où vient la valeur (`wa_id` compris). Jamais exposé. */
  contactPath?: string;
  /** `source: 'fixe'` : la constante du tenant. Jamais exposée. */
  value?: string | number | boolean;
  /**
   * Outil MCP : le CHEMIN de ce paramètre dans le schéma du serveur distant (`filtres.ville`), tel qu'il y
   * est écrit, casse comprise.
   *
   * 🔴 IL N'EST JAMAIS EXPOSÉ AU MODÈLE, et il n'est pas décoratif : `name` est une étiquette LOCALE, plate
   * et normalisée, quand le chemin est la donnée de PROTOCOLE qui permet de recomposer l'objet imbriqué au
   * moment de l'appel. Sans lui, un paramètre imbriqué n'aurait aucune case où poser son marquage
   * `contact` / `fixe`, donc il serait forcément rempli par le modèle, donc influençable par le contact.
   */
  cheminMcp?: string;
}

/** Schéma d'objet, forme commune à tous les fournisseurs. Pas de `$schema` : aucun ne l'attend. */
export interface SchemaObjet {
  type: 'object';
  properties: Record<string, { type: TypeParam; description?: string; enum?: string[] }>;
  required: string[];
  /** Posé à `false` : borne de portabilité du cadrage, et ce que le mode strict d'OpenAI exige. */
  additionalProperties: false;
}

const TYPES: readonly TypeParam[] = ['string', 'number', 'integer', 'boolean'];

/**
 * Coerce défensivement une entrée de `agent_tools.params` (du jsonb, donc opaque) en paramètre exploitable.
 * Rend `null` sur une entrée inutilisable plutôt que de lever.
 *
 * ⚠️ IGNORER UNE ENTRÉE N'EST PAS ANODIN, contrairement à ce que ce commentaire affirmait. Tant que la
 * coercion n'avait qu'un consommateur (l'exposition au modèle), la retirer ne pouvait que retrancher. Depuis
 * qu'elle sert AUSSI l'injection du runtime, écarter une entrée `contact` malformée pendant qu'une entrée
 * `modele` du MÊME nom survit rendrait la cible au modèle. C'est `paramsOutil` qui ferme ce cas, sur le brut.
 */
function coercer(brut: unknown): ParamOutil | null {
  if (!brut || typeof brut !== 'object') return null;
  const o = brut as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const type = TYPES.find((t) => t === o.type);
  const source = (['modele', 'contact', 'fixe'] as const).find((s) => s === o.source);
  if (!name || !type || !source) return null;
  const enumeration = Array.isArray(o.enum)
    ? o.enum.filter((v): v is string => typeof v === 'string' && v !== '')
    : undefined;
  const valeurFixe = typeof o.value === 'string' || typeof o.value === 'number' || typeof o.value === 'boolean'
    ? o.value
    : undefined;
  return {
    name,
    type,
    source,
    ...(typeof o.description === 'string' && o.description.trim() !== '' ? { description: o.description.trim() } : {}),
    ...(o.required === true ? { required: true } : {}),
    ...(enumeration && enumeration.length > 0 ? { enum: enumeration } : {}),
    ...(typeof o.contactPath === 'string' && o.contactPath.trim() !== '' ? { contactPath: o.contactPath.trim() } : {}),
    ...(valeurFixe !== undefined ? { value: valeurFixe } : {}),
    // ⚠️ NON TRIMÉ, contrairement aux autres : c'est un chemin du schéma DISTANT, et un espace y appartient
    // au nom de la propriété du serveur. Le nettoyer ferait viser une clé qui n'existe pas chez lui.
    ...(typeof o.cheminMcp === 'string' && o.cheminMcp !== '' ? { cheminMcp: o.cheminMcp } : {}),
  };
}

/**
 * Les paramètres d'un outil, coercés, TOUTES sources confondues.
 *
 * 🔴 SOURCE UNIQUE de la séparation des sources. Le schéma exposé au modèle (ci-dessous), le schéma de
 * validation des arguments et l'injection des valeurs du runtime (`src/agent/executor.ts`) dérivent tous les
 * trois d'ICI. Deux lectures divergentes de `params` seraient exactement la faille que ce module existe pour
 * fermer : le modèle perdrait la main sur la cible dans une lecture et la reprendrait dans l'autre.
 */
export function paramsOutil(params: unknown): ParamOutil[] {
  const liste = Array.isArray(params) ? params : [];
  // 🔴 Noms RÉSERVÉS par le runtime, lus sur le BRUT et non sur la coercion. Une entrée `contact` ou `fixe`
  // inutilisable (type absent, mal orthographié) est écartée par `coercer` ; si le même nom est aussi déclaré
  // en `modele`, il resterait alors exposé, validé, et plus rien ne viendrait l'écraser à l'injection : le
  // modèle reprendrait la main sur la cible, c'est-à-dire exactement l'IDOR que ce module ferme. Une
  // déclaration ambiguë se tranche donc TOUJOURS en faveur du runtime, y compris quand elle est cassée.
  const reserves = new Set(
    liste
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .filter((b) => b.source === 'contact' || b.source === 'fixe')
      .map((b) => (typeof b.name === 'string' ? b.name.trim() : ''))
      .filter((n) => n !== ''),
  );
  const out: ParamOutil[] = [];
  for (const brut of liste) {
    const p = coercer(brut);
    if (p && !(p.source === 'modele' && reserves.has(p.name))) out.push(p);
  }
  return out;
}

/**
 * Le schéma envoyé au modèle pour un outil.
 *
 * Aucun `$schema` (aucun fournisseur ne l'attend), et aucune borne numérique parasite : le schéma est
 * construit DIRECTEMENT plutôt que dérivé d'un schéma Zod, donc le bruit `minimum: -9007199254740991` que
 * produit `z.number().int()` n'existe pas ici par construction. Un test l'ancre, pour qu'une future
 * dérivation ne le réintroduise pas sans qu'on le voie : ce bruit se paie à CHAQUE tour, dans le prompt.
 */
export function toolParamsToJsonSchema(params: unknown): SchemaObjet {
  const schema: SchemaObjet = { type: 'object', properties: {}, required: [], additionalProperties: false };
  for (const p of paramsOutil(params)) {
    // 🔴 LA garde de ce module : tout ce qui n'est pas rempli par le modèle est invisible pour lui.
    if (p.source !== 'modele') continue;
    schema.properties[p.name] = {
      type: p.type,
      ...(p.description ? { description: p.description } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
    };
    if (p.required) schema.required.push(p.name);
  }
  return schema;
}
