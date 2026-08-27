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
 * Le sens est SÛR : ignorer une entrée ne peut que RETIRER quelque chose de ce que le modèle voit, jamais en
 * ajouter. L'outil échouera alors à la validation de ses arguments, et le modèle se corrigera au tour
 * suivant, ce qui est le comportement voulu.
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
  return {
    name,
    type,
    source,
    ...(typeof o.description === 'string' && o.description.trim() !== '' ? { description: o.description.trim() } : {}),
    ...(o.required === true ? { required: true } : {}),
    ...(enumeration && enumeration.length > 0 ? { enum: enumeration } : {}),
  };
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
  const liste = Array.isArray(params) ? params : [];
  const schema: SchemaObjet = { type: 'object', properties: {}, required: [], additionalProperties: false };
  for (const brut of liste) {
    const p = coercer(brut);
    // 🔴 LA garde de ce module : tout ce qui n'est pas rempli par le modèle est invisible pour lui.
    if (!p || p.source !== 'modele') continue;
    schema.properties[p.name] = {
      type: p.type,
      ...(p.description ? { description: p.description } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
    };
    if (p.required) schema.required.push(p.name);
  }
  return schema;
}
