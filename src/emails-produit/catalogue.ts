/**
 * LE CATALOGUE DES E-MAILS DU PRODUIT (lot 7, spec `docs/superpowers/specs/2026-10-14-emails-produit-design.md`).
 *
 * Le catalogue vit dans le code, les textes modifiés en base (`emails_produit_textes`, migration 0234) : chaque modèle
 * déclare ici sa catégorie, ses variables et ses textes d'origine en français et en anglais. Une ligne en base remplace
 * le texte d'origine de SA langue ; « Rétablir » la supprime. Ajouter un e-mail, c'est ajouter une entrée ici.
 *
 * Les catégories décident de ce qu'une personne peut couper (décision de Julien du 2026-10-14) : `service` part
 * toujours (crédit, numéro, limites) ; `transfert` et `commercial` portent un lien de désinscription.
 *
 * 🔴 Les textes sont au VOUVOIEMENT, sans tiret long (règle de rédaction de Julien), et ne citent aucune donnée de
 * contact : seulement l'espace, des dates et des liens de la console.
 */

export const LANGUES = ['fr', 'en'] as const;
export type Langue = (typeof LANGUES)[number];

export const CATEGORIES = ['service', 'transfert', 'commercial'] as const;
export type Categorie = (typeof CATEGORIES)[number];

/** Ce qu'une personne peut couper : les deux catégories qui portent un lien de désinscription. */
export type CategorieCoupable = Exclude<Categorie, 'service'>;

export function estCoupable(c: Categorie): c is CategorieCoupable {
  return c !== 'service';
}

/**
 * Une variable qu'un texte peut citer (`{{nom}}`). `date` : une date ISO, écrite au rendu dans la langue de la personne
 * et le fuseau de l'espace ; `lien` : une adresse de la console ; `texte` : une valeur, échappée au rendu. L'exemple
 * remplit l'aperçu de `/ops`.
 */
export interface Variable {
  readonly description: string;
  readonly forme: 'texte' | 'date' | 'lien';
  readonly exemple: string;
}

export interface Bouton {
  readonly libelle: string;
  readonly lien: string;
}

/** Un texte d'e-mail : un sujet, des paragraphes séparés par une ligne vide, et un bouton facultatif. */
export interface TexteEmail {
  readonly sujet: string;
  readonly corps: string;
  readonly bouton: Bouton | null;
}

export interface ModeleEmail {
  readonly cle: string;
  readonly categorie: Categorie;
  /** Le nom du modèle dans `/ops`. */
  readonly nom: string;
  /** Quand il part, en une phrase, pour `/ops`. */
  readonly quand: string;
  readonly variables: Readonly<Record<string, Variable>>;
  readonly textes: Readonly<Record<Langue, TexteEmail>>;
}

/** Les variables que tout texte peut citer. */
export const VARIABLES_COMMUNES: Readonly<Record<string, Variable>> = {
  espace: { description: 'Le nom de l’espace', forme: 'texte', exemple: 'Boulangerie Martin' },
};

const LIEN_NUMERO: Variable = { description: 'La page « Connecter WhatsApp » de la console', forme: 'lien', exemple: 'https://console.messagingme.app/connecter-whatsapp' };
const DATE_LIBERATION: Variable = { description: 'Le jour où le numéro sera libéré', forme: 'date', exemple: '2026-11-02T10:00:00.000Z' };

export const CATALOGUE = [
  {
    cle: 'credit_epuise',
    categorie: 'service',
    nom: 'Crédit IA épuisé',
    quand: 'Un message arrive ou un agent IA veut répondre alors que le crédit IA est à zéro. Une fois par jour au plus.',
    variables: {
      lien_credit: { description: 'La page Crédit IA de la console', forme: 'lien', exemple: 'https://console.messagingme.app/parametres/credit' },
    },
    textes: {
      fr: {
        sujet: 'Crédit IA épuisé : vos agents IA ne répondent plus',
        corps: 'Bonjour,\n\nLe crédit IA de l’espace {{espace}} est épuisé. Vos agents IA, dont le répondeur automatique, ne '
          + 'répondent plus : les messages qu’ils auraient pris arrivent dans « À traiter » de l’Inbox, pour votre équipe.\n\n'
          + 'Rechargez le crédit pour qu’ils reprennent.\n\nCette alerte part une fois par jour au plus.',
        bouton: { libelle: 'Recharger le crédit IA', lien: '{{lien_credit}}' },
      },
      en: {
        sujet: 'AI credit used up: your AI agents no longer reply',
        corps: 'Hello,\n\nThe AI credit of the {{espace}} workspace is used up. Your AI agents, including the automatic '
          + 'responder, no longer reply: the messages they would have taken go to “To do” in the Inbox, for your team.\n\n'
          + 'Top up the credit so they start again.\n\nThis alert is sent at most once a day.',
        bouton: { libelle: 'Top up AI credit', lien: '{{lien_credit}}' },
      },
    },
  },
  {
    cle: 'numero_suspendu_fin',
    categorie: 'service',
    nom: 'Numéro fourni suspendu : abonnement terminé',
    quand: 'L’abonnement du numéro fourni est terminé : ses envois sont coupés, le numéro reste réservé 7 jours.',
    variables: { date_liberation: DATE_LIBERATION, lien_numero: LIEN_NUMERO },
    textes: {
      fr: {
        sujet: 'Votre numéro WhatsApp n’envoie plus de messages',
        corps: 'Bonjour,\n\nL’abonnement du numéro WhatsApp fourni à l’espace {{espace}} est terminé : ses envois sont coupés '
          + '(réponses de l’Inbox, campagnes, scénarios, agents IA et API).\n\nLe numéro reste réservé à votre espace jusqu’au '
          + '{{date_liberation}}. Pour le garder, réabonnez-vous avant cette date depuis la page « Connecter WhatsApp » de la '
          + 'console, ou demandez-le à Claude : vous retrouvez le même numéro, sans rien reconfigurer.\n\nPassé cette date, il '
          + 'sera libéré et ne pourra plus être rendu.',
        bouton: { libelle: 'Ouvrir « Connecter WhatsApp »', lien: '{{lien_numero}}' },
      },
      en: {
        sujet: 'Your WhatsApp number no longer sends messages',
        corps: 'Hello,\n\nThe subscription for the WhatsApp number provided to the {{espace}} workspace has ended: its sends '
          + 'are stopped (Inbox replies, campaigns, scenarios, AI agents and API).\n\nThe number stays reserved for your '
          + 'workspace until {{date_liberation}}. To keep it, subscribe again before that date from the “Connect WhatsApp” '
          + 'page of the console, or ask Claude: you get the same number back, with nothing to set up again.\n\nAfter that '
          + 'date, it will be released and cannot be given back.',
        bouton: { libelle: 'Open “Connect WhatsApp”', lien: '{{lien_numero}}' },
      },
    },
  },
  {
    cle: 'numero_suspendu_impaye',
    categorie: 'service',
    nom: 'Numéro fourni suspendu : facture impayée',
    quand: 'Le renouvellement du numéro fourni n’est pas payé depuis 7 jours : ses envois sont coupés.',
    variables: { lien_numero: LIEN_NUMERO },
    textes: {
      fr: {
        sujet: 'Votre numéro WhatsApp n’envoie plus de messages',
        corps: 'Bonjour,\n\nLe renouvellement de l’abonnement du numéro WhatsApp fourni à l’espace {{espace}} n’a pas été payé '
          + 'depuis 7 jours : ses envois sont coupés (réponses de l’Inbox, campagnes, scénarios, agents IA et API).\n\nRéglez '
          + 'la facture depuis la page « Connecter WhatsApp » de la console (« Gérer mon abonnement »), ou demandez-le à '
          + 'Claude : les envois reprennent dès le paiement.',
        bouton: { libelle: 'Ouvrir « Connecter WhatsApp »', lien: '{{lien_numero}}' },
      },
      en: {
        sujet: 'Your WhatsApp number no longer sends messages',
        corps: 'Hello,\n\nThe renewal of the subscription for the WhatsApp number provided to the {{espace}} workspace has not '
          + 'been paid for 7 days: its sends are stopped (Inbox replies, campaigns, scenarios, AI agents and API).\n\nPay the '
          + 'invoice from the “Connect WhatsApp” page of the console (“Manage my subscription”), or ask Claude: sends resume '
          + 'as soon as it is paid.',
        bouton: { libelle: 'Open “Connect WhatsApp”', lien: '{{lien_numero}}' },
      },
    },
  },
  {
    cle: 'numero_rappel_liberation',
    categorie: 'service',
    nom: 'Numéro fourni : libéré dans 2 jours',
    quand: 'Deux jours avant la libération d’un numéro fourni dont l’abonnement est terminé.',
    variables: { date_liberation: DATE_LIBERATION, lien_numero: LIEN_NUMERO },
    textes: {
      fr: {
        sujet: 'Votre numéro WhatsApp sera libéré le {{date_liberation}}',
        corps: 'Bonjour,\n\nL’abonnement du numéro WhatsApp fourni à l’espace {{espace}} est terminé, et le numéro sera libéré '
          + 'le {{date_liberation}} : il quittera votre espace et ne pourra plus être rendu.\n\nPour le garder, réabonnez-vous '
          + 'avant cette date depuis la page « Connecter WhatsApp » de la console, ou demandez-le à Claude.',
        bouton: { libelle: 'Ouvrir « Connecter WhatsApp »', lien: '{{lien_numero}}' },
      },
      en: {
        sujet: 'Your WhatsApp number will be released on {{date_liberation}}',
        corps: 'Hello,\n\nThe subscription for the WhatsApp number provided to the {{espace}} workspace has ended, and the '
          + 'number will be released on {{date_liberation}}: it will leave your workspace and cannot be given back.\n\nTo '
          + 'keep it, subscribe again before that date from the “Connect WhatsApp” page of the console, or ask Claude.',
        bouton: { libelle: 'Open “Connect WhatsApp”', lien: '{{lien_numero}}' },
      },
    },
  },
  {
    cle: 'numero_libere',
    categorie: 'service',
    nom: 'Numéro fourni libéré',
    quand: 'Le numéro fourni est libéré, 7 jours après la fin de son abonnement.',
    variables: { lien_numero: LIEN_NUMERO },
    textes: {
      fr: {
        sujet: 'Votre numéro WhatsApp a été libéré',
        corps: 'Bonjour,\n\nL’abonnement du numéro WhatsApp fourni à l’espace {{espace}} étant terminé depuis 7 jours, le '
          + 'numéro a été libéré : il ne fait plus partie de votre espace et ne peut plus être rendu.\n\nPour continuer sur '
          + 'WhatsApp, connectez un autre numéro depuis la page « Connecter WhatsApp » de la console.',
        bouton: { libelle: 'Ouvrir « Connecter WhatsApp »', lien: '{{lien_numero}}' },
      },
      en: {
        sujet: 'Your WhatsApp number has been released',
        corps: 'Hello,\n\nThe subscription for the WhatsApp number provided to the {{espace}} workspace ended 7 days ago, so '
          + 'the number has been released: it is no longer part of your workspace and cannot be given back.\n\nTo carry on '
          + 'with WhatsApp, connect another number from the “Connect WhatsApp” page of the console.',
        bouton: { libelle: 'Open “Connect WhatsApp”', lien: '{{lien_numero}}' },
      },
    },
  },
  {
    cle: 'pro_suite_numero',
    categorie: 'service',
    nom: 'Fin du Pro : la suite du numéro fourni',
    quand: 'L’offre Pro arrive à sa fin prévue : le numéro inclus passe à 3,50 € HT par mois, ou se rend.',
    variables: {
      date_fin_pro: { description: 'Le jour où l’offre Pro se termine', forme: 'date', exemple: '2026-11-15T10:00:00.000Z' },
      lien_offre: { description: 'La page Offre de la console', forme: 'lien', exemple: 'https://console.messagingme.app/offre' },
    },
    textes: {
      fr: {
        sujet: 'Votre offre Pro se termine le {{date_fin_pro}} : et votre numéro WhatsApp ?',
        corps: 'Bonjour,\n\nL’offre Pro de l’espace {{espace}} se termine le {{date_fin_pro}}. Le numéro WhatsApp que nous '
          + 'vous avons fourni y était inclus.\n\nÀ cette date, vous le gardez : il passera à 3,50 € HT par mois, prélevés sur '
          + 'la même carte que votre Pro, sans rien reconfigurer.\n\nSi vous préférez le rendre, choisissez-le sur la page '
          + '« Offre » de la console, ou demandez-le à Claude : ses envois seront coupés à la fin du Pro, puis il sera libéré '
          + '7 jours après.',
        bouton: { libelle: 'Ouvrir la page « Offre »', lien: '{{lien_offre}}' },
      },
      en: {
        sujet: 'Your Pro plan ends on {{date_fin_pro}}: what about your WhatsApp number?',
        corps: 'Hello,\n\nThe Pro plan of the {{espace}} workspace ends on {{date_fin_pro}}. The WhatsApp number we provided '
          + 'was included in it.\n\nOn that date, you keep it: it will cost €3.50 excl. VAT per month, charged to the same '
          + 'card as your Pro, with nothing to set up again.\n\nIf you would rather give it back, choose so on the “Plan” '
          + 'page of the console, or ask Claude: its sends will stop at the end of the Pro, then it will be released 7 days '
          + 'later.',
        bouton: { libelle: 'Open the “Plan” page', lien: '{{lien_offre}}' },
      },
    },
  },
] as const satisfies readonly ModeleEmail[];

export type CleEmail = (typeof CATALOGUE)[number]['cle'];

const PAR_CLE: ReadonlyMap<string, ModeleEmail> = new Map(CATALOGUE.map((m) => [m.cle, m]));

/** Le modèle d'une clé, ou `null` : une clé lue en base ou dans une adresse n'est pas forcément du catalogue. */
export function modeleDe(cle: string): ModeleEmail | null {
  return PAR_CLE.get(cle) ?? null;
}

/** Les variables qu'un modèle permet : les siennes et les communes. */
export function variablesDe(m: ModeleEmail): Readonly<Record<string, Variable>> {
  return { ...VARIABLES_COMMUNES, ...m.variables };
}

/** Les noms cités par un texte (`{{nom}}`), dans l'ordre, sans doublon. */
export function variablesCitees(texte: TexteEmail): string[] {
  const vus = new Set<string>();
  for (const morceau of [texte.sujet, texte.corps, texte.bouton?.libelle ?? '', texte.bouton?.lien ?? '']) {
    for (const m of morceau.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) vus.add(m[1]!);
  }
  return [...vus];
}

/** Les variables citées qu'un modèle ne connaît pas. Vide = le texte est enregistrable. */
export function variablesInconnues(m: ModeleEmail, texte: TexteEmail): string[] {
  const permises = variablesDe(m);
  return variablesCitees(texte).filter((v) => !Object.hasOwn(permises, v));
}
