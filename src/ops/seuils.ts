/**
 * LES SEUILS DE CAPACITÉ, RÉGLABLES DANS `/ops` (refonte, lot 4). Les valeurs par défaut sont celles de la spec
 * (`docs/superpowers/specs/2026-10-27-ops-refonte-design.md`, bancs du 2026-10-27) ; Julien les règle dans l'onglet
 * Réglages, une note obligatoire signée de son auteur, comme la grille de prix. Pur : la validation refuse et nomme le
 * champ fautif, elle ne corrige pas (ramener une valeur dans ses bornes enregistrerait un seuil que personne n'a choisi).
 */

export interface Seuil { orange: number; rouge: number }

export interface SeuilsCapacite {
  /** Retard des accusés de Meta, en secondes (p95 du quart d'heure ou âge du plus vieux en attente). */
  accuses: Seuil;
  /** Retard des messages entrants, en secondes. */
  entrants: Seuil;
  /** Connexions de la base, en pourcentage de ce qu'elle accepte. */
  connexions: Seuil;
  /** Part des réponses 5xx de l'API sur l'heure, en pourcentage. */
  erreurs: Seuil;
  /** Âge du dernier battement d'un worker, en secondes. */
  battement: Seuil;
  /** Processeur de la base, moyenne sur 15 minutes, en pourcentage (Cockpit). */
  processeurBase: Seuil;
  /** Processeur de la machine des workers, moyenne sur 15 minutes, en pourcentage (Cockpit). */
  processeurMachine: Seuil;
  /** Mémoire d'un worker, en pourcentage de la limite de son conteneur. */
  memoireWorker: Seuil;
  /** La 2e copie d'API sur 7 jours : orange en nombre de montées, rouge en minutes cumulées (deux unités, aucun ordre). */
  secondeCopie: Seuil;
}

export const SEUILS_DEFAUT: SeuilsCapacite = {
  accuses: { orange: 60, rouge: 120 },
  entrants: { orange: 5, rouge: 30 },
  connexions: { orange: 70, rouge: 85 },
  erreurs: { orange: 1, rouge: 5 },
  battement: { orange: 120, rouge: 300 },
  processeurBase: { orange: 60, rouge: 80 },
  processeurMachine: { orange: 60, rouge: 80 },
  memoireWorker: { orange: 70, rouge: 85 },
  secondeCopie: { orange: 3, rouge: 60 },
};

/** Les bornes de chaque valeur : au-delà, un seuil ne veut plus rien dire (ou ne se déclencherait jamais). */
export const BORNES_SEUILS: Record<keyof SeuilsCapacite, { min: number; max: number }> = {
  accuses: { min: 1, max: 3600 },
  entrants: { min: 1, max: 3600 },
  connexions: { min: 10, max: 100 },
  erreurs: { min: 0.1, max: 100 },
  battement: { min: 30, max: 3600 },
  processeurBase: { min: 10, max: 100 },
  processeurMachine: { min: 10, max: 100 },
  memoireWorker: { min: 10, max: 100 },
  secondeCopie: { min: 1, max: 10_080 },
};

export const CLES_SEUILS = Object.keys(SEUILS_DEFAUT) as Array<keyof SeuilsCapacite>;

/** Les seuils dont l'orange et le rouge se mesurent dans deux unités différentes : leur ordre ne se juge pas. */
const SANS_ORDRE: ReadonlySet<keyof SeuilsCapacite> = new Set(['secondeCopie']);

/**
 * Valide des seuils saisis : TOUS les signaux, chacun avec son orange et son rouge, dans leurs bornes, l'orange sous le
 * rouge. Une clé inconnue est refusée (une faute de frappe ne doit pas passer pour un réglage). Rend le champ fautif,
 * `secondeCopie.rouge` par exemple.
 */
export function valideSeuils(entree: unknown): { ok: true; seuils: SeuilsCapacite } | { ok: false; champ: string } {
  if (typeof entree !== 'object' || entree === null || Array.isArray(entree)) return { ok: false, champ: 'seuils' };
  const e = entree as Record<string, unknown>;
  for (const cle of Object.keys(e)) {
    if (!(CLES_SEUILS as string[]).includes(cle)) return { ok: false, champ: cle };
  }
  const sortie = {} as SeuilsCapacite;
  for (const cle of CLES_SEUILS) {
    const s = e[cle];
    if (typeof s !== 'object' || s === null) return { ok: false, champ: cle };
    const { orange, rouge } = s as Record<string, unknown>;
    const { min, max } = BORNES_SEUILS[cle];
    const borne = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    if (!borne(orange)) return { ok: false, champ: `${cle}.orange` };
    if (!borne(rouge)) return { ok: false, champ: `${cle}.rouge` };
    if (!SANS_ORDRE.has(cle) && orange >= rouge) return { ok: false, champ: `${cle}.orange` };
    sortie[cle] = { orange, rouge };
  }
  return { ok: true, seuils: sortie };
}

/**
 * Des seuils relus en base : chaque signal valide garde sa valeur, un signal absent ou abîmé reprend son défaut (un
 * signal ajouté par un lot suivant n'a pas encore de valeur enregistrée). Jamais d'exception : l'écran et les alertes
 * doivent toujours avoir des seuils.
 */
export function seuilsEnregistres(enregistres: unknown): SeuilsCapacite {
  const e = (typeof enregistres === 'object' && enregistres !== null ? enregistres : {}) as Record<string, unknown>;
  const sortie = { ...SEUILS_DEFAUT };
  for (const cle of CLES_SEUILS) {
    const v = valideSeuils({ ...SEUILS_DEFAUT, [cle]: e[cle] });
    if (v.ok) sortie[cle] = v.seuils[cle];
  }
  return sortie;
}
