// ⚠️ IMPORTS RELATIFS, PAS L'ALIAS `@/` : ce module est chargé par vitest depuis la suite racine (parité avec le
// serveur), où l'alias de Next n'est pas résolu.
import type { Locale } from './locale';

/**
 * LES FAMILLES D'UN BLOC CONDITION, côté console (RC5). Module PUR : lu par les écrans du constructeur, par les
 * analyses de graphe (`campaign-eligibility`, `mesures-scenario`) et par le canevas d'Analytics.
 *
 * Un bloc Condition a N familles nommées (10 au plus), chacune son groupe de clauses en ET ou en OU, testées de
 * haut en bas : le contact suit la PREMIÈRE vraie, sinon « Sinon ». Chaque famille sort par une poignée STABLE,
 * tirée de son code et non de sa place : réordonner ou supprimer une famille ne décroche aucune autre arête (le
 * Message rapide, qui numérote ses sorties par index, est le contre-modèle).
 *
 * 🔴 MIROIR de `famillesDeCondition` / `sortiesDeCondition` (`src/workflow/conditions.ts`), qui font AUTORITÉ : les
 * deux builds ne partagent aucun module. `tests/web-condition-familles-parity.test.ts` lit les mêmes blocs des
 * deux côtés et casse dès qu'ils divergent. Une divergence ferait dessiner une sortie que le moteur ne prend
 * jamais, ou cacher à l'analyse de fenêtre une branche qu'il prend.
 */

/** Nombre maximal de familles. ⚠️ Miroir de `MAX_FAMILLES_CONDITION`, qui fait autorité (il tronque). */
export const MAX_FAMILLES = 10;
/** La sortie « Sinon » : aucune famille n'est vraie. */
export const SORTIE_SINON = 'false';
/** Le code (et la poignée) de la famille d'un bloc d'avant les familles : sa sortie « Si réunie ». */
export const CODE_PREMIERE_FAMILLE = 'true';
const CODE_FAMILLE_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Un groupe de clauses, opaque ici : le constructeur de clauses en connaît la forme. */
export interface GroupeLike { match: 'all' | 'any'; clauses: unknown[] }
export interface FamilleLike { code: string; nom: string; groupe: GroupeLike }

const objet = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function groupeDe(v: unknown): GroupeLike {
  const d = objet(v);
  return { match: d.match === 'any' ? 'any' : 'all', clauses: Array.isArray(d.clauses) ? d.clauses : [] };
}

/**
 * Les familles d'un bloc, dans l'ordre où elles se testent. Un bloc SANS `familles` (tous ceux d'avant RC5) est UNE
 * famille de code `true` portant son `match` / `clauses` : sa carte reste « Si réunie » / « Sinon », et ses arêtes
 * ne bougent pas. Dès que `familles` est un tableau, il fait foi : au plus dix, code invalide ou en double écarté.
 */
export function famillesDeCondition(data: Record<string, unknown> | undefined): FamilleLike[] {
  const d = objet(data);
  if (!Array.isArray(d.familles)) return [{ code: CODE_PREMIERE_FAMILLE, nom: '', groupe: groupeDe(d) }];
  const vus = new Set<string>();
  const out: FamilleLike[] = [];
  for (const brut of d.familles) {
    if (out.length === MAX_FAMILLES) break;
    const f = objet(brut);
    const code = typeof f.code === 'string' ? f.code.trim() : '';
    if (!CODE_FAMILLE_RE.test(code) || code === SORTIE_SINON || vus.has(code)) continue;
    vus.add(code);
    // Le nom est rendu TEL QUEL (le serveur, lui, le rogne) : le champ de saisie le relit à chaque frappe, et un nom
    // rogné à la lecture mangerait l'espace qu'on vient de taper. `nomDeFamille` le rogne à l'affichage.
    out.push({ code, nom: typeof f.nom === 'string' ? f.nom : '', groupe: groupeDe(f.groupe) });
  }
  return out;
}

/** La poignée d'une famille : `true` pour la première d'origine, `famille:<code>` pour une famille ajoutée. */
export function poigneeDeFamille(code: string): string {
  return code === CODE_PREMIERE_FAMILLE ? CODE_PREMIERE_FAMILLE : `famille:${code}`;
}

/** Cette poignée est-elle celle d'une famille (de n'importe quel bloc Condition) ? « Sinon » n'en est pas une. */
export function estPoigneeDeFamille(handle: string): boolean {
  return handle === CODE_PREMIERE_FAMILLE || handle.startsWith('famille:');
}

/** Toutes les sorties d'un bloc Condition : une par famille, puis « Sinon ». Jamais `true` / `false` en dur ailleurs. */
export function sortiesDeCondition(node: { data?: Record<string, unknown> }): string[] {
  return [...famillesDeCondition(node.data).map((f) => poigneeDeFamille(f.code)), SORTIE_SINON];
}

/** Le nom d'une famille à l'écran : celui que le client lui a donné, sinon « Si réunie » (la première d'origine) ou
 *  « Famille N » (N = sa place). */
export function nomDeFamille(f: FamilleLike, index: number, locale: Locale): string {
  if (f.nom.trim() !== '') return f.nom.trim();
  if (f.code === CODE_PREMIERE_FAMILLE) return locale === 'en' ? 'If met' : 'Si réunie';
  return locale === 'en' ? `Group ${index + 1}` : `Famille ${index + 1}`;
}

/** Le libellé d'une sortie de bloc Condition (flèche du canevas d'Analytics), ou `null` si ce n'en est pas une. */
export function libelleSortieDeCondition(node: { data?: Record<string, unknown> }, handle: string, locale: Locale): string | null {
  if (handle === SORTIE_SINON) return locale === 'en' ? 'Otherwise' : 'Sinon';
  const familles = famillesDeCondition(node.data);
  const i = familles.findIndex((f) => poigneeDeFamille(f.code) === handle);
  return i < 0 ? null : nomDeFamille(familles[i]!, i, locale);
}

/**
 * Le `data` à écrire pour cette liste de familles (un patch, fusionné par le constructeur).
 *
 * 🔴 UNE SEULE FAMILLE D'ORIGINE, SANS NOM, S'ÉCRIT SOUS L'ANCIENNE FORME (`match` / `clauses`, sans `familles`). Un
 * bloc qu'on ne fait que retoucher garde ainsi la forme que tout lecteur connaît, et le moteur d'avant RC5 le lirait
 * encore juste. Dès qu'il y a une deuxième famille, ou un nom, la liste fait foi et l'ancienne forme est effacée
 * (`undefined` : la clé disparaît à l'enregistrement), pour qu'aucune « seconde vérité » ne reste dans le bloc.
 */
export function ecrireFamilles(familles: FamilleLike[]): Record<string, unknown> {
  const seule = familles.length === 1 ? familles[0] : undefined;
  if (seule && seule.code === CODE_PREMIERE_FAMILLE && seule.nom.trim() === '') {
    return { match: seule.groupe.match, clauses: seule.groupe.clauses, familles: undefined };
  }
  return { familles, match: undefined, clauses: undefined };
}

/** Un code neuf, unique dans le bloc. Court : il entre dans une poignée (`famille:<code>`). */
export function nouveauCodeDeFamille(existants: readonly string[], aleatoire: () => number = Math.random): string {
  for (;;) {
    const code = `f${Math.floor(aleatoire() * 36 ** 6).toString(36).padStart(6, '0')}`;
    if (!existants.includes(code)) return code;
  }
}
