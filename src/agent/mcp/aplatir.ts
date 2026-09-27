import type { TypeParam } from '../llm/tool-schema';
import { nomUnique } from './nommer';
import { objetOuNull } from '../../webhooks/json';

/**
 * Aplatir un `inputSchema` MCP en feuilles scalaires.
 *
 * 🔴 C'est ce qui permet à la garde d'identité de descendre dans les sous-objets : chaque feuille reçoit sa
 * `source` (`modele`, `contact`, `champ`, `fixe`) comme un paramètre maison. Sans ça, un paramètre imbriqué
 * (`filtres.client_id`) serait forcément rempli par le modèle, donc un IDOR.
 *
 * Refuse plutôt que deviner les formes sans jeu de feuilles fixe (tableau, vraies alternatives, objet sans
 * forme déclarée) : une raison part à l'écran, l'outil est importé mais pas activable. Ne lève jamais :
 * l'entrée vient d'un tiers, et un outil mal formé ne doit pas faire échouer tout l'import.
 */

export interface FeuilleMcp {
  /** Nom exposé au modèle : plat, normalisé, unique dans l'outil. */
  name: string;
  /**
   * Le chemin dans le schéma distant (`filtres.ville`), casse comprise. Jamais exposé au modèle : il permet
   * de recomposer l'objet imbriqué à l'appel, `name` n'étant qu'une étiquette locale.
   */
  cheminMcp: string;
  type: TypeParam;
  description?: string;
  /** Requis pour le serveur distant. Vrai seulement si tous les maillons du chemin le sont. */
  required: boolean;
  /** Valeurs autorisées. Une énumération fermée empêche le modèle d'inventer une valeur hors domaine. */
  enum?: string[];
}

export interface SchemaAplati {
  /** Vide quand l'outil n'est pas activable : un jeu partiel pourrait être utilisé par mégarde. */
  feuilles: FeuilleMcp[];
  /** `null` = activable. Sinon, la raison en clair, affichée telle quelle au client. */
  raisonNonActivable: string | null;
}

/**
 * Profondeur maximale d'imbrication : au-delà, les noms de feuilles deviendraient illisibles pour le modèle,
 * puis indistinguables une fois tronqués à 64 caractères.
 */
const PROFONDEUR_MAX = 5;

const TYPES: Record<string, TypeParam> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
};


/** Les clés listées dans `required`, en ignorant ce qui n'est pas un tableau de chaînes. */
function requis(noeud: Record<string, unknown>): Set<string> {
  const brut = noeud.required;
  if (!Array.isArray(brut)) return new Set();
  return new Set(brut.filter((x): x is string => typeof x === 'string'));
}

/**
 * Réduit « ce type ou null » à son type : `anyOf: [T, null]` décrit une forme plus l'absence, l'idiome des
 * générateurs pour un paramètre facultatif. Deux formes réelles restent refusées. Rend le nœud à examiner,
 * ou `null` si l'alternative est vraie.
 */
function sansLeNul(noeud: Record<string, unknown>): Record<string, unknown> | null {
  const alternatives = noeud.oneOf ?? noeud.anyOf;
  if (!Array.isArray(alternatives)) return noeud;
  const branches = alternatives.map(objetOuNull).filter((b): b is Record<string, unknown> => b !== null);
  const utiles = branches.filter((b) => b.type !== 'null');
  if (branches.length !== alternatives.length || utiles.length !== 1) return null;
  return utiles[0]!;
}

/** Le type scalaire d'un nœud, ou `null` s'il n'en a pas un que nous sachions représenter. */
function typeScalaire(noeud: Record<string, unknown>): TypeParam | null {
  const brut = noeud.type;
  if (typeof brut === 'string') return TYPES[brut] ?? null;
  if (Array.isArray(brut)) {
    // `type: ['integer', 'null']` : la même chose que l'idiome `anyOf`, écrite autrement.
    const utiles = brut.filter((t) => typeof t === 'string' && t !== 'null') as string[];
    return utiles.length === 1 ? TYPES[utiles[0]!] ?? null : null;
  }
  // Une énumération de chaînes sans type déclaré est une chaîne : JSON Schema l'autorise.
  if (brut === undefined && Array.isArray(noeud.enum) && noeud.enum.every((v) => typeof v === 'string')) {
    return 'string';
  }
  return null;
}

export function aplatirSchema(inputSchema: unknown): SchemaAplati {
  const racine = objetOuNull(inputSchema);
  if (racine === null) {
    // Deux raisons distinctes : « rien de déclaré » est une omission, « déclaré mais illisible » une réponse
    // mal formée, et le client n'a pas la même chose à dire à son fournisseur.
    const raisonNonActivable = inputSchema === undefined || inputSchema === null
      ? 'le serveur n’a pas déclaré la forme des paramètres de cet outil'
      : 'le serveur a déclaré les paramètres de cet outil sous une forme illisible';
    return { feuilles: [], raisonNonActivable };
  }
  if (racine.type !== undefined && racine.type !== 'object') {
    return { feuilles: [], raisonNonActivable: `les paramètres de cet outil ne sont pas un objet (« ${String(racine.type)} »)` };
  }

  const feuilles: FeuilleMcp[] = [];
  const obstacles: string[] = [];
  const prisNoms = new Set<string>();

  function ajouter(chemin: string, type: TypeParam, noeud: Record<string, unknown>, estRequis: boolean): void {
    // Deux chemins peuvent se normaliser pareil (`a.b_c` et `a.b.c`) ou collisionner après troncature : sans
    // suffixe, une valeur partirait dans le mauvais champ. La mise en forme vit dans `./nommer`, partagée avec
    // l'import.
    const nom = nomUnique(chemin, prisNoms);
    prisNoms.add(nom);
    const enumeration = Array.isArray(noeud.enum) && noeud.enum.every((v) => typeof v === 'string')
      ? noeud.enum as string[]
      : undefined;
    feuilles.push({
      name: nom,
      cheminMcp: chemin,
      type,
      ...(typeof noeud.description === 'string' && noeud.description !== '' ? { description: noeud.description } : {}),
      required: estRequis,
      ...(enumeration ? { enum: enumeration } : {}),
    });
  }

  function descendre(noeud: Record<string, unknown>, chemin: string, profondeur: number, brancheRequise: boolean): void {
    if (profondeur > PROFONDEUR_MAX) {
      obstacles.push(`« ${chemin} » : les paramètres imbriqués au-delà d’une profondeur de ${PROFONDEUR_MAX} ne sont pas pris en charge`);
      return;
    }
    const props = objetOuNull(noeud.properties);
    // Asymétrie voulue avec la racine : là, l'absence de propriétés dit « aucun paramètre » ; imbriquée, elle
    // dit « un objet de forme non déclarée », que nous ne savons pas remplir en sûreté.
    if (props === null || Object.keys(props).length === 0) {
      obstacles.push(`« ${chemin} » : le serveur n’a pas déclaré la forme de cet objet`);
      return;
    }
    const obligatoires = requis(noeud);
    for (const [cle, brut] of Object.entries(props)) {
      const sousChemin = chemin === '' ? cle : `${chemin}.${cle}`;
      const enfant = objetOuNull(brut);
      if (enfant === null) {
        obstacles.push(`« ${sousChemin} » : déclaration illisible`);
        continue;
      }
      const reduit = sansLeNul(enfant);
      if (reduit === null) {
        obstacles.push(`« ${sousChemin} » : le serveur propose plusieurs formes possibles pour ce paramètre`);
        continue;
      }
      const estRequis = brancheRequise && obligatoires.has(cle);
      const type = typeScalaire(reduit);
      if (type !== null) {
        ajouter(sousChemin, type, reduit, estRequis);
        continue;
      }
      if (reduit.type === 'object' || (reduit.type === undefined && objetOuNull(reduit.properties) !== null)) {
        descendre(reduit, sousChemin, profondeur + 1, estRequis);
        continue;
      }
      if (reduit.type === 'array') {
        obstacles.push(`« ${sousChemin} » : c’est une liste, et nous ne savons pas encore la remplir en sûreté`);
        continue;
      }
      obstacles.push(`« ${sousChemin} » : type « ${String(reduit.type ?? 'non déclaré')} » non pris en charge`);
    }
  }

  const propsRacine = objetOuNull(racine.properties);
  if (propsRacine !== null && Object.keys(propsRacine).length > 0) {
    descendre(racine, '', 1, true);
  }

  if (obstacles.length === 0) return { feuilles, raisonNonActivable: null };
  // Tous les obstacles, pas seulement le premier : le client ne peut pas corriger un schéma distant, mais
  // il doit pouvoir dire à son fournisseur ce qui bloque, et n'y revenir qu'une fois.
  return { feuilles: [], raisonNonActivable: obstacles.join(' ; ') };
}
