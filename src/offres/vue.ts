import {
  DROITS, ESSAI_PRO_JOURS, FONCTIONS, PRIX_BUSINESS_HT_CENTIMES, PRIX_PRO_HT_CENTIMES, PRIX_SIEGE_BUSINESS_HT_CENTIMES,
  PRIX_SIEGE_HT_CENTIMES, contactsToutesOrigines, type Fonction, type Limites, type Offre,
} from './offres';
import type { SourceOffres } from './offre.pg';
import type { ResumePro } from './abonnements-offre.pg';
import { adresseOffre } from './refus';

/**
 * LE NOM PUBLIC D'UNE OFFRE (décision de Julien du 2026-10-08) : l'offre gratuite s'appelle « Free » partout où elle se
 * lit, valeur de l'API comprise. La base et tout le code serveur gardent `base` (`Offre`, `DROITS`, `offre_de_l_espace`) :
 * la traduction se fait ICI, à la sortie de la vue, et nulle part ailleurs.
 */
export type OffrePublique = 'free' | 'pro' | 'business' | 'entreprise';
export function offrePublique(o: Offre): OffrePublique {
  return o === 'base' ? 'free' : o;
}

/**
 * 🔴 LES LIMITES TELLES QUE LA VUE LES MONTRE : toutes, sauf la commission sur le crédit IA (décision de Julien du
 * 2026-10-27, « on ne parle jamais de notre marge »). Elle reste dans `DROITS` et s'applique ; aucun écran, aucune page,
 * aucune réponse de Claude ne la lit, parce que la console et `get_plan` ne lisent que cette vue.
 */
export type LimitesVue = Omit<Limites, 'commissionPct'>;
function limitesVue(l: Limites): LimitesVue {
  const { commissionPct: _marge, ...vue } = l;
  return vue;
}

/** Ce qu'un espace a consommé de ses limites. `null` = sans limite, donc rien n'est compté. */
export interface UsageOffre {
  envoisModelesMois: number | null;
  contacts: number;
  automations: number;
  membres: number;
}

/**
 * LA VUE DE L'OFFRE D'UN ESPACE (lot 6, tâche 6) : ce que rendent la route `GET /tenants/:tenantId/offre` et l'outil MCP
 * `get_plan`, un seul calcul pour les deux. La grille n'est jamais recopiée côté console : elle se lit ici.
 */
export interface VueOffre {
  /** Le nom PUBLIC (`offrePublique`) : `free`, jamais `base`. */
  offre: OffrePublique;
  /** Les fonctions ouvertes, dans l'ordre de `FONCTIONS`. */
  fonctions: Fonction[];
  limites: LimitesVue;
  usage: UsageOffre;
  /**
   * Ce que compte la limite de contacts de l'espace (`contactsToutesOrigines`, décision de Julien du 2026-10-25) : vrai en
   * Free, où tous les contacts comptent, ceux qui ont écrit les premiers compris, et où un inconnu qui écrit à un espace
   * plein n'entre pas ; faux ailleurs, où seules les fiches créées comptent. La console et Claude le lisent ici, sans
   * recopier la règle.
   */
  contactsToutesOrigines: boolean;
  /**
   * Les fiches comptées au-delà de la limite de contacts (plan du 2026-10-26), 0 sous la limite ou pile à elle, et sans
   * limite : ce qu'il faut supprimer pour y revenir. Un espace revenu en Free avec 3 000 contacts en a 2 900 ; tant qu'il en
   * a, rien ne se crée ni ne s'importe, et ses suppressions du jour ne sont pas plafonnées (`QuotaSuppressions`). La page
   * de l'offre le dit sous la jauge, et Claude (`get_plan`) le lit avant de proposer la suppression.
   */
  contactsEnTrop: number;
  /**
   * La grille des quatre offres, lue dans `DROITS` : la page `/offre` de la console et Claude (`get_plan`) la montrent sans
   * jamais la recopier. Les limites de l'Entreprise y sont celles du devis par défaut (`null` = sans limite).
   */
  grille: Record<OffrePublique, { fonctions: Fonction[]; limites: LimitesVue }>;
  /**
   * Les prix HT du Pro, en centimes (`PRIX_PRO_HT_CENTIMES`) : la page de l'offre les affiche, Claude les lit. `null` tant
   * que le Pro n'est pas en vente (ses prix Stripe pas posés) : la console renvoie alors au Support sans faire cliquer.
   */
  prixPro: { moisCentimes: number; anCentimes: number } | null;
  /**
   * Les prix HT du Business, en centimes (`PRIX_BUSINESS_HT_CENTIMES`, `PRIX_SIEGE_BUSINESS_HT_CENTIMES`) : toujours là,
   * puisqu'il ne s'achète pas en ligne (Julien le pose dans `/ops`). La console et Claude le disent, avec « nous contacter ».
   */
  prixBusiness: { moisCentimes: number; siegeMoisCentimes: number };
  /**
   * La suite du numéro fourni que le Pro vivant annonce (lot 6, B2b) : sa fin prévue (`null` tant qu'il court sans fin) et
   * le choix de le rendre à la fin. `null` sans Pro vivant ou sans numéro fourni. La console l'annonce et Claude la lit.
   */
  suiteDuNumero: { finPrevueLe: string | null; rendreNumero: boolean } | null;
  /**
   * L'essai du Pro (spec offres v2, livraison 6) : sa durée, s'il est possible pour l'espace (une Free qui n'a jamais eu
   * de Pro, le Pro en vente), et la fin de l'essai en cours (`null` hors essai). La console et Claude le disent.
   */
  essai: { jours: number; possible: boolean; finLe: string | null };
  /**
   * Les sièges du Pro vivant (spec offres v2, livraison 7) : les utilisateurs inclus, ceux achetés en plus (déjà comptés
   * dans `limites.utilisateurs`) et la formule, qui fixe le prix du suivant. `null` hors Pro.
   */
  sieges: { inclus: number; achetes: number; periodicite: 'mois' | 'an' } | null;
  /** Le prix HT d'un siège, en centimes (`PRIX_SIEGE_HT_CENTIMES`) ; `null` tant que les sièges ne sont pas en vente. */
  prixSiege: { moisCentimes: number; anCentimes: number } | null;
  /**
   * L'abonnement Pro de l'espace, dit en clair (2026-10-26, demande de Julien : « quand commence-t-il, quand s'arrête-t-il,
   * son statut ») : le vivant, sinon le dernier fini ; `null` si l'espace n'a jamais eu de Pro. Le statut se calcule ici
   * (`statutDuPro`), la console et Claude le lisent sans refaire la règle.
   */
  abonnement: AbonnementProVue | null;
  upgradeUrl: string;
}

/**
 * Le statut du Pro, de la plus forte à la plus faible : fini ; paiement en retard (c'est lui qu'il faut régler, même si
 * une fin est posée) ; résiliation programmée (même pendant l'essai : il ne sera suivi d'aucun paiement) ; essai ; actif.
 */
export type StatutAbonnementPro = 'termine' | 'en_retard' | 'resiliation_programmee' | 'essai' | 'actif';

export interface AbonnementProVue {
  statut: StatutAbonnementPro;
  periodicite: 'mois' | 'an';
  /** La souscription (la création de la ligne, au premier événement de Stripe). */
  debutLe: string;
  /**
   * Le prochain renouvellement (la fin de la période payée, ou de l'essai) : `null` quand une fin est posée, fini, en retard
   * de paiement, ou déjà passé (le renouvellement n'a pas encore été noté).
   */
  prochaineEcheanceLe: string | null;
  /** La fin programmée (une résiliation) : le Pro court jusque-là, puis l'espace repasse en Free. */
  finPrevueLe: string | null;
  /** La fin de l'essai qui COURT, `null` hors essai. */
  essaiFinLe: string | null;
  /** La fin effective d'un Pro fini, et sa raison. */
  finiLe: string | null;
  finRaison: 'resiliation' | 'impaye' | null;
}

/** Le statut d'un Pro à `maintenant` (`StatutAbonnementPro`). */
export function statutDuPro(a: ResumePro, maintenant: number): StatutAbonnementPro {
  if (a.finiLe !== null || a.statut === 'resilie') return 'termine';
  if (a.statut === 'en_retard') return 'en_retard';
  if (a.finPrevueLe !== null) return 'resiliation_programmee';
  return a.essaiFinLe !== null && a.essaiFinLe.getTime() > maintenant ? 'essai' : 'actif';
}

function abonnementProVue(a: ResumePro, maintenant: number): AbonnementProVue {
  const statut = statutDuPro(a, maintenant);
  const vivant = statut !== 'termine';
  const iso = (d: Date | null): string | null => d?.toISOString() ?? null;
  return {
    statut,
    periodicite: a.periodicite,
    debutLe: a.creeLe.toISOString(),
    prochaineEcheanceLe: vivant && statut !== 'en_retard' && a.finPrevueLe === null && a.periodeFin !== null && a.periodeFin.getTime() > maintenant
      ? a.periodeFin.toISOString() : null,
    finPrevueLe: vivant ? iso(a.finPrevueLe) : null,
    essaiFinLe: vivant && a.essaiFinLe !== null && a.essaiFinLe.getTime() > maintenant ? a.essaiFinLe.toISOString() : null,
    finiLe: iso(a.finiLe),
    finRaison: a.finRaison,
  };
}

export interface DepsVueOffre {
  offres: SourceOffres;
  /** Les fiches créées actives, les automations allumées du client, les membres actifs (`PgOffresStore.usage`). */
  usage(tenantId: string): Promise<Omit<UsageOffre, 'envoisModelesMois'>>;
  /** Les modèles du mois (`QuotaModeles.etatDuMois`) : `null` sans limite. */
  modelesDuMois: { etatDuMois(tenantId: string): Promise<{ max: number; reste: number } | null> };
  /** Le Pro se paie-t-il en ligne ? (Stripe câblé et `STRIPE_PRIX_PRO_MOIS` et `_AN` posés). */
  proEnVente: boolean;
  /** La suite du numéro fourni (`PgAbonnementsOffreStore.suiteDuNumero`, lot 6, B2b). */
  suiteDuNumero(tenantId: string): Promise<{ finPrevueLe: Date | null; rendreNumero: boolean } | null>;
  /** Les sièges se paient-ils en ligne ? (Stripe câblé et `STRIPE_PRIX_SIEGE_MOIS` et `_AN` posés). */
  siegesEnVente: boolean;
  /**
   * Le Pro de l'espace, vivant ou dernier fini (`PgAbonnementsOffreStore.resume`) ; `null` s'il n'en a jamais eu. L'essai
   * s'en déduit aussi (déjà eu un Pro, fin de l'essai qui court) : une seule lecture de la table pour toute la vue.
   */
  abonnement(tenantId: string): Promise<ResumePro | null>;
}

/** Une copie neuve à chaque appel : la modifier ne touche pas `DROITS`. Les clés passent par `offrePublique`, elle seule. */
export function grilleDesOffres(): VueOffre['grille'] {
  const une = (o: Offre) => ({ fonctions: FONCTIONS.filter((f) => DROITS[o].fonctions.has(f)), limites: limitesVue(DROITS[o].limites) });
  const offres: readonly Offre[] = ['base', 'pro', 'business', 'entreprise'];
  return Object.fromEntries(offres.map((o) => [offrePublique(o), une(o)])) as VueOffre['grille'];
}

export function creerVueOffre(d: DepsVueOffre): (tenantId: string) => Promise<VueOffre> {
  return async (tenantId) => {
    const [{ offre, droits, pro }, usage, mois, suite, abonnement] = await Promise.all([
      d.offres.offreDe(tenantId), d.usage(tenantId), d.modelesDuMois.etatDuMois(tenantId), d.suiteDuNumero(tenantId), d.abonnement(tenantId),
    ]);
    const vueAbonnement = abonnement === null ? null : abonnementProVue(abonnement, Date.now());
    return {
      offre: offrePublique(offre),
      fonctions: FONCTIONS.filter((f) => droits.fonctions.has(f)),
      limites: limitesVue(droits.limites),
      usage: { envoisModelesMois: mois === null ? null : mois.max - mois.reste, ...usage },
      contactsToutesOrigines: contactsToutesOrigines(offre),
      // L'usage compte comme la limite (`PgOffresStore.usage`, sur `ficheComptee`) : l'écart est celui de la porte.
      contactsEnTrop: droits.limites.contacts === null ? 0 : Math.max(0, usage.contacts - droits.limites.contacts),
      grille: grilleDesOffres(),
      prixPro: d.proEnVente ? { moisCentimes: PRIX_PRO_HT_CENTIMES.mois, anCentimes: PRIX_PRO_HT_CENTIMES.an } : null,
      prixBusiness: { moisCentimes: PRIX_BUSINESS_HT_CENTIMES.mois, siegeMoisCentimes: PRIX_SIEGE_BUSINESS_HT_CENTIMES.mois },
      suiteDuNumero: suite === null ? null : { finPrevueLe: suite.finPrevueLe?.toISOString() ?? null, rendreNumero: suite.rendreNumero },
      essai: {
        jours: ESSAI_PRO_JOURS,
        // Un seul essai par espace : un Pro, même fini, l'a consommé.
        possible: offre === 'base' && d.proEnVente && abonnement === null,
        finLe: vueAbonnement?.essaiFinLe ?? null,
      },
      sieges: offre === 'pro' && pro
        ? { inclus: DROITS.pro.limites.utilisateurs ?? 0, achetes: pro.sieges, periodicite: pro.periodicite }
        : null,
      prixSiege: d.siegesEnVente ? { moisCentimes: PRIX_SIEGE_HT_CENTIMES.mois, anCentimes: PRIX_SIEGE_HT_CENTIMES.an } : null,
      abonnement: vueAbonnement,
      upgradeUrl: adresseOffre(),
    };
  };
}
