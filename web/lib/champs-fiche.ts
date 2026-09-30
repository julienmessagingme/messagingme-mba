import { request } from './http';
import { OPERATEURS_FICHE_SEULS, type OperateurFicheSeul } from './contact-filters';
import { actionLabel, sentimentLabel, traiteParLabel } from './analyse';
import { libelleIntention } from './intentions';

/**
 * LA LISTE UNIQUE DES CHAMPS DE LA FICHE, CÔTÉ CONSOLE (chantier « Tout sur la fiche », lot 2b). Elle vient de
 * `GET /tenants/:t/champs-fiche` : l'écran ne recopie ni les champs filtrables, ni leurs opérateurs, ni leurs
 * valeurs. Seuls les LIBELLÉS des codes vivent ici, empruntés aux modules qui les tiennent déjà.
 *
 * 🔴 LES FILTRES D'ANALYSE NE SONT OFFERTS QUE SI LA ROUTE RÉPOND. Une API plus ancienne (404) ne sait pas les
 * appliquer : elle chercherait la clé dans les champs perso et ne trouverait personne. Un membre qui n'y a pas
 * accès (403) ne les voit pas non plus. Dans les deux cas la liste est vide, et un filtre déjà posé (brouillon de
 * campagne repris) reste affiché pour qu'on puisse le retirer.
 */

export type OperateurAnalyse = OperateurFicheSeul | 'empty' | 'not_empty';

/** Un champ de la dernière analyse qui se filtre, tel que la route le décrit. */
export interface ChampFiltrable {
  cle: string;
  libelle: readonly [string, string];
  nature: 'choix' | 'note' | 'oui_non' | 'date';
  /** Les codes possibles d'un champ à choix, dans l'ordre du serveur ; vide pour les autres. */
  valeurs: readonly string[];
  operateurs: readonly OperateurAnalyse[];
}

const OPERATEURS_CONNUS: readonly string[] = [...OPERATEURS_FICHE_SEULS, 'empty', 'not_empty'];
const NATURES: readonly string[] = ['choix', 'note', 'oui_non', 'date'];

/**
 * Un champ lu de la réponse, ou `null` s'il ne se filtre pas ou n'est pas compris. 🔴 Un opérateur inconnu écarte
 * le champ entier : l'écran ne saurait pas quelle valeur lui donner, et proposer un filtre à moitié compris est
 * pire que de ne pas le proposer.
 */
export function champFiltrableLu(x: unknown): ChampFiltrable | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const type = o.type && typeof o.type === 'object' ? (o.type as Record<string, unknown>) : {};
  const ops = Array.isArray(o.operateurs) ? o.operateurs : [];
  const libelle = Array.isArray(o.libelle) ? o.libelle : [];
  if (typeof o.cle !== 'string' || ops.length === 0) return null;
  if (!ops.every((op): op is OperateurAnalyse => typeof op === 'string' && OPERATEURS_CONNUS.includes(op))) return null;
  if (typeof type.nature !== 'string' || !NATURES.includes(type.nature)) return null;
  if (libelle.length !== 2 || !libelle.every((l): l is string => typeof l === 'string')) return null;
  const valeurs = Array.isArray(type.valeurs) ? type.valeurs.filter((v): v is string => typeof v === 'string') : [];
  if (type.nature === 'choix' && valeurs.length === 0) return null;
  return {
    cle: o.cle, libelle: [libelle[0]!, libelle[1]!], nature: type.nature as ChampFiltrable['nature'],
    valeurs: type.nature === 'choix' ? valeurs : [], operateurs: ops,
  };
}

/** Les champs filtrables d'une réponse de la route, dans son ordre. */
export function champsFiltrablesDe(reponse: unknown): ChampFiltrable[] {
  const champs = reponse && typeof reponse === 'object' ? (reponse as { champs?: unknown }).champs : null;
  return Array.isArray(champs) ? champs.map(champFiltrableLu).filter((c): c is ChampFiltrable => c !== null) : [];
}

const enCours = new Map<string, Promise<ChampFiltrable[]>>();

/**
 * Les champs filtrables d'un espace, lus une fois par session d'écran (plusieurs blocs Condition d'un scénario
 * les demandent en même temps). Un échec rend une liste vide et n'est pas gardé : l'appel suivant réessaie.
 */
export function chargerChampsFiltrables(tenantId: string): Promise<ChampFiltrable[]> {
  const deja = enCours.get(tenantId);
  if (deja) return deja;
  const p = request<unknown>(`/tenants/${tenantId}/champs-fiche`)
    .then(champsFiltrablesDe)
    .catch(() => { enCours.delete(tenantId); return [] as ChampFiltrable[]; });
  enCours.set(tenantId, p);
  return p;
}

type Tr = (fr: string, en?: string) => string;

/** Le libellé d'un code d'analyse. Une valeur inconnue s'affiche telle quelle, jamais vide. */
export function libelleValeurAnalyse(cle: string, code: string, t: Tr): string {
  switch (cle) {
    case 'analyse_intention': return libelleIntention(code, t);
    case 'analyse_sentiment': return sentimentLabel(code, t);
    case 'analyse_action': return actionLabel(code, t);
    case 'analyse_traitee_par': return traiteParLabel(code, t);
    default: return code;
  }
}

/** Le libellé d'un opérateur, selon la nature du champ (« vide » d'une date veut dire « jamais analysée »). */
export function libelleOperateurAnalyse(op: OperateurAnalyse, nature: ChampFiltrable['nature'], t: Tr): string {
  switch (op) {
    case 'in': return t('est l’un de', 'is one of');
    case 'gte': return t('au moins', 'at least');
    case 'lte': return t('au plus', 'at most');
    case 'is_true': return t('oui', 'yes');
    case 'is_false': return t('non', 'no');
    case 'newer_than_days': return t('depuis moins de', 'less than');
    case 'empty': return nature === 'date' ? t('jamais analysée', 'never analysed') : t('sans valeur', 'no value');
    case 'not_empty': return nature === 'date' ? t('déjà analysée', 'already analysed') : t('renseigné', 'filled');
  }
}

/** Un filtre d'analyse complet et valide pour ce champ : l'écran ne propose jamais un filtre que le serveur refuserait. */
export function filtreAnalyseParDefaut(champ: ChampFiltrable, op: OperateurAnalyse = champ.operateurs[0]!): { key: string; op: OperateurAnalyse; value: string } {
  if (op === 'in') return { key: champ.cle, op, value: champ.valeurs[0] ?? '' };
  if (op === 'gte') return { key: champ.cle, op, value: '7' };
  if (op === 'lte') return { key: champ.cle, op, value: '3' };
  if (op === 'newer_than_days') return { key: champ.cle, op, value: '30' };
  return { key: champ.cle, op, value: '' };
}

/** Une ligne de filtre porte-t-elle sur la dernière analyse ? Par la liste reçue, ou par un opérateur de colonne. */
export function estFiltreAnalyse(f: { key: string; op: string }, champs: readonly ChampFiltrable[]): boolean {
  return champs.some((c) => c.cle === f.key) || (OPERATEURS_FICHE_SEULS as readonly string[]).includes(f.op);
}
