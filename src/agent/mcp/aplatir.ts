import type { TypeParam } from '../llm/tool-schema';
import { nomUnique } from './nommer';

/**
 * Aplatir un `inputSchema` MCP en FEUILLES scalaires.
 *
 * 🔴 CE MODULE EST CE QUI PERMET À LA GARDE D'IDENTITÉ DE DESCENDRE DANS LES SOUS-OBJETS, et c'est sa seule
 * raison d'être. Nos paramètres portent une `source` (`modele` / `contact` / `champ` / `fixe`) qui décide si
 * le MODÈLE remplit la valeur ou si le runtime l'injecte depuis le numéro authentifié par la signature Meta,
 * ou depuis un champ que le client a déclaré pour ses contacts. Un
 * paramètre imbriqué n'aurait aucune case où poser ce marquage : il serait donc forcément rempli par le
 * modèle, donc influençable par le contact, et un `filtres.client_id` deviendrait un IDOR offert au premier
 * venu qui écrit sur le numéro. En énumérant les feuilles, chacune reçoit sa source comme n'importe quel
 * paramètre maison.
 *
 * 🔴 IL REFUSE PLUTÔT QUE DE DEVINER. Trois formes n'ont pas de jeu de feuilles fixe : un tableau (le nombre
 * d'éléments est inconnu), de vraies alternatives (`oneOf` / `anyOf` à plusieurs formes), un objet dont la
 * forme n'est pas déclarée. Les aplatir demanderait d'inventer une convention que le serveur distant ne
 * connaît pas, et qu'il faudrait re-deviner à l'appel. On rend donc une RAISON, qui part telle quelle à
 * l'écran, et l'outil est importé, montré, mais pas activable.
 *
 * 🔴 IL NE LÈVE JAMAIS. Son entrée vient d'un tiers : une exception ferait échouer l'import ENTIER à cause
 * d'un seul outil mal formé, et le client perdrait les quinze autres.
 */

export interface FeuilleMcp {
  /** Nom exposé au modèle : plat, normalisé, unique dans l'outil. */
  name: string;
  /**
   * Le chemin dans le schéma DISTANT (`filtres.ville`), tel qu'il y est écrit, casse comprise.
   *
   * 🔴 IL N'EST JAMAIS EXPOSÉ AU MODÈLE, et il n'est pas décoratif : c'est lui qui permet de RECOMPOSER
   * l'objet imbriqué au moment de l'appel. Notre `name` est une étiquette locale, le chemin est la donnée
   * de protocole.
   */
  cheminMcp: string;
  type: TypeParam;
  description?: string;
  /** Requis pour le serveur distant. Vrai seulement si TOUS les maillons du chemin le sont. */
  required: boolean;
  /** Valeurs autorisées. Une énumération fermée empêche le modèle d'inventer une valeur hors domaine. */
  enum?: string[];
}

export interface SchemaAplati {
  /** VIDE quand l'outil n'est pas activable : un jeu partiel pourrait être utilisé par mégarde. */
  feuilles: FeuilleMcp[];
  /** `null` = activable. Sinon, la raison en clair, affichée telle quelle au client. */
  raisonNonActivable: string | null;
}

/**
 * Profondeur maximale d'imbrication.
 *
 * ⚠️ Elle n'est pas une limite de confort : sans elle, un schéma profond produirait des noms de feuilles
 * illisibles pour le modèle (`a_b_c_d_e_f_g_ville`), et la borne de 64 caractères les tronquerait jusqu'à
 * les rendre indistinguables. Cinq niveaux couvrent très largement ce qu'une API expose.
 */
const PROFONDEUR_MAX = 5;

const TYPES: Record<string, TypeParam> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
};

function objet(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** Les clés listées dans `required`, en ignorant ce qui n'est pas un tableau de chaînes. */
function requis(noeud: Record<string, unknown>): Set<string> {
  const brut = noeud.required;
  if (!Array.isArray(brut)) return new Set();
  return new Set(brut.filter((x): x is string => typeof x === 'string'));
}

/**
 * Réduit « ce type OU null » à son type.
 *
 * 🔴 CE N'EST PAS UN ASSOUPLISSEMENT DE LA RÈGLE SUR LES ALTERNATIVES, et la nuance décide de tout :
 * `anyOf: [T, null]` ne décrit pas deux formes de valeur, il décrit UNE forme plus l'absence de valeur.
 * C'est l'idiome que produisent la plupart des générateurs de schéma pour un paramètre facultatif, et le
 * refuser rendrait non activables des outils parfaitement représentables. Deux formes RÉELLES restent
 * refusées, ce que le cas suivant vérifie.
 *
 * Rend le nœud à examiner, ou `null` si l'alternative est vraie.
 */
function sansLeNul(noeud: Record<string, unknown>): Record<string, unknown> | null {
  const alternatives = noeud.oneOf ?? noeud.anyOf;
  if (!Array.isArray(alternatives)) return noeud;
  const branches = alternatives.map(objet).filter((b): b is Record<string, unknown> => b !== null);
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
  // Une énumération de chaînes SANS type déclaré est une chaîne : JSON Schema l'autorise, et refuser
  // reviendrait à jeter une information qu'on a sous les yeux.
  if (brut === undefined && Array.isArray(noeud.enum) && noeud.enum.every((v) => typeof v === 'string')) {
    return 'string';
  }
  return null;
}

export function aplatirSchema(inputSchema: unknown): SchemaAplati {
  const racine = objet(inputSchema);
  if (racine === null) {
    // ⚠️ DEUX RAISONS DISTINCTES, parce que le client n'a pas la même chose à dire à son fournisseur. « Rien
    // de déclaré » est une omission ; « déclaré mais illisible » est une réponse mal formée, et confondre
    // les deux ferait chercher une absence là où il y a une faute de frappe.
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
    // Deux chemins distincts peuvent se normaliser pareil (`a.b_c` et `a.b.c`), ou se collisionner après
    // troncature. Sans suffixe, le second écraserait le premier dans le schéma envoyé au modèle, et une
    // valeur partirait dans le mauvais champ, sans aucune erreur.
    //
    // ⚠️ LA MISE EN FORME ET LA DÉSAMBIGUÏSATION VIVENT DANS `./nommer`, PARTAGÉES AVEC L'IMPORT. Les deux
    // portées d'unicité diffèrent (ici l'outil, là l'espace), la contrainte de forme et le piège de
    // troncature sont identiques : les écrire deux fois ferait diverger la seconde le jour où l'on corrige
    // la première.
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
    const props = objet(noeud.properties);
    // ⚠️ L'ASYMÉTRIE AVEC LA RACINE EST VOULUE. À la racine, l'absence de propriétés dit « cet outil ne
    // prend aucun paramètre ». Imbriquée, elle dit « le serveur attend un objet dont il n'a pas déclaré la
    // forme », ce que nous ne savons pas remplir en sûreté.
    if (props === null || Object.keys(props).length === 0) {
      obstacles.push(`« ${chemin} » : le serveur n’a pas déclaré la forme de cet objet`);
      return;
    }
    const obligatoires = requis(noeud);
    for (const [cle, brut] of Object.entries(props)) {
      const sousChemin = chemin === '' ? cle : `${chemin}.${cle}`;
      const enfant = objet(brut);
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
      if (reduit.type === 'object' || (reduit.type === undefined && objet(reduit.properties) !== null)) {
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

  const propsRacine = objet(racine.properties);
  if (propsRacine !== null && Object.keys(propsRacine).length > 0) {
    descendre(racine, '', 1, true);
  }

  if (obstacles.length === 0) return { feuilles, raisonNonActivable: null };
  // Tous les obstacles, pas seulement le premier : le client ne peut pas corriger un schéma distant, mais
  // il doit pouvoir dire à son fournisseur ce qui bloque, et n'y revenir qu'une fois.
  return { feuilles: [], raisonNonActivable: obstacles.join(' ; ') };
}
