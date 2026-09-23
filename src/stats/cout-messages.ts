import { chiffrer, type CategoryRates } from './cost';
import { coutRcsEuros, type GrillePrix } from './prix';

/**
 * LE COUT TOTAL DES MESSAGES ENVOYES SUR UNE PERIODE : templates, messages de service, RCS.
 *
 * 🔴 LA FRANCHISE SE COMPTE PAR MOIS, ET LA PERIODE AFFICHEE N'EST PAS UN MOIS. C'est la difficulte de ce
 * module, et la premiere redaction du plan s'y est trompee : elle calculait « ce que le mois depasse,
 * plafonne a ce que la periode contient », ce qui suppose que la periode est la FIN du mois. Sur les sept
 * premiers jours d'un mois qui finit a 1200 envois, cette formule facturait 200 messages GRATUITS. L'entree
 * porte donc, pour chaque mois traverse, ce qui a ete consomme AVANT la fenetre : c'est la seule facon
 * d'etre juste ou que tombe la periode, et quel que soit le nombre de mois qu'elle traverse.
 *
 * 🔴 ET LA FRANCHISE SE REMET A ZERO LE 1er. Une periode a cheval sur deux mois a DEUX franchises. Un
 * calcul global sur la periode en aurait offert une seule, donc surfacture de mille messages.
 *
 * 🔴 « CHIFFRABLE » A UNE SEULE DEFINITION DANS CE DEPOT, et c'est pour ca que ce module importe `chiffrer`
 * au lieu de refaire le test. Deux definitions donneraient deux totaux sur deux ecrans du meme onglet, et
 * le client les comparerait. C'est la regle que `cost.ts` applique deja a ses trois consommateurs ; celui-ci
 * est le quatrieme.
 *
 * ⚠️ PAS DE MESSAGE DE SERVICE SUR RCS. Contrairement a WhatsApp, un echange RCS ne produit aucune
 * facturation de service : tout y est au tarif RCS, simple ou conversationnel. Ne pas recopier la mecanique
 * de franchise sur ce canal, elle n'y a pas de sens.
 *
 * Module PUR : aucune base, aucun reseau.
 */

/** Ce qu'un MOIS traverse par la periode a consomme, avant la fenetre et dedans. */
export interface MoisService {
  /** Le mois, en 'YYYY-MM'. */
  mois: string;
  /** Messages de service de ce mois envoyes AVANT le debut de la periode affichee. */
  avantLaPeriode: number;
  /** Messages de service de ce mois qui tombent DANS la periode affichee. */
  dansLaPeriode: number;
}

export interface EntreeCoutMessages {
  /** Les volumes de templates FACTURABLES de la periode, par categorie Meta. */
  templates: readonly { category: string | null; count: number }[];
  rates: CategoryRates;
  /** Un element par mois traverse par la periode, dans l'ordre chronologique. */
  service: readonly MoisService[];
  rcsSimple: number;
  rcsConversationnel: number;
}

/** Le detail d'un mois, tel que l'ecran l'affiche a part de la periode. */
export interface FranchiseMois {
  mois: string;
  /** Total du mois a la fin de la periode : c'est ce qui se lit « 340 / 1000 ». */
  consommes: number;
  plafond: number;
  /** Ceux de ce mois, DANS la periode, qui sont payants. */
  factures: number;
}

export interface CoutMessages {
  templates: { marketing: number; utility: number };
  service: {
    /** Tous les messages de service de la periode, factures ou non. */
    envoyes: number;
    factures: number;
    cout: number;
    /** ⚠️ Un element par mois traverse : la franchise est mensuelle, l'ecran montre celui qui l'interesse. */
    parMois: FranchiseMois[];
  };
  rcs: { simple: number; conversationnel: number; cout: number };
  total: number;
  /**
   * 🔴 LA DEVISE VOYAGE AVEC CE TOTAL, ET PAS AVEC UN AUTRE APPEL. Elle vient du même `pricing_analytics`
   * de Meta que les tarifs, donc elle est là de toute façon ; la faire venir de la route voisine
   * (`/stats/cost/campaigns`) couplerait l'AFFICHAGE de deux lignes que la carte charge séparément pour
   * qu'une panne de l'une n'abîme pas l'autre. Trouvé en revue le 2026-09-17 : la première version le
   * faisait, et le test « une panne d'une ligne ne tue pas les deux autres » passait quand même, parce que
   * le nombre s'affichait, simplement sans son symbole.
   *
   * `null` = inconnue, et l'écran rend alors le nombre nu plutôt qu'un « € » qui serait faux hors zone euro.
   */
  currency: string | null;
  /** Envois comptes dans les volumes mais absents du cout. Somme des deux causes qui suivent. */
  nonChiffrables: number;
  /** ...dont ceux sans categorie enregistree : heritage clos (cf. `CostSeries.sansCategorie`). */
  sansCategorie: number;
  /** ...dont ceux dont Meta ne rend pas le tarif : panne du jour, reparable. */
  sansTarif: number;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Le mois d'une date d'effet 'YYYY-MM-DD', pour le comparer a un mois 'YYYY-MM'.
 *
 * ⚠️ COMPARAISON DE CHAINES, ET C'EST EXACT ICI : le format 'YYYY-MM' est trie lexicographiquement comme il
 * l'est chronologiquement. Passer par des `Date` ferait entrer un fuseau horaire dans une question qui n'en
 * a pas, et se tromperait d'un jour aux frontieres de mois.
 */
function moisDe(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * Combien de messages de service de CE mois, DANS la periode, sont payants.
 *
 * La franchise couvre les `plafond` PREMIERS du mois. Les messages de la periode occupent la tranche
 * `[avant, avant + dans)`. Ce qui est facture est l'intersection de cette tranche avec `[plafond, +infini)`.
 */
function facturesDuMois(m: MoisService, plafond: number): number {
  const fin = m.avantLaPeriode + m.dansLaPeriode;
  const debutPayant = Math.max(m.avantLaPeriode, plafond);
  return Math.max(0, fin - debutPayant);
}

export function coutMessages(e: EntreeCoutMessages, g: GrillePrix): CoutMessages {
  // ---- Templates, avec la MEME regle de chiffrabilite que le reste du depot.
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
    // 🔴 LA MARGE EST DEJA DANS `rates`, POSEE UNE FOIS PAR `prixFactures`. L appliquer ici la compterait
    // DEUX fois : une marge de 150 facturerait 2,25 fois le tarif Meta. Elle a vecu ici jusqu au
    // 2026-09-18, jusqu a ce qu une revue montre que deux AUTRES consommateurs des memes tarifs
    // l ignoraient, faute d un point de passage unique.
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
    // 🔴 AVANT LA DATE D'EFFET, RIEN N'EST FACTURE, quel que soit le volume. Meta ne facture les messages
    // de service qu'a partir du 2026-10-01 : rejouer un mois anterieur doit rendre zero, sinon le total
    // d'un mois passe changerait selon le jour ou on le regarde.
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

  // ---- RCS : deux tarifs, aucune franchise, aucun message de service. La formule vit dans `prix.ts`,
  // parce que le tableau du cout par engagement l'applique aussi, campagne par campagne.
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
