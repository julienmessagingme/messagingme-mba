import type { DateRange } from '../stats/range';
import type { SourceVente } from './attribution';
import type { LignesChiffre, PgVentesStore } from './ventes.pg';

/**
 * LE CHIFFRE D'AFFAIRES ATTRIBUÉ, TEL QU'IL SE LIT (plan `docs/superpowers/plans/2026-10-30-revenus-attribues-lot-2.md`).
 *
 * 🔴 UNE SEULE LECTURE POUR TROIS SURFACES : la route de la console (Quantitatif > Shopify), l'outil MCP
 * `get_revenue_stats` et l'état de la boutique (ses récupérés sur 7 jours) appellent tous `chiffreVentes`. Deux calculs
 * voisins sous le même titre feraient passer l'un pour faux.
 * 🔴 AUCUNE ARITHMÉTIQUE ICI : les montants arrivent sommés par Postgres, par devise, en texte. Les additionner en
 * JavaScript les ferait passer par un flottant ; additionner deux devises n'a pas de sens.
 * Les commandes de test (passerelle de test de Shopify) ne comptent jamais dans le chiffre : elles sont rendues à part,
 * dans la même forme, ce qui permet aussi l'essai réel sur une boutique de développement.
 */

export interface Montant { devise: string; montant: string }
export interface TotalVentes { devise: string; brut: string; prouve: string; commandes: number }
export interface LigneSourceVentes extends TotalVentes { source: SourceVente; campaignId: string | null; nom: string | null }
export interface BlocVentes { totaux: TotalVentes[]; sources: LigneSourceVentes[] }
export interface ChiffreVentes {
  periode: DateRange;
  reel: BlocVentes;
  test: BlocVentes;
  paniers: { relances: number; recuperes: number; montants: Montant[]; recuperesTest: number };
}

function bloc(l: LignesChiffre, test: boolean): BlocVentes {
  return {
    totaux: l.totaux.filter((t) => t.test === test)
      .map((t) => ({ devise: t.devise, brut: t.brut, prouve: t.prouve, commandes: t.commandes })),
    sources: l.ventes.filter((v) => v.test === test).map((v) => ({
      source: v.source, campaignId: v.campaignId, nom: v.nom, devise: v.devise, brut: v.brut, prouve: v.prouve, commandes: v.commandes,
    })),
  };
}

export async function chiffreVentes(store: Pick<PgVentesStore, 'lireChiffre'>, tenantId: string, range: DateRange): Promise<ChiffreVentes> {
  const l = await store.lireChiffre(tenantId, range);
  const reels = l.recuperes.filter((r) => !r.test);
  return {
    periode: range,
    reel: bloc(l, false),
    test: bloc(l, true),
    paniers: {
      relances: l.relances,
      recuperes: reels.reduce((n, r) => n + r.commandes, 0),
      montants: reels.map((r) => ({ devise: r.devise, montant: r.montant })),
      recuperesTest: l.recuperes.filter((r) => r.test).reduce((n, r) => n + r.commandes, 0),
    },
  };
}
