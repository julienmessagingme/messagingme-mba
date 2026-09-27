/**
 * Dérive le JSON Schema d'un outil, tel qu'il est envoyé au modèle.
 *
 * 🔴 C'est ici que le modèle perd la main sur la cible. Chaque paramètre porte une `source` :
 *  - `modele`  : le modèle le remplit, seuls ceux-là entrent dans le schéma ;
 *  - `contact` : dérivé du numéro authentifié par la signature du webhook Meta, ou d'un attribut de la fiche ;
 *  - `champ`   : un champ personnalisé déclaré par le client ;
 *  - `fixe`    : constante du tenant.
 * Les trois derniers sont injectés par le runtime, jamais négociés avec le modèle : sinon un connecteur
 * serait un IDOR (demander à l'agent la commande de quelqu'un d'autre).
 */

/**
 * `champ` aligne les paramètres d'outil sur les variables de requête (`src/agent/variables.ts`) : un outil
 * MCP n'a pas de requête, et sans `champ` un paramètre identifié par e-mail retomberait sur le modèle.
 */
export type SourceParam = 'modele' | 'contact' | 'champ' | 'fixe';

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
  /**
   * `source: 'champ'` : la clé du champ personnalisé déclaré par le client. Jamais exposée. Un `champ` sans
   * `cle` est écarté par la coercion.
   */
  cle?: string;
  /** `source: 'fixe'` : la constante du tenant. Jamais exposée. */
  value?: string | number | boolean;
  /**
   * Outil MCP : le chemin de ce paramètre dans le schéma du serveur distant (`filtres.ville`), casse comprise.
   * Jamais exposé : `name` n'est qu'une étiquette locale, le chemin permet de recomposer l'objet imbriqué à
   * l'appel, et donc de marquer un paramètre imbriqué `contact` ou `fixe`.
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
 * Relit défensivement une entrée de `agent_tools.params` (jsonb opaque). Rend `null` sur une entrée
 * inutilisable plutôt que de lever. Écarter une entrée n'est pas anodin : voir `paramsOutil`, qui empêche
 * qu'un `contact` malformé rende la cible au modèle.
 */
function coercer(brut: unknown): ParamOutil | null {
  if (!brut || typeof brut !== 'object') return null;
  const o = brut as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const type = TYPES.find((t) => t === o.type);
  const source = (['modele', 'contact', 'champ', 'fixe'] as const).find((s) => s === o.source);
  if (!name || !type || !source) return null;
  const cle = typeof o.cle === 'string' ? o.cle.trim() : '';
  // Un `champ` sans clé ne désigne rien : l'appel partirait avec un trou à la place d'un identifiant.
  if (source === 'champ' && cle === '') return null;
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
    ...(source === 'champ' ? { cle } : {}),
    // Non trimé : c'est un chemin du schéma distant, un espace y appartient au nom de la propriété.
    ...(typeof o.cheminMcp === 'string' && o.cheminMcp !== '' ? { cheminMcp: o.cheminMcp } : {}),
  };
}

/**
 * Les paramètres d'un outil, coercés, toutes sources confondues : le schéma exposé au modèle, la validation
 * des arguments et l'injection du runtime (`src/agent/executor.ts`) en dérivent tous. Deux lectures
 * divergentes rendraient la cible au modèle dans l'une d'elles.
 */
export function paramsOutil(params: unknown): ParamOutil[] {
  const liste = Array.isArray(params) ? params : [];
  // 🔴 Noms réservés par le runtime, lus sur le brut et non sur la coercion : une entrée `contact`, `champ`
  // ou `fixe` inutilisable est écartée par `coercer`, et un même nom déclaré en `modele` resterait exposé,
  // sans rien pour l'écraser à l'injection. Une déclaration ambiguë se tranche toujours pour le runtime.
  const reserves = new Set(
    liste
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .filter((b) => b.source === 'contact' || b.source === 'champ' || b.source === 'fixe')
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
 * Le schéma envoyé au modèle pour un outil, construit directement et pas dérivé de Zod : ni `$schema` ni
 * bornes parasites (`minimum: -9007199254740991` de `z.number().int()`), qui se paieraient à chaque tour.
 */
export function toolParamsToJsonSchema(params: unknown): SchemaObjet {
  const schema: SchemaObjet = { type: 'object', properties: {}, required: [], additionalProperties: false };
  for (const p of paramsOutil(params)) {
    // La garde de ce module : tout ce qui n'est pas rempli par le modèle est invisible pour lui.
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
