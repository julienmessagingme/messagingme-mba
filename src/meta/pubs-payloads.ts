/**
 * CE QU'ON ENVOIE À META POUR CRÉER UNE PUBLICITÉ CLICK-TO-WHATSAPP. Module PUR : aucune IO, aucun import
 * qui tire pg. Les charges utiles entrent en objets et sortent en objets, ce qui permet de comparer le texte
 * EXACT envoyé à Meta avec les exemples de sa documentation, en quelques millisecondes et sans réseau
 * (spec § 5 : « le texte exact envoyé à Meta pour la campagne, l'ensemble de pubs, la créa et le message
 * pré-rempli, comparé aux exemples de la doc »).
 *
 * 🔴 RELU EN LIGNE LE 2026-09-23, PAS DE MÉMOIRE NI D'UN CORPUS TÉLÉCHARGÉ. Source :
 * developers.facebook.com, « Publicités clic vers WhatsApp », page mise à jour le 2026-05-21. Ce dépôt a
 * déjà payé la leçon inverse : un corpus OpenAPI téléchargé affirmait qu'il n'existait pas d'action `take`
 * sur `thread_control`, Meta l'avait ajoutée, et « Reprendre la main » n'éteignait pas l'agent de Meta.
 * **Un document téléchargé ne vieillit pas tout seul, il a l'air d'une source primaire et n'en est plus une.**
 */

/**
 * L'OBJECTIF DE CAMPAGNE, et il n'y en a qu'un chez nous.
 *
 * Meta en accepte quatre pour le clic vers WhatsApp (`OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_SALES`,
 * `OUTCOME_TRAFFIC`). On prend `OUTCOME_ENGAGEMENT` parce que c'est le seul qui accepte les DEUX
 * optimisations dont on a besoin (`CONVERSATIONS` et `LINK_CLICKS`) : `OUTCOME_LEADS` n'accepte que
 * `CONVERSATIONS`, donc il condamnerait le repli si la mesure du pilote refusait `CONVERSATIONS` en France.
 */
export const OBJECTIF_CAMPAGNE = 'OUTCOME_ENGAGEMENT';

/**
 * L'OPTIMISATION DE L'ENSEMBLE DE PUBLICITÉS, ET C'EST UNE CONSTANTE QUI ATTEND SA MESURE.
 *
 * 🔴 CE QUE LA SPEC EXIGE, mot pour mot (§ 4) : « `CONVERSATIONS` refusée pour la France : mesurée une fois
 * au pilote, puis figée dans une constante. **Pas de repli silencieux** : une création refusée affiche le
 * message de Meta. » Un repli automatique vers `LINK_CLICKS` paraîtrait serviable et serait un piège : le
 * client paierait des clics là où il croit payer des conversations, et personne ne le saurait jamais.
 *
 * ⚠️ NON MESURÉE À CE JOUR. Une agence britannique rapporte que ni `CONVERSATIONS` ni les leads ne passent
 * pour l'Europe, et aucune liste officielle n'existe. La première création réelle du pilote tranche, et
 * c'est CETTE ligne qu'on change alors, une fois.
 */
export const OPTIMISATION_ENSEMBLE = 'CONVERSATIONS';

/**
 * Le lien de la créa. Ce n'est pas une adresse qu'on choisit : c'est la valeur que Meta attend pour qu'un
 * clic ouvre WhatsApp, et le numéro joint vient de `promoted_object` de l'ensemble de publicités.
 */
export const LIEN_WHATSAPP = 'https://api.whatsapp.com/send';

/** Ce qu'on demande à Meta de créer : tout en PAUSE, sans exception. Voir `CreationPub`. */
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
  /** Budget TOTAL, dans l'unité PRINCIPALE de la devise du compte (des euros, pas des centimes). */
  budgetTotal: number;
  /** Bornes de diffusion, déjà exprimées dans le fuseau du compte publicitaire par l'appelant. */
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
 * LE BUDGET, EN UNITÉS MINEURES DE LA DEVISE DU COMPTE.
 *
 * 🔴 META COMPTE EN CENTIMES, ET SE TROMPER ICI COÛTE CENT FOIS LE BUDGET, ou un centième. Sa documentation
 * dit « dans la devise de votre compte » et donne `1` en exemple, ce qui ne lève pas l'ambiguïté à la
 * lecture ; c'est sa convention pour tous les montants de l'API Marketing. Un nombre entier est exigé :
 * `Math.round` plutôt qu'une troncature, sinon 10,99 € deviendrait 10,98 €.
 *
 * ⚠️ LES DEVISES SANS SOUS-UNITÉ (le yen, le won) SE COMPTENT EN UNITÉS ENTIÈRES chez Meta, donc ce calcul
 * y serait faux d'un facteur cent. Le pilote est en euros et le compte du client porte sa devise
 * (`pub_connexion.devise`) : le jour où un compte n'est pas en euros, c'est cette fonction qu'on ouvre, et
 * cette ligne est là pour qu'on la trouve.
 */
export function budgetEnUnitesMineures(montant: number): number {
  return Math.round(montant * 100);
}

/**
 * LE MESSAGE D'ACCUEIL DE LA PAGE, dans la forme exacte que Meta documente pour un message pré-rempli.
 *
 * Deux textes, et ils ne servent pas à la même chose : `text` est la phrase que le prospect LIT en ouvrant
 * la conversation, `autofill_message.content` est ce que WhatsApp ÉCRIT dans sa zone de saisie, qu'il n'a
 * plus qu'à envoyer. C'est ce second message qui déclenche tout chez nous, puisque c'est lui qui arrive en
 * webhook avec son `referral`.
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

/** La campagne. `special_ad_categories` VIDE : hors catégorie spéciale seulement (spec, § 4 et § 10). */
export function payloadCampagne(nom: string): Record<string, unknown> {
  return {
    name: nom,
    objective: OBJECTIF_CAMPAGNE,
    // 🔴 OBLIGATOIRE ET VIDE. Une pub de logement, d'emploi, de crédit ou de politique relève d'une
    // catégorie spéciale, qui impose un ciblage restreint et des obligations légales que cet écran ne sait
    // pas porter. L'écran l'exige par une case à cocher ; ici, la liste vide est ce qui le dit à Meta.
    special_ad_categories: [],
    status: STATUT_PAUSE,
  };
}

/**
 * LE CIBLAGE. `geo_locations` est obligatoire, et c'est le seul champ de ciblage que ce lot expose.
 *
 * ⚠️ `device_platforms` N'EST PAS POSÉ, délibérément. Le restreindre à `mobile` paraît naturel pour une pub
 * qui ouvre WhatsApp, et ce serait une erreur coûteuse : un clic depuis un ORDINATEUR fonctionne (il ouvre
 * WhatsApp Web), il n'ouvre simplement pas la fenêtre de 72 h gratuites. Exclure ces clics retirerait des
 * prospects réels pour économiser une gratuité.
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
 * L'ENSEMBLE DE PUBLICITÉS : le budget, les dates, le ciblage, et le numéro WhatsApp qui recevra les leads.
 *
 * 🔴 `lifetime_budget` EXIGE `end_time`, et c'est Meta qui le dit. Le garde-fou du produit (budget total et
 * date de fin OBLIGATOIRES, décision de Julien) et la contrainte de l'API disent donc la même chose, ce qui
 * n'est pas un hasard : un budget total sans fin n'a pas de sens, il ne borne rien tant qu'il n'est pas
 * consommé.
 *
 * ⚠️ NI `bid_amount` NI `bid_strategy`. Meta n'exige `bid_amount` que si la stratégie est plafonnée
 * (`LOWEST_COST_WITH_BID_CAP`, `COST_CAP`) ; sans stratégie déclarée, le défaut est `LOWEST_COST_WITHOUT_CAP`,
 * c'est-à-dire « dépense le budget au mieux ». Poser un plafond d'enchère deviné à la place du client serait
 * choisir pour lui combien vaut un prospect.
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
    // ⚠️ `whatsapp_phone_number` est FACULTATIF chez Meta, et on le pose quand on le connaît : sans lui, Meta
    // choisit le numéro associé à la Page, qui peut ne pas être celui de cet espace. La Page est obligatoire.
    promoted_object: {
      page_id: v.pageId,
      ...(v.numeroWhatsApp ? { whatsapp_phone_number: v.numeroWhatsApp } : {}),
    },
  };
}

/**
 * LA CRÉA : l'image, les textes, le bouton, et le message pré-rempli.
 *
 * ⚠️ LA DOCUMENTATION DE META SE CONTREDIT SUR L'EMPLACEMENT DE `page_welcome_message`, et il faut le dire
 * plutôt que de choisir en silence. Ses DEUX exemples de création le posent dans `link_data` ; sa lecture
 * (`GET /<AD_CREATIVE_ID>`) le rend sous `object_story_spec`, à côté de `link_data`. On suit les exemples de
 * CRÉATION, puisque c'est ce qu'on fait. **Non mesuré** : la première création réelle du pilote tranche, et
 * si Meta refuse, son message s'affiche tel quel (aucun repli silencieux), donc l'erreur sera lisible.
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
