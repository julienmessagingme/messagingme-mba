import { chiffrer, round2, type CategoryRates } from './cost';
import { coutRcsEuros, type GrillePrix } from './prix';

/**
 * Le coût total des messages envoyés sur une période : templates, messages de service, RCS. Module pur.
 *
 * 🔴 La franchise de service se compte par mois, et la période affichée n'en est pas un : pour chaque mois
 * traversé, l'entrée porte ce qui a été consommé avant la fenêtre, sinon les premiers jours d'un mois seraient
 * facturés comme sa fin. Une période à cheval sur deux mois a deux franchises (remise à zéro le 1er).
 *
 * « Chiffrable » a une seule définition dans le dépôt (`chiffrer`), sinon deux écrans du même onglet
 * donneraient deux totaux. Pas de message de service sur RCS : tout y est au tarif RCS.
 */

/** Ce qu'un mois traversé par la période a consommé, avant la fenêtre et dedans. */
export interface MoisService {
  /** Le mois, en 'YYYY-MM'. */
  mois: string;
  /** Messages de service de ce mois envoyés avant le début de la période affichée. */
  avantLaPeriode: number;
  /** Messages de service de ce mois qui tombent dans la période affichée. */
  dansLaPeriode: number;
}

export interface EntreeCoutMessages {
  /** Les volumes de templates facturables de la période, par catégorie Meta. */
  templates: readonly { category: string | null; count: number }[];
  rates: CategoryRates;
  /** Un élément par mois traversé par la période, dans l'ordre chronologique. */
  service: readonly MoisService[];
  rcsSimple: number;
  rcsConversationnel: number;
}

/** Le détail d'un mois, tel que l'écran l'affiche à part de la période. */
export interface FranchiseMois {
  mois: string;
  /** Total du mois à la fin de la période : c'est ce qui se lit « 340 / 1000 ». */
  consommes: number;
  plafond: number;
  /** Ceux de ce mois, dans la période, qui sont payants. */
  factures: number;
}

export interface CoutMessages {
  templates: { marketing: number; utility: number };
  service: {
    /** Tous les messages de service de la période, facturés ou non. */
    envoyes: number;
    factures: number;
    cout: number;
    /** Un élément par mois traversé : la franchise est mensuelle. */
    parMois: FranchiseMois[];
  };
  rcs: { simple: number; conversationnel: number; cout: number };
  total: number;
  /**
   * La devise voyage avec ce total : elle vient du même `pricing_analytics` que les tarifs. La faire venir
   * d'une route voisine couplerait l'affichage de deux lignes chargées séparément. `null` = inconnue, l'écran
   * rend le nombre nu plutôt qu'un « € » faux hors zone euro.
   */
  currency: string | null;
  /** Envois comptés dans les volumes mais absents du coût. Somme des deux causes qui suivent. */
  nonChiffrables: number;
  /** ...dont ceux sans catégorie enregistrée : héritage clos (cf. `CostSeries.sansCategorie`). */
  sansCategorie: number;
  /** ...dont ceux dont Meta ne rend pas le tarif : panne du jour, réparable. */
  sansTarif: number;
}


/**
 * Le mois d'une date d'effet 'YYYY-MM-DD'. Comparaison de chaînes, exacte ici ('YYYY-MM' se trie comme le
 * temps) : passer par des `Date` ferait entrer un fuseau et se tromperait aux frontières de mois.
 */
function moisDe(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * Combien de messages de service de ce mois, dans la période, sont payants : la franchise couvre les
 * `plafond` premiers du mois, la période occupe `[avant, avant + dans)`, on facture l'intersection avec
 * `[plafond, +infini)`.
 */
function facturesDuMois(m: MoisService, plafond: number): number {
  const fin = m.avantLaPeriode + m.dansLaPeriode;
  const debutPayant = Math.max(m.avantLaPeriode, plafond);
  return Math.max(0, fin - debutPayant);
}

export function coutMessages(e: EntreeCoutMessages, g: GrillePrix): CoutMessages {
  // ---- Templates, avec la même règle de chiffrabilité que le reste du dépôt.
  let marketing = 0;
  let utility = 0;
  let sansCategorie = 0;
  let sansTarif = 0;
  for (const t of e.templates) {
    const verdict = chiffrer(t.category, e.rates);
    if ('refus' in verdict) {
      if (verdict.refus === 'sansCategorie') sansCategorie += t.count; else sansTarif += t.count;
      continue;
    }
    // 🔴 La marge est déjà dans `rates`, posée une fois par `prixFactures` : l'appliquer ici la compterait
    // deux fois.
    const montant = t.count * verdict.tarif;
    if (t.category === 'marketing') marketing += montant; else utility += montant;
  }

  // ---- Messages de service, mois par mois, franchise par franchise.
  const moisEffet = moisDe(g.serviceDepuis);
  let envoyes = 0;
  let factures = 0;
  const parMois: FranchiseMois[] = [];
  for (const m of e.service) {
    envoyes += m.dansLaPeriode;
    // 🔴 Avant la date d'effet (`serviceDepuis`), Meta ne facture pas le service : un mois antérieur rend zéro,
    // sinon le total d'un mois passé changerait selon le jour où on le regarde.
    const payants = m.mois >= moisEffet ? facturesDuMois(m, g.serviceFranchise) : 0;
    factures += payants;
    parMois.push({
      mois: m.mois,
      consommes: m.avantLaPeriode + m.dansLaPeriode,
      plafond: g.serviceFranchise,
      factures: payants,
    });
  }
  const coutService = round2((factures * g.serviceCentimes) / 100);

  // ---- RCS : deux tarifs, aucune franchise. La formule vit dans `prix.ts`, partagée avec le coût par engagement.
  const coutRcs = coutRcsEuros(e.rcsSimple, e.rcsConversationnel, g);

  const templates = { marketing: round2(marketing), utility: round2(utility) };
  return {
    templates,
    service: { envoyes, factures, cout: coutService, parMois },
    rcs: { simple: e.rcsSimple, conversationnel: e.rcsConversationnel, cout: coutRcs },
    total: round2(templates.marketing + templates.utility + coutService + coutRcs),
    currency: e.rates.currency ?? null,
    nonChiffrables: sansCategorie + sansTarif,
    sansCategorie,
    sansTarif,
  };
}
