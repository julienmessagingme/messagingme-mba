/**
 * Ce qu'on envoie à Meta pour créer une publicité Click-to-WhatsApp. Module pur (aucune IO), pour comparer le
 * texte exact envoyé à Meta aux exemples de sa documentation, sans réseau. Source : la page Meta « Publicités
 * clic vers WhatsApp », relue en ligne ; un corpus téléchargé vieillit sans le dire.
 */

/**
 * L'objectif de campagne. `OUTCOME_ENGAGEMENT` est le seul des quatre objectifs clic vers WhatsApp qui accepte
 * les deux optimisations utiles (`CONVERSATIONS` et `LINK_CLICKS`) : `OUTCOME_LEADS` n'accepte que la première.
 */
export const OBJECTIF_CAMPAGNE = 'OUTCOME_ENGAGEMENT';

/**
 * L'optimisation de l'ensemble de publicités, à confirmer par la première création réelle (`CONVERSATIONS`
 * pourrait être refusée en Europe). 🔴 Pas de repli silencieux vers `LINK_CLICKS` : le client paierait des clics
 * en croyant payer des conversations. Une création refusée affiche le message de Meta.
 */
export const OPTIMISATION_ENSEMBLE = 'CONVERSATIONS';

/**
 * Le lien de la créa. Ce n'est pas une adresse qu'on choisit : c'est la valeur que Meta attend pour qu'un
 * clic ouvre WhatsApp, et le numéro joint vient de `promoted_object` de l'ensemble de publicités.
 */
export const LIEN_WHATSAPP = 'https://api.whatsapp.com/send';

/** Ce qu'on demande à Meta de créer : tout en pause, sans exception. Voir `CreationPub`. */
export const STATUT_PAUSE = 'PAUSED';
export const STATUT_ACTIF = 'ACTIVE';

/** Ce que l'écran a saisi, déjà validé, tel que la création le consomme. */
export interface FormulairePub {
  nom: string;
  /** Le texte principal de la publicité (`link_data.message`). */
  texte: string;
  /** Le titre, court, affiché en gras (`link_data.name`). */
  titre: string;
  /** Le message que WhatsApp pré-remplit dans la zone de saisie du prospect. */
  messagePreRempli: string;
  /** La phrase d'accueil affichée dans la conversation avant que le prospect n'écrive. */
  accueil: string;
  /** Budget total, dans l'unité principale de la devise du compte (des euros, pas des centimes). */
  budgetTotal: number;
  /**
   * Bornes de diffusion telles que le client les a saisies, transmises à Meta sans conversion. Une date sans
   * décalage est lue par Meta dans le fuseau du compte publicitaire : juste pour un compte et un client en France,
   * décalée de quelques heures si les fuseaux diffèrent.
   */
  debut: string;
  fin: string;
  /** Pays en ISO 2 lettres. Vide si un rayon est donné. */
  pays: string[];
  /** Ciblage par ville et rayon, quand le client l'a choisi plutôt qu'un pays. */
  villes: Array<{ cle: string; rayon: number; unite: 'kilometer' | 'mile' }>;
  ageMin: number;
  ageMax: number;
}

/**
 * 🔴 Le budget en unités mineures de la devise du compte : Meta compte en centimes pour tous les montants de
 * l'API Marketing, et se tromper coûte cent fois le budget. `Math.round` plutôt qu'une troncature (10,99 € ne
 * doit pas devenir 10,98 €). Faux pour une devise sans sous-unité (yen, won), que Meta compte en unités entières.
 */
export function budgetEnUnitesMineures(montant: number): number {
  return Math.round(montant * 100);
}

/**
 * Le message d'accueil de la page, dans la forme que Meta documente. `text` est la phrase que le prospect lit en
 * ouvrant la conversation ; `autofill_message.content` est ce que WhatsApp pré-remplit dans sa zone de saisie,
 * et c'est ce message, arrivé en webhook avec son `referral`, qui déclenche tout chez nous.
 */
export function messageBienvenue(accueil: string, preRempli: string): Record<string, unknown> {
  return {
    type: 'VISUAL_EDITOR',
    version: 2,
    landing_screen_type: 'welcome_message',
    media_type: 'text',
    text_format: {
      customer_action_type: 'autofill_message',
      message: {
        autofill_message: { content: preRempli },
        text: accueil,
      },
    },
  };
}

/** La campagne, hors catégorie spéciale seulement (`special_ad_categories` vide). */
export function payloadCampagne(nom: string): Record<string, unknown> {
  return {
    name: nom,
    objective: OBJECTIF_CAMPAGNE,
    // Obligatoire et vide : logement, emploi, crédit ou politique imposent un ciblage restreint et des obligations
    // légales que cet écran ne porte pas. L'écran l'exige par une case à cocher ; la liste vide le dit à Meta.
    special_ad_categories: [],
    status: STATUT_PAUSE,
  };
}

/**
 * Le ciblage : `geo_locations` est obligatoire, et c'est le seul champ exposé. `device_platforms` n'est pas
 * posé : un clic depuis un ordinateur ouvre WhatsApp Web, sans la fenêtre gratuite de 72 h, mais c'est un
 * prospect réel.
 */
export function ciblage(f: Pick<FormulairePub, 'pays' | 'villes' | 'ageMin' | 'ageMax'>): Record<string, unknown> {
  const geo: Record<string, unknown> = {};
  if (f.pays.length > 0) geo.countries = f.pays;
  if (f.villes.length > 0) {
    geo.custom_locations = f.villes.map((v) => ({ key: v.cle, radius: v.rayon, distance_unit: v.unite }));
  }
  return { geo_locations: geo, age_min: f.ageMin, age_max: f.ageMax };
}

/**
 * L'ensemble de publicités : budget, dates, ciblage, et le numéro WhatsApp qui recevra les leads.
 * `lifetime_budget` exige `end_time` (contrainte Meta, et garde-fou du produit). Ni `bid_amount` ni
 * `bid_strategy` : le défaut `LOWEST_COST_WITHOUT_CAP` dépense le budget au mieux, et un plafond d'enchère
 * deviné choisirait pour le client combien vaut un prospect.
 */
export function payloadEnsemble(
  f: FormulairePub,
  v: { campagneId: string; pageId: string; numeroWhatsApp: string | null },
): Record<string, unknown> {
  return {
    name: f.nom,
    campaign_id: v.campagneId,
    status: STATUT_PAUSE,
    billing_event: 'IMPRESSIONS',
    optimization_goal: OPTIMISATION_ENSEMBLE,
    destination_type: 'WHATSAPP',
    lifetime_budget: budgetEnUnitesMineures(f.budgetTotal),
    start_time: f.debut,
    end_time: f.fin,
    targeting: ciblage(f),
    // `whatsapp_phone_number` est facultatif chez Meta mais posé quand on le connaît : sans lui, Meta choisit le
    // numéro associé à la Page, qui peut ne pas être celui de cet espace.
    promoted_object: {
      page_id: v.pageId,
      ...(v.numeroWhatsApp ? { whatsapp_phone_number: v.numeroWhatsApp } : {}),
    },
  };
}

/**
 * La créa : l'image, les textes, le bouton et le message pré-rempli. La documentation de Meta se contredit sur
 * l'emplacement de `page_welcome_message` (dans `link_data` à la création, sous `object_story_spec` à la
 * lecture) : on suit les exemples de création, et un refus de Meta s'affiche tel quel.
 */
export function payloadCrea(
  f: FormulairePub,
  v: { pageId: string; imageHash: string },
): Record<string, unknown> {
  return {
    name: f.nom,
    object_story_spec: {
      page_id: v.pageId,
      link_data: {
        name: f.titre,
        message: f.texte,
        image_hash: v.imageHash,
        link: LIEN_WHATSAPP,
        page_welcome_message: messageBienvenue(f.accueil, f.messagePreRempli),
        call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } },
      },
    },
  };
}

/** La publicité : le mariage de la créa et de l'ensemble. En pause, comme tout le reste. */
export function payloadPub(nom: string, v: { ensembleId: string; creaId: string }): Record<string, unknown> {
  return {
    name: nom,
    adset_id: v.ensembleId,
    creative: { creative_id: v.creaId },
    status: STATUT_PAUSE,
  };
}
