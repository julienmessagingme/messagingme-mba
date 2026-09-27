import { isValidDateStr } from './range';
/**
 * La grille de prix : ce qu'on facture, là où l'API de Meta dit ce que ça coûte. Le tarif des templates vient
 * de Meta ; le message de service et les deux RCS ne viennent d'aucune API et se saisissent.
 *
 * Une seule grille pour tous les espaces, en base, réglée depuis `/ops` sans déploiement : un client n'a pas à
 * fixer ce qu'on lui facture. Un prix négocié par espace serait une surcharge à ajouter.
 *
 * 🔴 Une marge sur le tarif Meta, pas une grille de prix de template : Meta change ses tarifs par pays et par
 * période, une grille saisie dériverait en restant plausible, et un client en tirerait un budget faux. Module
 * pur.
 */

/** Ce qu'un espace facture. Voyage en objet imbriqué, jamais en six champs à plat : cf. `grilleDepuisLigne`. */
export interface GrillePrix {
  /** En pourcent du tarif Meta. 100 = on facture le tarif Meta, et c'est le défaut. */
  margeTemplate: number;
  /** Prix d'un message de service, en centimes. */
  serviceCentimes: number;
  /** Messages de service offerts par mois. Par espace ici, par numéro chez Meta. */
  serviceFranchise: number;
  /** Date d'effet de la facturation des messages de service, en ISO court 'YYYY-MM-DD'. */
  serviceDepuis: string;
  rcsSimpleCentimes: number;
  rcsConversationnelCentimes: number;
}

/**
 * Ce que coûte un lot de RCS, en euros : deux tarifs, aucune franchise, aucun message de service. Une seule
 * formule pour les deux écrans qui l'affichent. Les prix de la grille sont en centimes, le résultat en euros :
 * c'est la conversion qu'on oublie en recopiant.
 */
export function coutRcsEuros(simple: number, conversationnel: number, g: GrillePrix): number {
  return Math.round((simple * g.rcsSimpleCentimes + conversationnel * g.rcsConversationnelCentimes)) / 100;
}

/**
 * Les défauts, qui sont des décisions. 🔴 `margeTemplate: 100` facture exactement le tarif Meta : un défaut qui
 * margerait tout seul ferait bouger un nombre que des clients ont déjà lu. `grilleDepuisLigne` retombe dessus
 * quand la ligne est absente, et un zéro y ferait lire « gratuit » sur tous les écrans de coût.
 */
export const GRILLE_DEFAUT: GrillePrix = {
  margeTemplate: 100,
  serviceCentimes: 2.48,
  serviceFranchise: 1000,
  serviceDepuis: '2026-10-01',
  rcsSimpleCentimes: 6,
  rcsConversationnelCentimes: 8,
};

/**
 * Le prix facturé d'un template, à partir du tarif rendu par Meta. Arrondi à 1e-4, comme les ratios de
 * `cost.ts` : deux arrondis différents feraient diverger la carte et le graphe.
 */
export function prixTemplate(tarifMeta: number, g: GrillePrix): number {
  return Math.round(tarifMeta * (g.margeTemplate / 100) * 10000) / 10000;
}

/** Un `numeric` Postgres arrive en chaîne (il ne rentre pas dans un `number` sans perte). Sans conversion, une
 *  addition de prix concaténerait des chaînes. */
function nombre(v: unknown, defaut: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return defaut;
}

/**
 * Un jour civil, lu depuis une colonne `date` : il se compare à un mois, donc il voyage en texte 'YYYY-MM-DD'.
 *
 * 🔴 En composantes locales : node-postgres rend une `date` en `Date` à minuit local, et `toISOString()`
 * rendrait la veille (minuit du 1er novembre à Paris vaut `2026-10-31T23:00Z`), donc la date d'effet de la
 * facturation reculerait d'un jour. Un test unitaire qui tourne en UTC ne distingue pas les deux écritures.
 */
function jour(v: unknown, defaut: string): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return defaut;
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const jj = String(v.getDate()).padStart(2, '0');
    return `${v.getFullYear()}-${mm}-${jj}`;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return defaut;
}

/**
 * La grille lue depuis sa ligne de réglages. Chaque champ retombe sur le défaut : une ligne lue avant sa
 * migration ne porte pas ces colonnes, et `tarif * (undefined / 100)` afficherait un prix vide (`NaN`). Un
 * objet imbriqué, pas six champs à plat : une liste de champs retransmise à la main dérive.
 */
export function grilleDepuisLigne(ligne: Record<string, unknown> | null | undefined): GrillePrix {
  const l = ligne ?? {};
  return {
    margeTemplate: nombre(l.prix_marge_template, GRILLE_DEFAUT.margeTemplate),
    serviceCentimes: nombre(l.prix_service_centimes, GRILLE_DEFAUT.serviceCentimes),
    serviceFranchise: nombre(l.prix_service_franchise, GRILLE_DEFAUT.serviceFranchise),
    serviceDepuis: jour(l.prix_service_depuis, GRILLE_DEFAUT.serviceDepuis),
    rcsSimpleCentimes: nombre(l.prix_rcs_centimes, GRILLE_DEFAUT.rcsSimpleCentimes),
    rcsConversationnelCentimes: nombre(l.prix_rcs_conv_centimes, GRILLE_DEFAUT.rcsConversationnelCentimes),
  };
}

/**
 * Les bornes de saisie d'une grille, celles des CHECK de la migration, pas d'autres : plus larges, Postgres
 * refuserait en 500 ; plus étroites, un réglage légitime serait refusé sans raison. `tests/prix-bornes.test.ts`
 * relit le SQL. Les plafonds attrapent une faute de frappe (248 au lieu de 2,48).
 */
export const BORNES_GRILLE = {
  margeTemplate: { min: 1, max: 1000 },
  centimes: { min: 0, max: 100 },
  franchise: { min: 0, max: 1_000_000 },
} as const;

// La date d'effet : `YYYY-MM-DD` et une date qui existe (`isValidDateStr`, format et aller-retour). `2026-02-31`
// passe le format mais ferait lever `$5::date` à l'écriture, donc un 500 ; `new Date` ne lève pas, il décale.

/**
 * Valide une grille saisie et la rend normalisée, ou nomme le champ fautif. Elle refuse, elle ne corrige pas :
 * ramener une valeur dans les bornes enregistrerait un prix que personne n'a choisi. Tous les champs sont
 * requis : une grille partielle obligerait à fusionner avec l'existant à l'écriture.
 */
export function valideGrille(entree: unknown): { ok: true; grille: GrillePrix } | { ok: false; champ: string } {
  const e = (entree ?? {}) as Record<string, unknown>;
  const borne = (v: unknown, min: number, max: number): boolean =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

  const { margeTemplate: mt, centimes: c, franchise: f } = BORNES_GRILLE;
  /**
   * Comparaison à epsilon : `2.47 * 100` vaut `247.00000000000003`, et l'égalité stricte refusait environ un
   * prix sur neuf à deux décimales.
   */
  const deuxDecimalesMax = (v: unknown): boolean =>
    typeof v === 'number' && Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;

  /** Deux décimales au plus, comme leur colonne (`numeric(6,2)` pour la marge) : une marge de 120,5 % est banale. */
  if (!borne(e.margeTemplate, mt.min, mt.max) || !deuxDecimalesMax(e.margeTemplate)) return { ok: false, champ: 'margeTemplate' };
  if (!borne(e.serviceCentimes, c.min, c.max) || !deuxDecimalesMax(e.serviceCentimes)) return { ok: false, champ: 'serviceCentimes' };
  if (!borne(e.serviceFranchise, f.min, f.max) || !Number.isInteger(e.serviceFranchise)) return { ok: false, champ: 'serviceFranchise' };
  if (!isValidDateStr(e.serviceDepuis)) return { ok: false, champ: 'serviceDepuis' };
  if (!borne(e.rcsSimpleCentimes, c.min, c.max) || !deuxDecimalesMax(e.rcsSimpleCentimes)) return { ok: false, champ: 'rcsSimpleCentimes' };
  if (!borne(e.rcsConversationnelCentimes, c.min, c.max) || !deuxDecimalesMax(e.rcsConversationnelCentimes)) return { ok: false, champ: 'rcsConversationnelCentimes' };

  return {
    ok: true,
    grille: {
      margeTemplate: e.margeTemplate as number,
      serviceCentimes: e.serviceCentimes as number,
      serviceFranchise: e.serviceFranchise as number,
      serviceDepuis: e.serviceDepuis,
      rcsSimpleCentimes: e.rcsSimpleCentimes as number,
      rcsConversationnelCentimes: e.rcsConversationnelCentimes as number,
    },
  };
}

/**
 * Les tarifs de Meta transformés en prix de vente : le point de passage unique de la marge. 🔴 Marger à la
 * source garantit que tous les consommateurs des tarifs affichent le même prix (sinon deux écrans annonceraient
 * deux montants pour les mêmes envois). Un tarif absent le reste : marger `null` ferait passer « sans tarif »
 * pour « gratuit ».
 */
export function tarifsFactures(
  brut: { marketing?: number | null; utility?: number | null; currency?: string | null },
  g: GrillePrix,
): { marketing: number | null; utility: number | null; currency: string | null } {
  const marge = (tarif: number | null | undefined): number | null => (tarif == null ? null : prixTemplate(tarif, g));
  return { marketing: marge(brut.marketing), utility: marge(brut.utility), currency: brut.currency ?? null };
}

/** Les seules catégories dont le prix se dérive du tarif Meta. Les autres se saisissent, ou ne se vendent pas. */
const CATEGORIES_MARGEES = new Set(['marketing', 'utility']);

/**
 * Un résumé de tarifs de Meta, transformé en prix de vente catégorie par catégorie : le chemin de la carte
 * « Détail par template » et de l'écran Campagnes, pour qu'une même campagne ne vaille pas deux prix. Seul
 * `ratePerMessage` devient un prix : `cost` et `totalCost` sont les charges réelles facturées par Meta, les
 * marger mélangerait vente et dépense. Type structurel : ce module pur ne connaît pas `src/meta/`.
 */
export function pricingFacture<C extends { ratePerMessage: number }, T extends { byCategory: Record<string, C> }>(
  brut: T,
  g: GrillePrix,
): T {
  const byCategory: Record<string, C> = {};
  for (const [cle, c] of Object.entries(brut.byCategory)) {
    // Seules les catégories de template sont margées : `service` et `authentication`, rendus par le même appel,
    // ne se dérivent d'aucun tarif Meta (le service se saisit).
    byCategory[cle] = CATEGORIES_MARGEES.has(cle) ? { ...c, ratePerMessage: prixTemplate(c.ratePerMessage, g) } : c;
  }
  return { ...brut, byCategory };
}
