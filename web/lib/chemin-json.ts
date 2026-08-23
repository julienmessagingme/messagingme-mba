/**
 * Transforme un payload JSON reçu d'un outil tiers en ARBRE affichable, où chaque feuille porte le chemin
 * qui permettra de la relire côté serveur (`client.tel`, `lignes[0].prix`).
 *
 * ⚠️ GRAMMAIRE DUPLIQUÉE avec `src/webhook-entrant/chemin.ts`, qui LIT ces chemins pendant que ce module les
 * FABRIQUE. Les deux ne partagent aucun paquet (le front a son propre tsconfig). Un même jeu de chemins d'or
 * est figé dans les tests des DEUX côtés : c'est lui qui garde l'invariant. Filet supplémentaire : la route
 * de configuration REFUSE un chemin qu'elle ne sait pas lire, donc une divergence sort en 4xx visible au lieu
 * de produire un mapping muet.
 *
 * Module PUR : aucun React, aucun appel réseau. Testé par la suite unitaire du front.
 */

/** Une clé adressable ne contient ni point, ni crochet. Une clé qui en contient est INATTEIGNABLE. */
const CLE_ADRESSABLE = /^[^.[\]]+$/;

/** Au-delà, on ne déplie plus : un payload profond rendrait l'écran illisible avant d'être utile. */
export const PROFONDEUR_MAX = 8;
/** Éléments montrés par tableau. Un export de 5 000 lignes n'a pas à peupler l'arbre. */
export const ELEMENTS_MAX = 25;

export interface NoeudJson {
  /** Chemin exploitable, ou '' quand la clé n'est pas adressable (elle contient un point ou un crochet). */
  chemin: string;
  /** Ce qui s'affiche à gauche : la clé, ou `[0]` pour un élément de tableau. */
  cle: string;
  type: 'objet' | 'tableau' | 'valeur';
  /** Aperçu court de la valeur, pour que l'utilisateur reconnaisse ce qu'il attache. */
  apercu: string;
  /** Attachable à un champ : valeur SCALAIRE, et chemin adressable. */
  attachable: boolean;
  enfants: NoeudJson[];
}

/** Même définition que `estScalaire` côté serveur : ce qui se stocke dans un champ de contact. */
export function estScalaire(v: unknown): v is string | number | boolean {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  return typeof v === 'number' && Number.isFinite(v);
}

/** Aperçu court d'une valeur, pour la colonne de droite de l'arbre. */
export function apercuValeur(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (Array.isArray(v)) return `${v.length} élément${v.length > 1 ? 's' : ''}`;
  if (typeof v === 'object') {
    const n = Object.keys(v as object).length;
    return `${n} champ${n > 1 ? 's' : ''}`;
  }
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function typeDe(v: unknown): NoeudJson['type'] {
  if (Array.isArray(v)) return 'tableau';
  if (v !== null && typeof v === 'object') return 'objet';
  return 'valeur';
}

function noeud(cle: string, chemin: string | null, valeur: unknown, profondeur: number): NoeudJson {
  return {
    chemin: chemin ?? '',
    cle,
    type: typeDe(valeur),
    apercu: apercuValeur(valeur),
    attachable: chemin !== null && estScalaire(valeur),
    enfants: enfantsDe(valeur, chemin, profondeur + 1),
  };
}

/**
 * Enfants d'une valeur. `base` est le chemin du parent : `''` à la racine, et `null` quand le parent
 * lui-même n'est pas adressable.
 *
 * L'inadressabilité se PROPAGE : dès qu'un segment n'est pas adressable, tout son sous-arbre l'est aussi.
 * Autrement l'écran proposerait un chemin tronqué, qui pointerait ailleurs dans le payload.
 */
function enfantsDe(valeur: unknown, base: string | null, profondeur: number): NoeudJson[] {
  if (profondeur >= PROFONDEUR_MAX) return [];

  if (Array.isArray(valeur)) {
    return valeur.slice(0, ELEMENTS_MAX).map((v, i) => noeud(`[${i}]`, base === null ? null : `${base}[${i}]`, v, profondeur));
  }

  if (valeur !== null && typeof valeur === 'object') {
    return Object.entries(valeur as Record<string, unknown>).map(([cle, v]) => {
      // Clé inadressable (elle contient un point ou un crochet), ou parent déjà perdu : aucun chemin. Le
      // noeud reste AFFICHÉ, pour que l'utilisateur voie ce qu'il a reçu au lieu de chercher une clé absente.
      const chemin = base === null || !CLE_ADRESSABLE.test(cle) ? null : (base === '' ? cle : `${base}.${cle}`);
      return noeud(cle, chemin, v, profondeur);
    });
  }

  return [];
}

/**
 * Arbre des noeuds de premier niveau d'un payload. Un payload scalaire (ou absent) rend une liste vide :
 * il n'y a rien à attacher.
 */
export function arbreDuPayload(payload: unknown): NoeudJson[] {
  if (payload === null || payload === undefined || typeof payload !== 'object') return [];
  return enfantsDe(payload, '', 0);
}

/** Tous les chemins ATTACHABLES d'un arbre, dans l'ordre d'affichage. Sert aux tests et à la recherche. */
export function cheminsAttachables(noeuds: readonly NoeudJson[]): string[] {
  const out: string[] = [];
  const parcours = (liste: readonly NoeudJson[]): void => {
    for (const n of liste) {
      if (n.attachable) out.push(n.chemin);
      parcours(n.enfants);
    }
  };
  parcours(noeuds);
  return out;
}
