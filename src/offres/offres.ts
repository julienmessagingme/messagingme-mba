/**
 * LES OFFRES ET LEURS LIMITES (lot 6, spec `docs/superpowers/specs/2026-10-07-offres-et-limites-design.md`).
 *
 * 🔴 LA GRILLE VIT ICI, UNE FOIS. Aucune valeur n'est recopiée ailleurs : la console et le MCP la lisent par la route de
 * l'offre (`GET /tenants/:tenantId/offre`), et `tests/offres.test.ts` la tient égale à la spec, case par case.
 *
 * L'offre d'un espace ne se décide pas ici : elle se CALCULE en SQL (`offre_de_l_espace`, lue par `src/offres/offre.pg.ts`),
 * sur des dates, comme l'état du numéro au lot 4. Ce module dit seulement ce que chaque offre ouvre et permet.
 */
export type Offre = 'base' | 'pro' | 'business' | 'entreprise';

/** Une valeur lue en base (le résultat d'`offre_de_l_espace`) est-elle une offre connue ? */
export function estOffre(v: unknown): v is Offre {
  return v === 'base' || v === 'pro' || v === 'business' || v === 'entreprise';
}

/** Les fonctions qu'une offre ouvre ou ferme. Tout ce qui n'est pas nommé ici est ouvert à toutes les offres. */
export const FONCTIONS = [
  'inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'analyse', 'publicites', 'email', 'chaines',
  'crm', 'rcs', 'performance_lab',
  // La console elle-même (spec offres v2, 2026-10-16) : la Free se pilote par l'API et le MCP, jamais par la console.
  'console',
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
  /**
   * Les fiches vivantes que l'offre compte (`contactsToutesOrigines`) : en Free, toutes, nées d'un message entrant
   * comprises ; ailleurs, celles créées par import, API, MCP, console ou scénario (une fiche née d'un entrant n'y compte pas).
   */
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
  /**
   * Le poids total des fichiers de la médiathèque (images, vidéos, PDF), en octets (spec médias du 2026-10-14, § 2.1).
   * Un espace au-dessus (changement d'offre) garde ses fichiers et continue d'envoyer : seul un nouveau dépôt est refusé.
   */
  stockageOctets: number | null;
  /**
   * Les clés d'API actives (spec offres v2, une limite invisible : jamais sur la page des tarifs). La clé du relais de
   * l'agent de Meta ne compte pas ; un espace au-delà (retour en Free) garde ses clés, seule la création est refusée.
   */
  clesApi: number | null;
  /**
   * Les appels à l'API et au MCP par minute et par heure, une valeur par défaut de l'offre (spec offres v2, invisibles
   * aussi). `null` = la configuration (`API_PLAFOND_MINUTE`, `_HEURE`) ; un réglage d'espace posé par `/ops` prime, et la
   * configuration à 0 éteint aussi l'offre, le levier d'urgence (`src/auth/plafond-espace.ts`, `valeurEffective`).
   */
  appelsMinute: number | null;
  appelsHeure: number | null;
  /**
   * Les quotas quotidiens de l'API, par famille (`src/api/quotas.ts`), mêmes règles : les modèles envoyés (`/v1/sends`,
   * `send_template_to_contact`) et les messages libres dans la fenêtre de 24 h. 🔴 Les réponses ne descendent jamais sous
   * 2 000 : ne jamais bloquer les clients du client.
   */
  modelesJour: number | null;
  reponsesJour: number | null;
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
  /** Les contacts créés, réglés sur devis (spec offres v2) : absent ou `null` = le défaut de l'Entreprise (sans limite). */
  contacts?: number | null;
  /** La commission sur le crédit IA, négociée sur devis : un entier de 0 à 100 ; absent ou `null` = le défaut (10 %). */
  commissionPct?: number | null;
}

/** Un mégaoctet, l'unité des quotas de stockage (la même que les plafonds de dépôt, `src/rcs/image.ts`). */
const MO = 1024 * 1024;

/**
 * Le Pro resserré (spec offres v2, livraison 5) : la console complète, sans l'analyse des conversations, les publicités ni les
 * chaînes, qui font la différence de l'Entreprise avec le CRM, le RCS et le Performance Lab.
 */
const FONCTIONS_PRO: readonly Fonction[] = [
  'inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'email', 'console',
];

export const DROITS: Readonly<Record<Offre, Droits>> = {
  base: {
    fonctions: new Set<Fonction>(),
    limites: {
      utilisateurs: 1, admins: 1, contacts: 100, envoisModelesMois: 1000, automations: 10, suppressionsJour: 10,
      adressesWebhook: 1, journalWebhooksJours: 3, conservationJours: 30, commissionPct: 100, badge: true, numeroInclus: false,
      stockageOctets: 0, clesApi: 2, appelsMinute: 30, appelsHeure: 500, modelesJour: 500, reponsesJour: 2000,
    },
  },
  pro: {
    fonctions: new Set<Fonction>(FONCTIONS_PRO),
    limites: {
      // Tous administrateurs (spec du 2026-10-27, `roleEffectif`) : plus de limite d'administrateurs à part.
      utilisateurs: 3, admins: null, contacts: 5000, envoisModelesMois: null, automations: null, suppressionsJour: null,
      adressesWebhook: 5, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 20, badge: false, numeroInclus: true,
      stockageOctets: 100 * MO, clesApi: 10, appelsMinute: 60, appelsHeure: 1000, modelesJour: 2000, reponsesJour: 2000,
    },
  },
  /**
   * Le Business (spec `docs/superpowers/specs/2026-10-27-offre-business-design.md`) : posé par Julien dans `/ops`, jamais
   * vendu en ligne. Ses limites invisibles (clés, appels, quotas, médiathèque) sont un choix relu de la spec.
   */
  business: {
    fonctions: new Set<Fonction>(FONCTIONS_PRO),
    limites: {
      utilisateurs: 5, admins: null, contacts: 5000, envoisModelesMois: null, automations: null, suppressionsJour: null,
      adressesWebhook: 10, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 15, badge: false, numeroInclus: true,
      stockageOctets: 250 * MO, clesApi: 20, appelsMinute: 120, appelsHeure: 3000, modelesJour: 5000, reponsesJour: 5000,
    },
  },
  entreprise: {
    fonctions: new Set<Fonction>(FONCTIONS),
    limites: {
      utilisateurs: null, admins: null, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
      adressesWebhook: null, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true,
      stockageOctets: 500 * MO, clesApi: null, appelsMinute: null, appelsHeure: null, modelesJour: null, reponsesJour: null,
    },
  },
};

/**
 * 🔴 CE QUE COMPTE LA LIMITE DE CONTACTS, ET LE SEUL ENDROIT QUI LE DÉCIDE (décision de Julien du 2026-10-25, plan
 * `docs/superpowers/plans/2026-10-25-free-100-contacts.md`). La Free ne gère jamais plus de contacts différents que sa
 * limite, quelle que soit leur origine : une fiche née d'un message entrant y compte, et un inconnu qui écrit à une Free
 * pleine n'entre pas (`src/webhooks/espace-plein.ts`). Le Pro et l'Entreprise ne comptent que les fiches créées : une
 * fiche née d'un entrant n'y compte jamais, et l'entrant n'y est jamais refusé. Les gardes du magasin des contacts
 * (`PgContactStore`), l'usage de la vue de l'offre (`PgOffresStore.usage`, donc ses courriels de franchissement) et la
 * phrase du refus (`phraseLimite`) le lisent ici.
 */
export function contactsToutesOrigines(offre: Offre): boolean {
  return offre === 'base';
}

/** La limite de contacts d'un espace, et l'offre qui la fixe : c'est elle qui dit ce qu'on compte (`contactsToutesOrigines`). */
export interface LimiteContacts {
  max: number;
  offre: Offre;
}

/** La limite de contacts de cette offre et de ses droits ; `null` sans limite, et rien n'est alors compté ni refusé. */
export function limiteContactsDe(o: { offre: Offre; droits: Droits }): LimiteContacts | null {
  const max = o.droits.limites.contacts;
  return max === null ? null : { max, offre: o.offre };
}

/**
 * Les offres qui incluent le numéro fourni (`limites.numeroInclus`) : le Pro, le Business et l'Entreprise. La couverture
 * du numéro les lit en SQL (`offre_de_l_espace(...) = any(...)`, `src/stripe/abonnements.pg.ts` et
 * `src/numero/liberation.pg.ts`) plutôt qu'un nom d'offre écrit en dur.
 */
export const OFFRES_NUMERO_INCLUS: readonly Offre[] = (['base', 'pro', 'business', 'entreprise'] as const)
  .filter((o) => DROITS[o].limites.numeroInclus);

/**
 * Les offres qui ouvrent le RCS (la fonction `rcs`) : l'Entreprise seule. La résolution de l'agent RCS d'un espace et
 * l'expéditeur d'une campagne RCS les lisent en SQL (`src/rcs/store.pg.ts`) : un espace descendu de l'Entreprise garde
 * son agent en base, mais n'envoie plus de RCS par aucun chemin (spec Business, 2026-10-27).
 */
export const OFFRES_RCS: readonly Offre[] = (['base', 'pro', 'business', 'entreprise'] as const)
  .filter((o) => DROITS[o].fonctions.has('rcs'));

/**
 * La conservation de la Base ne s'applique que 30 jours après l'entrée en Base (spec § 7, lot 6, C) : la création de
 * l'espace, la fin de son dernier Pro, ou sa sortie de l'Entreprise (`tenants.entreprise_quittee_le`, migration 0221).
 * Le temps de se réabonner ou d'exporter : changer d'offre ne purge jamais sur le coup. Lu par la purge et par l'écran
 * (`src/inbox/retention.ts`).
 */
export const GRACE_RETOUR_BASE_JOURS = 30;

/**
 * Les prix HT du Pro, en centimes (lot 6, livraison B1, décision de Julien du 2026-10-07) : 49 € par mois, 490 € par an,
 * taxe en sus. La route de paiement les recoupe avec le prix posé chez Stripe AVANT d'ouvrir un paiement, et la vue de
 * l'offre les montre à la console : jamais recopiés ailleurs.
 */
export const PRIX_PRO_HT_CENTIMES: Readonly<{ mois: number; an: number }> = { mois: 4900, an: 49000 };

/**
 * L'essai du Pro, en jours (spec offres v2, livraison 6) : carte demandée, une fois par espace (jamais s'il a déjà eu un
 * Pro). Le Pro est ouvert pendant l'essai ; à sa fin sans paiement, l'espace revient en Free comme à la fin d'un Pro.
 */
export const ESSAI_PRO_JOURS = 14;

/**
 * Le prix HT d'un siège du Pro, un utilisateur de plus que les 3 inclus (spec offres v2, livraison 7), en centimes : 15 € par
 * mois, 150 € par an, selon la formule du Pro. La route d'achat les recoupe avec le prix posé chez Stripe, la vue de
 * l'offre et le refus d'une invitation les montrent : jamais recopiés ailleurs.
 */
export const PRIX_SIEGE_HT_CENTIMES: Readonly<{ mois: number; an: number }> = { mois: 1500, an: 15000 };

/**
 * Les prix HT du Business, en centimes (spec du 2026-10-27) : 349 € par mois, et 10 € par mois l'utilisateur au-delà des 5
 * inclus. Aucun prix Stripe : Julien pose le Business dans `/ops` et le facture lui-même. La vue de l'offre les montre, la
 * vitrine les recopie sous le contrôle de `tests/vitrine-pages.test.ts` : jamais écrits ailleurs.
 */
export const PRIX_BUSINESS_HT_CENTIMES: Readonly<{ mois: number }> = { mois: 34900 };
export const PRIX_SIEGE_BUSINESS_HT_CENTIMES: Readonly<{ mois: number }> = { mois: 1000 };

/**
 * Les droits d'un espace : ceux de son offre, et pour l'Entreprise ou le Business la surcharge de l'exploitation. Copie
 * neuve.
 * 🔴 `sieges` : les sièges payés du Pro vivant (`abonnements_offre.sieges`, livraison 7), ajoutés aux utilisateurs du Pro
 * ICI SEULEMENT, pour que l'invitation et le gel lisent la même limite (un membre payé n'est jamais gelé).
 * 🔴 Le Business ne prend de `/ops` que sa limite d'utilisateurs, et `null` y veut dire « les 5 de la grille », jamais
 * « sans limite » comme pour l'Entreprise : le reste de sa grille ne se négocie pas.
 */
export function droitsDe(offre: Offre, surcharge: SurchargeEntreprise | null, sieges = 0): Droits {
  const d = DROITS[offre];
  const limites: Limites = { ...d.limites };
  if (offre === 'pro' && limites.utilisateurs !== null) limites.utilisateurs += Math.max(0, sieges);
  if (offre === 'business' && surcharge?.utilisateurs != null) limites.utilisateurs = surcharge.utilisateurs;
  if (offre === 'entreprise' && surcharge !== null) {
    limites.utilisateurs = surcharge.utilisateurs;
    if (surcharge.conservationJours !== null) limites.conservationJours = surcharge.conservationJours;
    if (surcharge.contacts != null) limites.contacts = surcharge.contacts;
    if (surcharge.commissionPct != null) limites.commissionPct = surcharge.commissionPct;
  }
  return { fonctions: new Set(d.fonctions), limites };
}
