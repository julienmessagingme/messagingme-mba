import { DROITS, FONCTIONS, PRIX_PRO_HT_CENTIMES, type Fonction, type Limites, type Offre } from './offres';
import type { SourceOffres } from './offre.pg';
import { adresseOffre } from './refus';

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
  offre: Offre;
  /** Les fonctions ouvertes, dans l'ordre de `FONCTIONS`. */
  fonctions: Fonction[];
  limites: Limites;
  usage: UsageOffre;
  /**
   * La grille des trois offres, lue dans `DROITS` : la page `/offre` de la console et Claude (`get_plan`) la montrent sans
   * jamais la recopier. Les limites de l'Entreprise y sont celles du devis par défaut (`null` = sans limite).
   */
  grille: Record<Offre, { fonctions: Fonction[]; limites: Limites }>;
  /**
   * Les prix HT du Pro, en centimes (`PRIX_PRO_HT_CENTIMES`) : la page de l'offre les affiche, Claude les lit. `null` tant
   * que le Pro n'est pas en vente (ses prix Stripe pas posés) : la console renvoie alors au Support sans faire cliquer.
   */
  prixPro: { moisCentimes: number; anCentimes: number } | null;
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
}

/** Une copie neuve à chaque appel : la modifier ne touche pas `DROITS`. */
export function grilleDesOffres(): VueOffre['grille'] {
  const une = (o: Offre) => ({ fonctions: FONCTIONS.filter((f) => DROITS[o].fonctions.has(f)), limites: { ...DROITS[o].limites } });
  return { base: une('base'), pro: une('pro'), entreprise: une('entreprise') };
}

export function creerVueOffre(d: DepsVueOffre): (tenantId: string) => Promise<VueOffre> {
  return async (tenantId) => {
    const [{ offre, droits }, usage, mois] = await Promise.all([
      d.offres.offreDe(tenantId), d.usage(tenantId), d.modelesDuMois.etatDuMois(tenantId),
    ]);
    return {
      offre,
      fonctions: FONCTIONS.filter((f) => droits.fonctions.has(f)),
      limites: { ...droits.limites },
      usage: { envoisModelesMois: mois === null ? null : mois.max - mois.reste, ...usage },
      grille: grilleDesOffres(),
      prixPro: d.proEnVente ? { moisCentimes: PRIX_PRO_HT_CENTIMES.mois, anCentimes: PRIX_PRO_HT_CENTIMES.an } : null,
      upgradeUrl: adresseOffre(),
    };
  };
}
