/**
 * Quantitatif > Shopify (plan `docs/superpowers/plans/2026-10-30-revenus-attribues-lot-2.md`, tâche 5) : la réponse de
 * `/stats/ventes` (`ChiffreVentes`, `src/shopify/chiffre.ts`), lue défensivement, et ses montants formatés.
 *
 * 🔴 LES MONTANTS RESTENT DES DÉCIMAUX EN TEXTE, sommés par la base, par devise : l'écran ne les additionne jamais (un
 * flottant les arrondirait, deux devises ne s'additionnent pas). `Number` ne sert qu'à l'affichage.
 */

export const SOURCES_VENTES = ['campagne', 'relance_panier', 'scenario', 'agent', 'agent_meta'] as const;
export type SourceVente = (typeof SOURCES_VENTES)[number];

export interface TotalVentesVue { devise: string; brut: string; prouve: string; commandes: number }
export interface SourceVentesVue extends TotalVentesVue { source: SourceVente; campaignId: string | null; nom: string | null }
export interface BlocVentesVue { totaux: TotalVentesVue[]; sources: SourceVentesVue[] }
export interface ChiffreVentesVue {
  reel: BlocVentesVue;
  test: BlocVentesVue;
  paniers: { relances: number; recuperes: number; montants: Array<{ devise: string; montant: string }>; recuperesTest: number };
}

type Objet = Record<string, unknown>;
const estObjet = (v: unknown): v is Objet => typeof v === 'object' && v !== null && !Array.isArray(v);
const decimal = (v: unknown): v is string => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v);
const devise = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
const entier = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
const texteOuNul = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function lireTotal(v: unknown): TotalVentesVue | null {
  if (!estObjet(v) || !devise(v.devise) || !decimal(v.brut) || !decimal(v.prouve)) return null;
  return { devise: v.devise, brut: v.brut, prouve: v.prouve, commandes: entier(v.commandes) };
}

function lireSource(v: unknown): SourceVentesVue | null {
  const total = lireTotal(v);
  if (total === null || !estObjet(v) || !(SOURCES_VENTES as readonly unknown[]).includes(v.source)) return null;
  return { source: v.source as SourceVente, campaignId: texteOuNul(v.campaignId), nom: texteOuNul(v.nom), ...total };
}

function lireBloc(v: unknown): BlocVentesVue {
  const b = estObjet(v) ? v : {};
  return {
    totaux: (Array.isArray(b.totaux) ? b.totaux : []).map(lireTotal).filter((t): t is TotalVentesVue => t !== null),
    sources: (Array.isArray(b.sources) ? b.sources : []).map(lireSource).filter((s): s is SourceVentesVue => s !== null),
  };
}

/** `null` pour une réponse sans bloc réel : l'écran dit alors « illisible », jamais un zéro qui mentirait. */
export function lireVentes(brut: unknown): ChiffreVentesVue | null {
  if (!estObjet(brut) || !estObjet(brut.reel)) return null;
  const p = estObjet(brut.paniers) ? brut.paniers : {};
  return {
    reel: lireBloc(brut.reel),
    test: lireBloc(brut.test),
    paniers: {
      relances: entier(p.relances),
      recuperes: entier(p.recuperes),
      montants: (Array.isArray(p.montants) ? p.montants : []).flatMap((m: unknown) =>
        (estObjet(m) && devise(m.devise) && decimal(m.montant) ? [{ devise: m.devise, montant: m.montant }] : [])),
      recuperesTest: entier(p.recuperesTest),
    },
  };
}

/** Un montant dans sa devise (`Intl`) ; une devise inconnue du navigateur s'écrit telle quelle, sans lever. */
export function fmtMontant(montant: string, codeDevise: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: codeDevise }).format(Number(montant));
  } catch {
    return `${montant} ${codeDevise}`;
  }
}
