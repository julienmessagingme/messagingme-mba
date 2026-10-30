/**
 * LES QUESTIONS DU NUMÉRO DANS LA CONSOLE (2026-10-30, plan `docs/superpowers/plans/2026-10-30-tunnel-numero-console-plugin.md`) :
 * celles du tunnel de la vitrine (`scripts/vitrine/tunnel-textes.ts`, l'arbre de Julien), à partir de la deuxième, car
 * l'espace a déjà son offre. `tests/questions-numero-vitrine.test.ts` les tient égales à la vitrine, au mot près, et la
 * skill `mise-en-service` du plugin pose les mêmes. Plus aucune voie par QR code.
 */
type Texte = { readonly fr: string; readonly en: string };

/** Où vérifier qu'on a un compte Meta Business : la console en fait un lien, la vitrine aussi. */
export const META_BUSINESS_URL = 'https://business.facebook.com/';

export const QUESTION_COMPTE = {
  texte: { fr: 'Avez-vous un compte Meta Business ?', en: 'Do you have a Meta Business account?' },
  precision: { fr: 'L’ancien Business Manager : le compte de votre entreprise chez Meta.', en: 'Formerly Business Manager: your business’s account at Meta.' },
  oui: { fr: 'Oui', en: 'Yes' },
  non: { fr: 'Non', en: 'No' },
  nsp: { fr: 'Je ne sais pas', en: 'I don’t know' },
  noteNon: { fr: 'Rien à préparer : la fenêtre de Meta vous le fera créer en chemin.', en: 'Nothing to prepare: Meta’s window will have you create it along the way.' },
  /** La note de « Je ne sais pas », coupée autour du lien vers business.facebook.com. */
  noteNsp: {
    avant: { fr: 'Pour le vérifier : ', en: 'To check: ' },
    apres: {
      fr: '. Si vous faites de la publicité sur Facebook ou Instagram, vous en avez sans doute un. Sinon, la fenêtre de Meta vous le fera créer en chemin.',
      en: '. If you advertise on Facebook or Instagram, you probably have one. Otherwise, Meta’s window will have you create it along the way.',
    },
  },
} as const satisfies Record<string, Texte | Record<string, Texte>>;

export const QUESTION_APPLICATION = {
  texte: { fr: 'Avez-vous déjà l’application WhatsApp Business ?', en: 'Do you already have the WhatsApp Business app?' },
  precision: { fr: 'L’application des professionnels, distincte de WhatsApp.', en: 'The app for businesses, separate from WhatsApp.' },
  oui: { fr: 'Oui', en: 'Yes' },
  non: { fr: 'Non', en: 'No' },
} as const satisfies Record<string, Texte>;

/** Avec un compte Meta Business : le numéro API, et la ligne qui rappelle qu'on peut garder son application. */
export const ISSUE_API = {
  titre: { fr: 'Votre numéro API', en: 'Your API number' },
  garder: { fr: 'Votre numéro est déjà dans l’application WhatsApp Business ?', en: 'Is your number already in the WhatsApp Business app?' },
  lien: { fr: 'Vous pouvez la garder', en: 'You can keep it' },
} as const satisfies Record<string, Texte>;

/**
 * Sans l'application : la télécharger, puis brancher TOUT DE SUITE en la gardant (Julien, 2026-10-30) ; si Meta refuse un
 * numéro trop neuf, revenir quelques jours plus tard. Meta ne publie aucun seuil : aucun nombre de jours.
 */
export const ISSUE_TELECHARGER = {
  titre: { fr: 'Téléchargez l’application WhatsApp Business', en: 'Download the WhatsApp Business app' },
  textes: [
    {
      fr: 'Installez l’application WhatsApp Business sur un téléphone, avec le numéro de votre entreprise, puis branchez-le tout de suite en gardant l’application : votre numéro reste sur votre téléphone et envoie aussi depuis Messaging Me.',
      en: 'Install the WhatsApp Business app on a phone, with your business’s number, then connect it right away while keeping the app: your number stays on your phone and also sends from Messaging Me.',
    },
    {
      fr: 'Meta refuse parfois un numéro trop neuf : servez-vous alors de l’application quelques jours, puis revenez le brancher.',
      en: 'Meta sometimes refuses a number that is too new: then use the app for a few days, and come back to connect it.',
    },
  ],
} as const;

/** La réponse à la question du compte Meta Business. */
export type ReponseCompte = 'oui' | 'non' | 'nsp';
