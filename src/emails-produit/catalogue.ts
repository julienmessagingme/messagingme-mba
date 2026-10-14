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
  /** `date_heure` : le jour et l'heure ; `euros` : un montant en micro-euros, écrit dans la langue de la personne. */
  readonly forme: 'texte' | 'date' | 'date_heure' | 'lien' | 'euros';
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
const LIEN_OFFRE: Variable = { description: 'La page Offre de la console', forme: 'lien', exemple: 'https://console.messagingme.app/offre' };
const LIMITE: Variable = { description: 'La limite de l’offre Free', forme: 'texte', exemple: '1000' };

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
  {
    cle: 'credit_bas',
    categorie: 'service',
    nom: 'Crédit IA presque épuisé',
    quand: 'Un débit fait passer le crédit IA sous 0,50 €. Une fois par recharge.',
    variables: {
      solde: { description: 'Le crédit restant', forme: 'euros', exemple: '420000' },
      lien_credit: { description: 'La page Crédit IA de la console', forme: 'lien', exemple: 'https://console.messagingme.app/parametres/credit' },
    },
    textes: {
      fr: {
        sujet: 'Crédit IA bientôt épuisé : il reste {{solde}}',
        corps: 'Bonjour,\n\nLe crédit IA de l’espace {{espace}} passe sous 0,50 € : il reste {{solde}}. Quand il sera à zéro, '
          + 'vos agents IA, dont le répondeur automatique, ne répondront plus, et les messages iront dans « À traiter » de '
          + 'l’Inbox.\n\nRechargez dès maintenant pour qu’ils continuent sans interruption.',
        bouton: { libelle: 'Recharger le crédit IA', lien: '{{lien_credit}}' },
      },
      en: {
        sujet: 'AI credit running low: {{solde}} left',
        corps: 'Hello,\n\nThe AI credit of the {{espace}} workspace has dropped below €0.50: {{solde}} left. When it reaches '
          + 'zero, your AI agents, including the automatic responder, will stop replying, and messages will go to “To do” '
          + 'in the Inbox.\n\nTop up now so they keep going without interruption.',
        bouton: { libelle: 'Top up AI credit', lien: '{{lien_credit}}' },
      },
    },
  },
  {
    cle: 'paiement_refuse_numero',
    categorie: 'service',
    nom: 'Paiement refusé : numéro fourni',
    quand: 'Le paiement du renouvellement du numéro fourni échoue. Une fois par facture.',
    variables: {
      date_coupure: { description: 'Le jour où les envois seront coupés sans paiement', forme: 'date', exemple: '2026-10-21T10:00:00.000Z' },
      lien_numero: LIEN_NUMERO,
    },
    textes: {
      fr: {
        sujet: 'Le paiement de votre numéro WhatsApp a échoué',
        corps: 'Bonjour,\n\nLe paiement du renouvellement du numéro WhatsApp fourni à l’espace {{espace}} a échoué. Notre '
          + 'prestataire de paiement va réessayer dans les prochains jours.\n\nSans paiement, les envois du numéro seront '
          + 'coupés le {{date_coupure}} (réponses de l’Inbox, campagnes, scénarios, agents IA et API). Mettez à jour votre '
          + 'carte depuis la page « Connecter WhatsApp » de la console (« Gérer mon abonnement »), ou demandez-le à Claude.',
        bouton: { libelle: 'Mettre à jour ma carte', lien: '{{lien_numero}}' },
      },
      en: {
        sujet: 'The payment for your WhatsApp number failed',
        corps: 'Hello,\n\nThe renewal payment for the WhatsApp number provided to the {{espace}} workspace failed. Our '
          + 'payment provider will try again over the next few days.\n\nWithout payment, the number’s sends will stop on '
          + '{{date_coupure}} (Inbox replies, campaigns, scenarios, AI agents and API). Update your card from the “Connect '
          + 'WhatsApp” page of the console (“Manage my subscription”), or ask Claude.',
        bouton: { libelle: 'Update my card', lien: '{{lien_numero}}' },
      },
    },
  },
  {
    cle: 'paiement_refuse_pro',
    categorie: 'service',
    nom: 'Paiement refusé : offre Pro',
    quand: 'Le paiement du renouvellement de l’offre Pro échoue. Une fois par facture.',
    variables: {
      lien_offre: { description: 'La page Offre de la console', forme: 'lien', exemple: 'https://console.messagingme.app/offre' },
    },
    textes: {
      fr: {
        sujet: 'Le paiement de votre offre Pro a échoué',
        corps: 'Bonjour,\n\nLe paiement du renouvellement de l’offre Pro de l’espace {{espace}} a échoué. Notre prestataire '
          + 'de paiement va réessayer dans les prochains jours.\n\nSans paiement, l’espace repassera en offre Free, avec '
          + 'ses limites. Mettez à jour votre carte depuis la page « Offre » de la console, ou demandez-le à Claude.',
        bouton: { libelle: 'Mettre à jour ma carte', lien: '{{lien_offre}}' },
      },
      en: {
        sujet: 'The payment for your Pro plan failed',
        corps: 'Hello,\n\nThe renewal payment for the Pro plan of the {{espace}} workspace failed. Our payment provider '
          + 'will try again over the next few days.\n\nWithout payment, the workspace will go back to the Free plan, with '
          + 'its limits. Update your card from the “Plan” page of the console, or ask Claude.',
        bouton: { libelle: 'Update my card', lien: '{{lien_offre}}' },
      },
    },
  },
  {
    cle: 'limite_modeles_80',
    categorie: 'service',
    nom: 'Offre Free : 80 % des modèles du mois',
    quand: 'Un espace Free a envoyé 80 % des modèles de son mois. Une fois par mois.',
    variables: { limite: LIMITE, lien_offre: LIEN_OFFRE },
    textes: {
      fr: {
        sujet: 'Vous avez envoyé 80 % des modèles de votre mois',
        corps: 'Bonjour,\n\nL’espace {{espace}} a envoyé 80 % des {{limite}} modèles WhatsApp que l’offre Free permet ce '
          + 'mois-ci. Au-delà, les envois de modèles seront refusés jusqu’au mois prochain ; les réponses dans les 24 heures '
          + 'qui suivent un message du client restent possibles.\n\nL’offre Pro n’a pas cette limite.',
        bouton: { libelle: 'Voir les offres', lien: '{{lien_offre}}' },
      },
      en: {
        sujet: 'You have sent 80% of this month’s templates',
        corps: 'Hello,\n\nThe {{espace}} workspace has sent 80% of the {{limite}} WhatsApp templates the Free plan allows this '
          + 'month. Beyond that, template sends will be refused until next month; replies within 24 hours of a customer '
          + 'message remain possible.\n\nThe Pro plan has no such limit.',
        bouton: { libelle: 'See plans', lien: '{{lien_offre}}' },
      },
    },
  },
  {
    cle: 'limite_modeles_100',
    categorie: 'service',
    nom: 'Offre Free : modèles du mois épuisés',
    quand: 'Un espace Free a envoyé tous les modèles de son mois. Une fois par mois.',
    variables: { limite: LIMITE, lien_offre: LIEN_OFFRE },
    textes: {
      fr: {
        sujet: 'Limite atteinte : vos modèles WhatsApp ne partent plus ce mois-ci',
        corps: 'Bonjour,\n\nL’espace {{espace}} a envoyé les {{limite}} modèles WhatsApp que l’offre Free permet ce mois-ci : '
          + 'les envois de modèles (campagnes, relances, scénarios) sont refusés jusqu’au mois prochain. Les réponses dans '
          + 'les 24 heures qui suivent un message du client restent possibles.\n\nPassez en Pro pour envoyer sans cette '
          + 'limite, tout de suite.',
        bouton: { libelle: 'Passer en Pro', lien: '{{lien_offre}}' },
      },
      en: {
        sujet: 'Limit reached: your WhatsApp templates no longer go out this month',
        corps: 'Hello,\n\nThe {{espace}} workspace has sent the {{limite}} WhatsApp templates the Free plan allows this month: '
          + 'template sends (campaigns, follow-ups, scenarios) are refused until next month. Replies within 24 hours of a '
          + 'customer message remain possible.\n\nUpgrade to Pro to send without this limit, right away.',
        bouton: { libelle: 'Upgrade to Pro', lien: '{{lien_offre}}' },
      },
    },
  },
  {
    cle: 'limite_contacts_80',
    categorie: 'service',
    nom: 'Offre Free : 80 % des contacts',
    quand: 'Un espace Free atteint 80 % de sa limite de contacts. Une fois à chaque franchissement.',
    variables: { limite: LIMITE, lien_offre: LIEN_OFFRE },
    textes: {
      fr: {
        sujet: 'Vous approchez de votre limite de contacts',
        corps: 'Bonjour,\n\nL’espace {{espace}} a créé 80 % des {{limite}} contacts que l’offre Free permet. Au-delà, il ne '
          + 'sera plus possible d’en créer ni d’en importer. Un contact qui vous écrit le premier n’est jamais refusé ni '
          + 'compté.\n\nL’offre Pro n’a pas cette limite.',
        bouton: { libelle: 'Voir les offres', lien: '{{lien_offre}}' },
      },
      en: {
        sujet: 'You are close to your contact limit',
        corps: 'Hello,\n\nThe {{espace}} workspace has created 80% of the {{limite}} contacts the Free plan allows. Beyond '
          + 'that, creating or importing contacts will no longer be possible. A contact who writes to you first is never '
          + 'refused nor counted.\n\nThe Pro plan has no such limit.',
        bouton: { libelle: 'See plans', lien: '{{lien_offre}}' },
      },
    },
  },
  {
    cle: 'limite_contacts_100',
    categorie: 'service',
    nom: 'Offre Free : limite de contacts atteinte',
    quand: 'Un espace Free atteint sa limite de contacts. Une fois à chaque franchissement.',
    variables: { limite: LIMITE, lien_offre: LIEN_OFFRE },
    textes: {
      fr: {
        sujet: 'Limite atteinte : vous ne pouvez plus créer de contacts',
        corps: 'Bonjour,\n\nL’espace {{espace}} a atteint les {{limite}} contacts que l’offre Free permet : créer ou importer '
          + 'un contact est refusé. Un contact qui vous écrit le premier n’est jamais refusé ni compté.\n\nPassez en Pro '
          + 'pour ne plus avoir de limite de contacts, tout de suite.',
        bouton: { libelle: 'Passer en Pro', lien: '{{lien_offre}}' },
      },
      en: {
        sujet: 'Limit reached: you can no longer create contacts',
        corps: 'Hello,\n\nThe {{espace}} workspace has reached the {{limite}} contacts the Free plan allows: creating or '
          + 'importing a contact is refused. A contact who writes to you first is never refused nor counted.\n\nUpgrade '
          + 'to Pro to have no contact limit, right away.',
        bouton: { libelle: 'Upgrade to Pro', lien: '{{lien_offre}}' },
      },
    },
  },
  {
    cle: 'transfert_equipe',
    categorie: 'transfert',
    nom: 'Une conversation attend l’équipe',
    quand: 'Un agent IA, l’agent de Meta ou un scénario passe la main à l’équipe alors que le contact vient d’écrire.',
    variables: {
      contact: { description: 'Le nom du contact, ou son numéro masqué', forme: 'texte', exemple: 'Camille D.' },
      fin_fenetre: { description: 'La fin de la fenêtre de 24 heures pour répondre librement', forme: 'date_heure', exemple: '2026-10-15T09:30:00.000Z' },
      lien_conversation: { description: 'La conversation dans l’Inbox', forme: 'lien', exemple: 'https://console.messagingme.app/inbox?c=exemple' },
    },
    textes: {
      fr: {
        sujet: 'Une conversation attend votre équipe : {{contact}}',
        corps: 'Bonjour,\n\nLa conversation avec {{contact}} vient d’être confiée à l’équipe de l’espace {{espace}} : le '
          + 'contact attend une réponse.\n\nVous pouvez lui répondre librement jusqu’au {{fin_fenetre}}. Passé ce délai, '
          + 'WhatsApp n’accepte plus qu’un modèle validé.',
        bouton: { libelle: 'Ouvrir la conversation', lien: '{{lien_conversation}}' },
      },
      en: {
        sujet: 'A conversation is waiting for your team: {{contact}}',
        corps: 'Hello,\n\nThe conversation with {{contact}} has just been handed to the {{espace}} workspace team: the contact '
          + 'is waiting for a reply.\n\nYou can reply freely until {{fin_fenetre}}. After that, WhatsApp only accepts an '
          + 'approved template.',
        bouton: { libelle: 'Open the conversation', lien: '{{lien_conversation}}' },
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
