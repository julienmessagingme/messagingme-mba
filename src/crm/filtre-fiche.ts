import type { AnalyseDeFiche } from '../analysis/fiche';
import { champFiche, type ChampFiche, type CleFicheFixe } from './champs-fiche';

/**
 * FILTRER SUR LA DERNIÈRE ANALYSE D'UNE FICHE (chantier « Tout sur la fiche », lot 2b). Module pur : ni base, ni
 * horloge, ni import qui tire `pg`, parce que le bloc Condition d'un scénario (`src/workflow/conditions.ts`) le lit.
 *
 * Trois lecteurs, une seule sémantique : la liste des contacts et le ciblage d'une campagne (`clauseFiltreFiche`,
 * posée par `buildContactWhere`), le bloc Condition (`evaluerFiltreFiche`), et au lot 3 le déclencheur « un champ
 * d'analyse devient ». Un seuil ou une valeur absente qui ne se lirait pas pareil des deux côtés ferait qu'une
 * campagne vise une personne que la condition du scénario écarte ; `tests/filtre-fiche.test.ts` tient la parité.
 *
 * Les filtres voyagent dans `fieldFilters` (amendement 6 de la spec) : un membre neuf de `ContactFilters` serait
 * IGNORÉ par un serveur plus ancien, et l'audience d'une campagne deviendrait l'espace entier. Un serveur ancien
 * qui reçoit une clé d'analyse la cherche dans le jsonb, où elle n'est jamais : il ne trouve personne.
 */

/** Les opérateurs qu'un champ perso (jsonb, texte) ne connaît pas : ils n'ont de sens que sur une colonne typée. */
export const OPERATEURS_FICHE_SEULS = ['in', 'gte', 'lte', 'is_true', 'is_false', 'newer_than_days'] as const;
export type OperateurFicheSeul = (typeof OPERATEURS_FICHE_SEULS)[number];
export type OperateurFiche = OperateurFicheSeul | 'empty' | 'not_empty';

export function estOperateurFicheSeul(op: unknown): op is OperateurFicheSeul {
  return typeof op === 'string' && (OPERATEURS_FICHE_SEULS as readonly string[]).includes(op);
}

/**
 * Clé filtrable, et la colonne de `contacts` qui la porte. 🔴 CARTE FERMÉE : c'est la SEULE source des noms de
 * colonne interpolés dans le SQL d'un filtre, jamais la clé reçue. Elle n'est jamais envoyée à la console. Le
 * sujet n'y est pas (décision 12 : un texte libre ne se filtre pas), ni le risque, qui a son propre filtre.
 */
const COLONNE_DU_FILTRE = {
  analyse_intention: 'analyse_intention',
  analyse_sentiment: 'analyse_sentiment',
  analyse_satisfaction: 'analyse_satisfaction',
  analyse_urgence: 'analyse_urgence',
  analyse_resolue: 'analyse_resolue',
  analyse_traitee_par: 'analyse_traitee_par',
  analyse_action: 'analyse_action',
  analyse_le: 'analyse_le',
} as const satisfies Partial<Record<CleFicheFixe, string>>;

export type CleFiltrable = keyof typeof COLONNE_DU_FILTRE;
export const CLES_FILTRABLES = Object.keys(COLONNE_DU_FILTRE) as CleFiltrable[];

export function estCleFiltrable(cle: unknown): cle is CleFiltrable {
  return typeof cle === 'string' && Object.hasOwn(COLONNE_DU_FILTRE, cle);
}

/** Bornes des valeurs saisies : une note va de 0 à 10 (le CHECK de 0196), une ancienneté d'un jour à dix ans. */
const NOTE_MIN = 0;
const NOTE_MAX = 10;
const JOURS_MIN = 1;
const JOURS_MAX = 3650;

/** Les opérateurs d'un champ, dérivés de son type. Un champ qui n'est pas filtrable n'en a aucun. */
export function operateursDuChamp(champ: ChampFiche): readonly OperateurFiche[] {
  if (!estCleFiltrable(champ.cle)) return [];
  switch (champ.type.nature) {
    case 'choix': return ['in', 'empty', 'not_empty'];
    case 'note': return ['gte', 'lte', 'empty', 'not_empty'];
    case 'oui_non': return ['is_true', 'is_false', 'empty', 'not_empty'];
    case 'date': return ['newer_than_days', 'empty', 'not_empty'];
    case 'texte': return [];
  }
}

/** Un filtre d'analyse relu et ramené à sa forme canonique : la valeur est celle qui part sur le fil. */
export interface FiltreFiche { cle: CleFiltrable; op: OperateurFiche; valeur: string }

export type LectureFiltreFiche = { ok: true; filtre: FiltreFiche } | { ok: false; raison: string };

const entier = (v: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
};

/**
 * Relit un filtre d'analyse venu d'une source non fiable. 🔴 Ne devine jamais : un opérateur que le champ ne
 * connaît pas, une valeur hors de sa liste ou de ses bornes, un choix vide, rendent un refus. Un filtre ignoré
 * élargirait l'audience, et une campagne construite dessus partirait à tout l'espace.
 */
export function lireFiltreFiche(cle: CleFiltrable, op: unknown, valeur: unknown): LectureFiltreFiche {
  const champ = champFiche(cle);
  const libelle = champ?.libelle[0] ?? cle;
  const permis = champ ? operateursDuChamp(champ) : [];
  if (typeof op !== 'string' || !(permis as readonly string[]).includes(op)) {
    return { ok: false, raison: `filtre « ${libelle} » : opérateur invalide (${permis.join(', ')})` };
  }
  const o = op as OperateurFiche;
  const v = typeof valeur === 'string' ? valeur : '';
  if (o === 'empty' || o === 'not_empty' || o === 'is_true' || o === 'is_false') {
    return { ok: true, filtre: { cle, op: o, valeur: '' } };
  }
  if (o === 'in') {
    const valeurs = champ?.type.nature === 'choix' ? champ.type.valeurs : [];
    const choisis = [...new Set(v.split(',').map((s) => s.trim()).filter((s) => s !== ''))];
    if (choisis.length === 0) return { ok: false, raison: `filtre « ${libelle} » : choisissez au moins une valeur` };
    const inconnu = choisis.find((s) => !valeurs.includes(s));
    if (inconnu !== undefined) return { ok: false, raison: `filtre « ${libelle} » : valeur inconnue « ${inconnu} »` };
    return { ok: true, filtre: { cle, op: o, valeur: choisis.join(',') } };
  }
  if (o === 'newer_than_days') {
    const n = entier(v, JOURS_MIN, JOURS_MAX);
    if (n === null) return { ok: false, raison: `filtre « ${libelle} » : un nombre de jours entre ${JOURS_MIN} et ${JOURS_MAX}` };
    return { ok: true, filtre: { cle, op: o, valeur: String(n) } };
  }
  // gte, lte : une note.
  const n = entier(v, NOTE_MIN, NOTE_MAX);
  if (n === null) return { ok: false, raison: `filtre « ${libelle} » : une note entre ${NOTE_MIN} et ${NOTE_MAX}` };
  return { ok: true, filtre: { cle, op: o, valeur: String(n) } };
}

/**
 * La clause SQL d'un filtre d'analyse, sur la colonne que désigne la carte fermée. `add` pousse un paramètre et
 * rend son placeholder. Égalités nues et comparaisons sur la colonne : `null` (fiche jamais analysée, ou note sans
 * mesure) ne satisfait aucune comparaison, et seul `empty` le retient.
 *
 * 🔴 Un filtre qui ne se relit pas rend `false` (personne), JAMAIS l'absence de clause (tout le monde) : cette
 * fonction peut recevoir des filtres qui n'ont pas traversé `lireFiltreFiche`.
 */
export function clauseFiltreFiche(cle: CleFiltrable, op: unknown, valeur: unknown, add: (v: unknown) => string): string {
  const lu = lireFiltreFiche(cle, op, valeur);
  if (!lu.ok) return 'false';
  const col = COLONNE_DU_FILTRE[cle];
  const f = lu.filtre;
  switch (f.op) {
    case 'empty': return `${col} is null`;
    case 'not_empty': return `${col} is not null`;
    case 'is_true': return `${col} is true`;
    case 'is_false': return `${col} is false`;
    case 'in': return `${col} = any(${add(f.valeur.split(','))}::text[])`;
    case 'gte': return `${col} >= ${add(Number(f.valeur))}::int`;
    case 'lte': return `${col} <= ${add(Number(f.valeur))}::int`;
    case 'newer_than_days': return `${col} > now() - (${add(Number(f.valeur))}::int * interval '1 day')`;
  }
}

/** La valeur d'un champ d'analyse sur une copie, avec son type ; `null` quand la fiche n'a pas été analysée. */
function valeurDeLaCopie(cle: CleFiltrable, a: AnalyseDeFiche | null): string | number | boolean | Date | null {
  if (a === null) return null;
  switch (cle) {
    case 'analyse_intention': return a.intention;
    case 'analyse_sentiment': return a.sentiment;
    case 'analyse_satisfaction': return a.satisfaction;
    case 'analyse_urgence': return a.urgence;
    case 'analyse_resolue': return a.resolue;
    case 'analyse_traitee_par': return a.traiteePar;
    case 'analyse_action': return a.action;
    case 'analyse_le': return a.analyseLe;
  }
}

/**
 * Le même filtre, évalué sur une copie en mémoire : le miroir de `clauseFiltreFiche`, opérateur par opérateur.
 * Un filtre qui ne se relit pas rend `false`, comme sa clause SQL. `maintenant` est fourni par l'appelant.
 */
export function evaluerFiltreFiche(
  cle: CleFiltrable, op: unknown, valeur: unknown, analyse: AnalyseDeFiche | null, maintenant: Date,
): boolean {
  const lu = lireFiltreFiche(cle, op, valeur);
  if (!lu.ok) return false;
  const f = lu.filtre;
  const v = valeurDeLaCopie(cle, analyse);
  switch (f.op) {
    case 'empty': return v === null;
    case 'not_empty': return v !== null;
    case 'is_true': return v === true;
    case 'is_false': return v === false;
    case 'in': return typeof v === 'string' && f.valeur.split(',').includes(v);
    case 'gte': return typeof v === 'number' && v >= Number(f.valeur);
    case 'lte': return typeof v === 'number' && v <= Number(f.valeur);
    case 'newer_than_days':
      return v instanceof Date && v.getTime() > maintenant.getTime() - Number(f.valeur) * 86_400_000;
  }
}

/** Le texte d'un champ d'analyse (dates en ISO), pour les clauses qui lisent une valeur brute ; `null` sans copie. */
export function texteDeLaCopie(cle: string, a: AnalyseDeFiche | null): string | null {
  if (a === null) return null;
  if (cle === 'analyse_sujet') return a.sujet === '' ? null : a.sujet;
  if (!estCleFiltrable(cle)) return null;
  const v = valeurDeLaCopie(cle, a);
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}
