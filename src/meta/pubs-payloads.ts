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

/**
 * 🔴 HYPOTHÈSE QUE L'ESSAI RÉEL TRANCHE, ÉCRITE ICI ET NULLE PART AILLEURS : les boutons qu'une créa
 * Click-to-WhatsApp accepte (`call_to_action.type`).
 *
 * Seul `WHATSAPP_MESSAGE` est documenté par Meta côté API pour cette destination. Les neuf autres viennent de ce
 * que le Gestionnaire de publicités propose pour une destination WhatsApp (relevé le 2026-09-28) : rien ne dit
 * que l'API les accepte sur `link_data` et `video_data`. La liste est FERMÉE (la route la tient en énumération
 * Zod, création et brouillon) ; si Meta refuse un type à la première création réelle, son message s'affiche
 * (422, `src/http/pubs.ts`) et c'est cette liste, seule, qui perd le type refusé. La console en tient une copie
 * avec les libellés (`web/lib/api-pubs.ts`), en parité par `tests/web-pubs-parity.test.ts`.
 *
 * Seul `type` change d'un bouton à l'autre : `value`, le lien et `page_welcome_message` restent ceux du bouton
 * WhatsApp, puisque le clic ouvre toujours la conversation.
 */
export const BOUTONS_PUB = [
  'WHATSAPP_MESSAGE', 'LEARN_MORE', 'GET_QUOTE', 'BOOK_NOW', 'CONTACT_US',
  'SHOP_NOW', 'ORDER_NOW', 'SIGN_UP', 'SUBSCRIBE', 'APPLY_NOW',
] as const;
export type BoutonPub = (typeof BOUTONS_PUB)[number];

/** Le bouton d'une publicité qui ne dit rien de plus : le seul que Meta documente pour Click-to-WhatsApp. */
export const BOUTON_PUB_DEFAUT: BoutonPub = 'WHATSAPP_MESSAGE';

/** Une valeur lue ailleurs (base, ancien brouillon) est-elle un bouton de la liste ? */
export function estBoutonPub(v: unknown): v is BoutonPub {
  return typeof v === 'string' && (BOUTONS_PUB as readonly string[]).includes(v);
}

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
  /**
   * L'âge minimum, entre {@link AGE_MIN_ADVANTAGE_BAS} et {@link AGE_MIN_ADVANTAGE_HAUT}. Il n'y a PAS d'âge
   * maximum dans ce formulaire : avec Advantage+, Meta le fixe à {@link AGE_MAX_ADVANTAGE}, et un champ qu'on ne
   * peut pas honorer n'a rien à faire dans le type.
   */
  ageMin: number;
  /** Les audiences du compte publicitaire à inclure : des SUGGESTIONS pour Meta, qui peut diffuser au-delà. */
  audiencesIncluses: string[];
  /** Les audiences à exclure : un contrôle FERME, que Meta respecte même avec Advantage+. */
  audiencesExclues: string[];
  /** Le bouton de la créa (`call_to_action.type`), dans la liste {@link BOUTONS_PUB}. */
  bouton: BoutonPub;
}

/**
 * Advantage+ audience est laissé à Meta (décision de Julien, 2026-09-28), et depuis Graph v23 ce réglage doit
 * être EXPLICITE dans `targeting_automation.advantage_audience`. L'omettre était un défaut : Meta l'active alors
 * en silence, ou refuse la création quand l'âge n'est pas au défaut. Avec `1`, Meta n'accepte `age_min` qu'entre
 * 18 et 25 ans et fixe `age_max` à 65.
 */
export const ADVANTAGE_AUDIENCE = 1;
export const AGE_MIN_ADVANTAGE_BAS = 18;
export const AGE_MIN_ADVANTAGE_HAUT = 25;
export const AGE_MAX_ADVANTAGE = 65;

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
    // Exigé par Meta dès que la campagne ne porte pas le budget (refus #100, sous-code 4834011, mesuré le 2026-09-28) :
    // le budget est sur l'ensemble, et il n'y en a qu'un, donc rien à partager. `false` garde le budget exactement
    // celui que le client a fixé.
    is_adset_budget_sharing_enabled: false,
    status: STATUT_PAUSE,
  };
}

/**
 * Le ciblage : `geo_locations` est obligatoire. `device_platforms` n'est pas posé : un clic depuis un ordinateur
 * ouvre WhatsApp Web, sans la fenêtre gratuite de 72 h, mais c'est un prospect réel.
 *
 * 🔴 `targeting_automation` est TOUJOURS posé, à {@link ADVANTAGE_AUDIENCE} : c'est ce qui rend le réglage
 * explicite (voir la constante). Les audiences incluses deviennent alors des suggestions ; les exclusions, le lieu
 * et l'âge minimum restent des contrôles fermes. Les deux listes ne partent que non vides : une clé vide n'aurait
 * pas de sens chez Meta, et son absence est le comportement d'avant pour une publicité sans audience.
 *
 * 🔴 Un âge minimum hors de 18-25 LÈVE ici, dernière barrière avant l'argent du client : la route le refuse déjà
 * avec un message lisible, mais un appelant qui l'oublierait créerait sinon un ensemble que Meta refuse, ou pire,
 * qu'il corrige en silence.
 */
export function ciblage(
  f: Pick<FormulairePub, 'pays' | 'villes' | 'ageMin' | 'audiencesIncluses' | 'audiencesExclues'>,
): Record<string, unknown> {
  if (!Number.isInteger(f.ageMin) || f.ageMin < AGE_MIN_ADVANTAGE_BAS || f.ageMin > AGE_MIN_ADVANTAGE_HAUT) {
    throw new RangeError(`âge minimum ${f.ageMin} hors de ${AGE_MIN_ADVANTAGE_BAS}-${AGE_MIN_ADVANTAGE_HAUT} (Advantage+)`);
  }
  const geo: Record<string, unknown> = {};
  if (f.pays.length > 0) geo.countries = f.pays;
  if (f.villes.length > 0) {
    geo.custom_locations = f.villes.map((v) => ({ key: v.cle, radius: v.rayon, distance_unit: v.unite }));
  }
  return {
    geo_locations: geo,
    age_min: f.ageMin,
    age_max: AGE_MAX_ADVANTAGE,
    ...(f.audiencesIncluses.length > 0 ? { custom_audiences: f.audiencesIncluses.map((id) => ({ id })) } : {}),
    ...(f.audiencesExclues.length > 0 ? { excluded_custom_audiences: f.audiencesExclues.map((id) => ({ id })) } : {}),
    targeting_automation: { advantage_audience: ADVANTAGE_AUDIENCE },
  };
}

/**
 * L'ensemble de publicités : budget, dates, ciblage, et le numéro WhatsApp qui recevra les leads.
 * `lifetime_budget` exige `end_time` (contrainte Meta, et garde-fou du produit). `bid_strategy` est
 * `LOWEST_COST_WITHOUT_CAP`, POSÉ explicitement : Meta ne l'applique plus par défaut et réclame sinon un montant
 * d'enchère (#100, sous-code 2490487, mesuré le 2026-09-28). Jamais de `bid_amount` : un plafond d'enchère deviné
 * choisirait pour le client combien vaut un prospect.
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
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
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
        call_to_action: { type: f.bouton, value: { app_destination: 'WHATSAPP' } },
      },
    },
  };
}

/**
 * 🔴 HYPOTHÈSE NON DOCUMENTÉE, ISOLÉE ICI ET NULLE PART AILLEURS : la valeur du bouton d'une créa VIDÉO.
 *
 * `video_data` n'a pas de champ `link`, contrairement à `link_data` : Meta y documente `call_to_action.value.link`
 * pour les autres destinations, jamais pour Click-to-WhatsApp. On y pose donc le même lien que la créa image
 * ({@link LIEN_WHATSAPP}), à côté de `app_destination`. La première création réelle tranche : si Meta refuse, son
 * message s'affiche tel quel et c'est cette constante, seule, qui change.
 */
export const VALEUR_BOUTON_VIDEO: Readonly<Record<string, string>> = { app_destination: 'WHATSAPP', link: LIEN_WHATSAPP };

/**
 * La créa VIDÉO : `video_data` au lieu de `link_data`. La vignette (`image_hash`) est obligatoire chez Meta ;
 * c'est une des images qu'il extrait de la vidéo, REDÉPOSÉE comme image pour obtenir son empreinte : on ne cite
 * jamais une adresse de son CDN, signée et périssable. `title` et `message` portent les mêmes champs du
 * formulaire que `name` et `message` de la créa image.
 */
export function payloadCreaVideo(
  f: FormulairePub,
  v: { pageId: string; videoId: string; imageHash: string },
): Record<string, unknown> {
  return {
    name: f.nom,
    object_story_spec: {
      page_id: v.pageId,
      video_data: {
        video_id: v.videoId,
        image_hash: v.imageHash,
        title: f.titre,
        message: f.texte,
        page_welcome_message: messageBienvenue(f.accueil, f.messagePreRempli),
        call_to_action: { type: f.bouton, value: { ...VALEUR_BOUTON_VIDEO } },
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
