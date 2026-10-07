/**
 * LES OFFRES ET LEURS LIMITES (lot 6, spec `docs/superpowers/specs/2026-10-07-offres-et-limites-design.md`).
 *
 * 🔴 LA GRILLE VIT ICI, UNE FOIS. Aucune valeur n'est recopiée ailleurs : la console et le MCP la lisent par la route de
 * l'offre (`GET /tenants/:tenantId/offre`), et `tests/offres.test.ts` la tient égale à la spec, case par case.
 *
 * L'offre d'un espace ne se décide pas ici : elle se CALCULE en SQL (`offre_de_l_espace`, lue par `src/offres/offre.pg.ts`),
 * sur des dates, comme l'état du numéro au lot 4. Ce module dit seulement ce que chaque offre ouvre et permet.
 */
export type Offre = 'base' | 'pro' | 'entreprise';

/** Les fonctions qu'une offre ouvre ou ferme. Tout ce qui n'est pas nommé ici est ouvert à toutes les offres. */
export const FONCTIONS = [
  'inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'analyse', 'publicites', 'email', 'chaines',
  'crm', 'rcs', 'performance_lab',
] as const;
export type Fonction = (typeof FONCTIONS)[number];

/**
 * Les limites chiffrées d'une offre. `null` = sans limite, et aucun contrôle ne tourne alors (pas même une lecture).
 * ⚠️ `conservationJours` n'est jamais `null` : c'est la durée par défaut, que le réglage d'un espace Entreprise
 * (`tenant_settings.conversation_retention_days`) remplace.
 */
export interface Limites {
  utilisateurs: number | null;
  admins: number | null;
  /** Fiches créées par import, API, MCP, console ou scénario ; une fiche née d'un message entrant ne compte jamais. */
  contacts: number | null;
  /** Modèles (messages à l'initiative de l'entreprise) par mois civil de Paris ; un message dans la fenêtre ne compte pas. */
  envoisModelesMois: number | null;
  /** Automations du client ; celles que possède un lien, une publicité ou un widget ne comptent pas. */
  automations: number | null;
  suppressionsJour: number | null;
  /** Webhooks sortants : déclarés ici, appliqués par le lot des webhooks. */
  adressesWebhook: number | null;
  journalWebhooksJours: number | null;
  conservationJours: number;
  commissionPct: number;
  badge: boolean;
  numeroInclus: boolean;
}

export interface Droits {
  fonctions: ReadonlySet<Fonction>;
  limites: Readonly<Limites>;
}

/** Ce que l'exploitation règle sur un espace Entreprise (`/ops`). `null` = sans limite. */
export interface SurchargeEntreprise {
  utilisateurs: number | null;
  /**
   * La conservation des conversations posée par l'exploitation (`tenant_settings.conversation_retention_days`) : `null` =
   * le défaut de l'offre, `0` = jamais purgée. La vue de l'offre l'affiche telle que la purge la lit.
   */
  conservationJours: number | null;
}

const FONCTIONS_PRO: readonly Fonction[] = [
  'inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'analyse', 'publicites', 'email', 'chaines',
];

export const DROITS: Readonly<Record<Offre, Droits>> = {
  base: {
    fonctions: new Set<Fonction>(),
    limites: {
      utilisateurs: 1, admins: 1, contacts: 100, envoisModelesMois: 1000, automations: 10, suppressionsJour: 10,
      adressesWebhook: 1, journalWebhooksJours: 3, conservationJours: 30, commissionPct: 50, badge: true, numeroInclus: false,
    },
  },
  pro: {
    fonctions: new Set<Fonction>(FONCTIONS_PRO),
    limites: {
      utilisateurs: 3, admins: 2, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
      adressesWebhook: 5, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true,
    },
  },
  entreprise: {
    fonctions: new Set<Fonction>(FONCTIONS),
    limites: {
      utilisateurs: null, admins: null, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
      adressesWebhook: null, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true,
    },
  },
};

/**
 * Les prix HT du Pro, en centimes (lot 6, livraison B1, décision de Julien du 2026-10-07) : 49 € par mois, 490 € par an,
 * taxe en sus. La route de paiement les recoupe avec le prix posé chez Stripe AVANT d'ouvrir un paiement, et la vue de
 * l'offre les montre à la console : jamais recopiés ailleurs.
 */
export const PRIX_PRO_HT_CENTIMES: Readonly<{ mois: number; an: number }> = { mois: 4900, an: 49000 };

/** Les droits d'un espace : ceux de son offre, et pour l'Entreprise la surcharge de l'exploitation. Copie neuve. */
export function droitsDe(offre: Offre, surcharge: SurchargeEntreprise | null): Droits {
  const d = DROITS[offre];
  const limites: Limites = { ...d.limites };
  if (offre === 'entreprise' && surcharge !== null) {
    limites.utilisateurs = surcharge.utilisateurs;
    if (surcharge.conservationJours !== null) limites.conservationJours = surcharge.conservationJours;
  }
  return { fonctions: new Set(d.fonctions), limites };
}
