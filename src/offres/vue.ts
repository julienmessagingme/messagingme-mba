import { DROITS, FONCTIONS, PRIX_PRO_HT_CENTIMES, type Fonction, type Limites, type Offre } from './offres';
import type { SourceOffres } from './offre.pg';
import { adresseOffre } from './refus';

/**
 * LE NOM PUBLIC D'UNE OFFRE (décision de Julien du 2026-10-08) : l'offre gratuite s'appelle « Free » partout où elle se
 * lit, valeur de l'API comprise. La base et tout le code serveur gardent `base` (`Offre`, `DROITS`, `offre_de_l_espace`) :
 * la traduction se fait ICI, à la sortie de la vue, et nulle part ailleurs.
 */
export type OffrePublique = 'free' | 'pro' | 'entreprise';
export function offrePublique(o: Offre): OffrePublique {
  return o === 'base' ? 'free' : o;
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
  limites: Limites;
  usage: UsageOffre;
  /**
   * La grille des trois offres, lue dans `DROITS` : la page `/offre` de la console et Claude (`get_plan`) la montrent sans
   * jamais la recopier. Les limites de l'Entreprise y sont celles du devis par défaut (`null` = sans limite).
   */
  grille: Record<OffrePublique, { fonctions: Fonction[]; limites: Limites }>;
  /**
   * Les prix HT du Pro, en centimes (`PRIX_PRO_HT_CENTIMES`) : la page de l'offre les affiche, Claude les lit. `null` tant
   * que le Pro n'est pas en vente (ses prix Stripe pas posés) : la console renvoie alors au Support sans faire cliquer.
   */
  prixPro: { moisCentimes: number; anCentimes: number } | null;
  /**
   * La suite du numéro fourni que le Pro vivant annonce (lot 6, B2b) : sa fin prévue (`null` tant qu'il court sans fin) et
   * le choix de le rendre à la fin. `null` sans Pro vivant ou sans numéro fourni. La console l'annonce et Claude la lit.
   */
  suiteDuNumero: { finPrevueLe: string | null; rendreNumero: boolean } | null;
  upgradeUrl: string;
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
}

/** Une copie neuve à chaque appel : la modifier ne touche pas `DROITS`. Les clés passent par `offrePublique`, elle seule. */
export function grilleDesOffres(): VueOffre['grille'] {
  const une = (o: Offre) => ({ fonctions: FONCTIONS.filter((f) => DROITS[o].fonctions.has(f)), limites: { ...DROITS[o].limites } });
  const offres: readonly Offre[] = ['base', 'pro', 'entreprise'];
  return Object.fromEntries(offres.map((o) => [offrePublique(o), une(o)])) as VueOffre['grille'];
}

export function creerVueOffre(d: DepsVueOffre): (tenantId: string) => Promise<VueOffre> {
  return async (tenantId) => {
    const [{ offre, droits }, usage, mois, suite] = await Promise.all([
      d.offres.offreDe(tenantId), d.usage(tenantId), d.modelesDuMois.etatDuMois(tenantId), d.suiteDuNumero(tenantId),
    ]);
    return {
      offre: offrePublique(offre),
      fonctions: FONCTIONS.filter((f) => droits.fonctions.has(f)),
      limites: { ...droits.limites },
      usage: { envoisModelesMois: mois === null ? null : mois.max - mois.reste, ...usage },
      grille: grilleDesOffres(),
      prixPro: d.proEnVente ? { moisCentimes: PRIX_PRO_HT_CENTIMES.mois, anCentimes: PRIX_PRO_HT_CENTIMES.an } : null,
      suiteDuNumero: suite === null ? null : { finPrevueLe: suite.finPrevueLe?.toISOString() ?? null, rendreNumero: suite.rendreNumero },
      upgradeUrl: adresseOffre(),
    };
  };
}
