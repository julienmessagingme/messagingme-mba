/**
 * CE QU'IL FAUT CHEZ META, ÉCRIT UNE SEULE FOIS (le guide « compte Meta », décision de Julien du 2026-10-13). La page
 * « Connecter WhatsApp » (`ParcoursNumero`), le bandeau de l'Accueil et les outils MCP (`start_whatsapp_connection`,
 * `get_setup_state`) lisent ces textes : la console et Claude ne peuvent pas dire deux choses différentes.
 *
 * Sources relues le 2026-10-13 : la doc Embedded Signup de Meta (connexion par des identifiants Facebook ou Meta
 * Business, portefeuille et compte WhatsApp créables dans la fenêtre, numéro hors de l'application WhatsApp), l'aide
 * « Créer un portefeuille business » (1710077379203657) et « Ajouter une carte de crédit à votre compte sur la
 * plateforme WhatsApp Business » (488291839463771). Les libellés entre guillemets sont ceux des écrans de Meta.
 */

/** Avant de connecter un numéro. */
export const PREREQUIS_META: ReadonlyArray<{ fr: string; en: string }> = [
  {
    fr: 'Un compte Meta Business, c’est-à-dire un portefeuille d’entreprise (l’ancien Business Manager) : c’est lui qui '
      + 'portera votre compte WhatsApp, votre numéro et votre carte. Vous y entrez avec votre profil Facebook, ou avec '
      + 'un compte Meta géré par votre organisation.',
    en: 'A Meta Business account, that is a business portfolio (formerly Business Manager): it will hold your WhatsApp '
      + 'account, your number and your card. You sign in with your Facebook profile, or with a managed Meta account from '
      + 'your organization.',
  },
  {
    // Mesuré à l'essai 161 (2026-10-25) : la fenêtre de Meta fait créer le portefeuille en chemin (« Créez un
    // portefeuille business » : nom, e-mail, pays, site), puis propose « Ajouter un moyen de paiement ».
    fr: 'Pas encore de portefeuille ? Rien à préparer : la fenêtre de Meta vous le fait créer en chemin, avec votre '
      + 'profil Facebook (le nom de votre entreprise, une adresse e-mail, le pays et le site), puis vous propose un moyen '
      + 'de paiement. Vous pouvez aussi le créer avant, sur business.facebook.com : ouvrez le menu sous « Accueil » en '
      + 'haut à gauche, puis créez un portefeuille business.',
    en: 'No portfolio yet? Nothing to prepare: Meta’s window has you create it along the way, with your Facebook profile '
      + '(your business name, an email address, the country and the website), then offers a payment method. You can '
      + 'also create it beforehand on business.facebook.com: open the menu under “Home” at the top left, then create a '
      + 'business portfolio.',
  },
  {
    fr: 'Un numéro qui ne sert pas dans l’application WhatsApp (ni WhatsApp Business) : une fois relié, il la quitte. '
      + 'Pas de numéro libre ? Nous vous en fournissons un.',
    en: 'A number that is not used in the WhatsApp app (nor WhatsApp Business): once connected, it leaves the app. No '
      + 'spare number? We provide one.',
  },
];

/** Après la connexion : la carte chez Meta, sans laquelle les modèles ne partent pas. */
export const ETAPES_CARTE_META: ReadonlyArray<{ fr: string; en: string }> = [
  {
    fr: 'Sur business.facebook.com, ouvrez le Gestionnaire WhatsApp, page « Vue d’ensemble ».',
    en: 'On business.facebook.com, open WhatsApp Manager, “Overview” page.',
  },
  {
    fr: 'Sur votre compte WhatsApp, cliquez sur les trois points, puis sur « Gérer les paramètres du compte ».',
    en: 'On your WhatsApp account, click the three dots, then “Manage account settings”.',
  },
  {
    fr: 'Dans l’onglet « Paramètres », ouvrez « Paramètres de paiement », puis « Ajouter un moyen de paiement ».',
    en: 'In the “Settings” tab, open “Payment settings”, then “Add payment method”.',
  },
  {
    fr: 'Saisissez une carte Visa ou Mastercard (Meta n’accepte ni American Express ni PayPal), puis les informations de '
      + 'votre entreprise ; Meta peut demander vos informations fiscales.',
    en: 'Enter a Visa or Mastercard card (Meta accepts neither American Express nor PayPal), then your business '
      + 'details; Meta may ask for your tax information.',
  },
  {
    fr: 'Il faut être propriétaire du compte WhatsApp, ou avoir le droit « Gérer le compte WhatsApp ». Sans carte '
      + 'valable, seules les réponses dans la fenêtre de 24 h partent : les modèles (campagnes, relances) sont bloqués.',
    en: 'You must own the WhatsApp account, or have the “Manage WhatsApp account” permission. Without a valid card, only '
      + 'replies within the 24-hour window go out: templates (campaigns, follow-ups) are blocked.',
  },
];
