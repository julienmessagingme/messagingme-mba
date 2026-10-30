import { facteurCommission } from '../agent/devise';
import { MARCHE_AUTRES, marcheDuPays } from './marches-meta';

/**
 * LE PRIX D'UN MESSAGE SUR LA LIGNE DE CRÉDIT (spec `docs/superpowers/specs/2026-10-30-credit-whatsapp-design.md`).
 *
 * 🔴 Le seul calcul du prix d'un message : la garde avant l'envoi, l'estimation d'une campagne, l'ajustement à l'accusé,
 * la régularisation et les écrans l'importent ; aucun ne recopie la formule. Le prix est celui de la grille que Meta
 * publie en euros (marché du destinataire, catégorie, palier), majoré de notre commission, en micro-euros, arrondi une
 * seule fois.
 */

export const CATEGORIES_META = ['marketing', 'utility', 'authentication', 'authentication_international', 'service'] as const;
export type CategorieMeta = (typeof CATEGORIES_META)[number];

/** Les catégories d'un modèle : un modèle dont Meta ne rend pas la catégorie se provisionne au plus cher d'entre elles. */
const CATEGORIES_MODELES: readonly CategorieMeta[] = ['marketing', 'utility', 'authentication', 'authentication_international'];

/**
 * La catégorie de Meta, lue dans un accusé (`pricing.category`), `pricing_analytics` (`PRICING_CATEGORY`) ou le fichier
 * de la grille. Un envoi par la Marketing Messages API remonte en `marketing_lite`, au prix du marketing.
 */
export function normaliserCategorie(lue: string | null | undefined): CategorieMeta | null {
  if (typeof lue !== 'string') return null;
  const c = lue.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (c === 'marketing_lite') return 'marketing';
  return (CATEGORIES_META as readonly string[]).includes(c) ? (c as CategorieMeta) : null;
}

export interface TarifGrille {
  marche: string;
  categorie: CategorieMeta;
  /** 0 = le tarif de base ; sinon le seuil bas d'un palier de volume (messages facturés du mois). */
  palier: number;
  /** Le tarif de Meta, sans commission, en micro-euros. */
  prixMicroEur: number;
}

export interface GrilleMeta {
  id: string;
  /** 'AAAA-MM-JJ'. */
  enVigueurLe: string;
  tarifs: readonly TarifGrille[];
}

/** Le seuil bas d'un palier tel que `pricing_analytics` le rend (« 25000001:50000000 ») ; illisible ou absent = 0. */
export function palierDeTier(tier: string | null | undefined): number {
  if (typeof tier !== 'string') return 0;
  const bas = Number(tier.split(':')[0]);
  return Number.isInteger(bas) && bas > 0 ? bas : 0;
}

/** Le tarif d'un marché pour une catégorie : la ligne du plus haut palier qui ne dépasse pas celui demandé. */
function tarifDuMarche(g: GrilleMeta, marche: string, categorie: CategorieMeta, palier: number): number | null {
  let meilleur: TarifGrille | null = null;
  for (const t of g.tarifs) {
    if (t.marche !== marche || t.categorie !== categorie || t.palier > palier) continue;
    if (meilleur === null || t.palier > meilleur.palier) meilleur = t;
  }
  return meilleur?.prixMicroEur ?? null;
}

/** Le plus cher des tarifs de base d'une catégorie, tous marchés confondus. */
function plusCher(g: GrilleMeta, categories: readonly CategorieMeta[]): number | null {
  let max: number | null = null;
  for (const t of g.tarifs) {
    if (t.palier !== 0 || !categories.includes(t.categorie)) continue;
    if (max === null || t.prixMicroEur > max) max = t.prixMicroEur;
  }
  return max;
}

/**
 * Le prix d'un message, commission comprise, en micro-euros, ou `null` quand la grille n'a aucun tarif pour lui (le
 * message ne peut alors pas partir sur la ligne : la garde le refuse plutôt que de l'envoyer gratuitement).
 *
 * - Destinataire sans pays (identifiant Meta seul, plage inconnue) : le plus cher de la catégorie, tous marchés.
 * - Catégorie inconnue (modèle dont Meta ne rend pas la catégorie) : le plus cher des catégories de modèle.
 * - `authentication` se provisionne au plus cher de l'authentification et de l'authentification internationale du
 *   marché : Meta choisit l'une ou l'autre selon le pays de l'entreprise, la régularisation rend l'écart.
 * - Un marché absent de la grille retombe sur « Other ».
 */
export function prixMessage(
  g: GrilleMeta,
  pays: string | null,
  categorie: CategorieMeta | null,
  commissionPct: number,
  palier = 0,
  /** La catégorie telle que Meta l'a FACTURÉE (l'accusé) : l'authentification n'y prend plus le plus cher des deux tarifs. */
  exacte = false,
): number | null {
  const categories: readonly CategorieMeta[] = categorie === null
    ? CATEGORIES_MODELES
    : categorie === 'authentication' && !exacte ? ['authentication', 'authentication_international'] : [categorie];
  let base: number | null = null;
  if (pays !== null) {
    for (const marche of [marcheDuPays(pays), MARCHE_AUTRES]) {
      for (const c of categories) {
        const t = tarifDuMarche(g, marche, c, palier);
        if (t !== null && (base === null || t > base)) base = t;
      }
      if (base !== null) break;
    }
  }
  if (base === null) base = plusCher(g, categories);
  if (base === null) return null;
  return Math.round(base * facteurCommission(commissionPct));
}

/**
 * Une grille est périmée quand elle est entrée en vigueur avant le trimestre en cours (UTC) : Meta change ses tarifs au
 * 1er jour d'un trimestre, avec un mois de préavis. `/ops` le signale, rien ne s'arrête.
 */
export function grillePerimee(enVigueurLe: string, maintenant: Date): boolean {
  const debutTrimestre = new Date(Date.UTC(maintenant.getUTCFullYear(), Math.floor(maintenant.getUTCMonth() / 3) * 3, 1));
  return enVigueurLe < debutTrimestre.toISOString().slice(0, 10);
}
