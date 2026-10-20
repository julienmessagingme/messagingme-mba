/**
 * LES PAGES « COMMENT FAIRE » DE LA CONSOLE, ÉMISES par `npm run vitrine:aide` depuis les fiches publiques
 * (`docs/aide/fiches/`, champ `comment_faire`). Ne pas éditer à la main : `tests/vitrine-aide.test.ts` compare ce
 * fichier à sa génération. La clé est l’écran de la console (`web/lib/nav.ts`), la valeur la page du centre d’aide.
 */
export const PAGES_COMMENT_FAIRE: Readonly<Record<string, { fr: string; en: string }>> = {
  "offre": { fr: "https://app.messagingme.fr/aide/choisir-mon-offre/", en: "https://app.messagingme.fr/en/help/choose-my-plan/" },
  "accueil": { fr: "https://app.messagingme.fr/aide/connecter-mon-numero-whatsapp/", en: "https://app.messagingme.fr/en/help/connect-my-whatsapp-number/" },
  "inbox": { fr: "https://app.messagingme.fr/aide/repondre-dans-l-inbox/", en: "https://app.messagingme.fr/en/help/reply-in-the-inbox/" },
  "templates": { fr: "https://app.messagingme.fr/aide/faire-approuver-un-modele/", en: "https://app.messagingme.fr/en/help/get-a-template-approved/" },
  "contacts": { fr: "https://app.messagingme.fr/aide/importer-mes-contacts/", en: "https://app.messagingme.fr/en/help/import-my-contacts/" },
  "campagnes": { fr: "https://app.messagingme.fr/aide/lancer-une-campagne/", en: "https://app.messagingme.fr/en/help/launch-a-campaign/" },
};
