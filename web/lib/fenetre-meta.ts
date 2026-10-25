/**
 * LA FENÊTRE DE META (Embedded Signup v4) : ce que `useConnexionNumero` passe à `FB.login`, et ce que la console dit avant
 * de l'ouvrir en coexistence. Sorti de la connexion pour être testé : le parcours d'aujourd'hui ne bouge pas d'un
 * caractère.
 *
 * LA COEXISTENCE (plan `docs/superpowers/plans/2026-10-24-coexistence.md`, tâche 3) : le numéro reste dans l'application
 * WhatsApp Business et passe aussi sur l'API Cloud. Meta l'ouvre par `featureType: 'whatsapp_business_app_onboarding'`
 * (l'ancienne valeur `coexistence` est refusée depuis le 2025-05-29) et `sessionInfoVersion: '3'` ; la fin s'annonce par
 * l'événement `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, que le serveur lit pour ne jamais appeler `/register`. Si Meta
 * refusait la v4 à l'essai réel, la v5 s'essaie ici, sur cette seule branche (`extras: { version: 'v5' }`).
 */
export type OptionsFenetreMeta = {
  config_id: string;
  response_type: 'code';
  override_default_response_type: true;
  extras: Record<string, unknown>;
};

export function optionsFenetreMeta(configId: string, coexistence: boolean): OptionsFenetreMeta {
  return {
    config_id: configId,
    response_type: 'code',
    override_default_response_type: true,
    extras: coexistence
      ? { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }
      : { setup: {} },
  };
}

/** Le bouton qui ouvre la fenêtre de Meta en coexistence, sur l'Accueil et sur la page du numéro. */
export const COEXISTENCE_BOUTON = { fr: 'Garder mon application WhatsApp Business', en: 'Keep my WhatsApp Business app' } as const;

/**
 * Ce que la console dit sous ce bouton, au moment du choix : ce que l'application garde et perd, ce que Meta facture, et
 * le compte Meta Business que la fenêtre crée en chemin (nous sommes Tech Provider : Meta demande ensuite un moyen de
 * paiement sur le compte WhatsApp avant le premier modèle). 🔴 Rien de « gratuit » pour ce qui part par Messaging Me.
 */
export const COEXISTENCE_PHRASES: ReadonlyArray<{ fr: string; en: string }> = [
  {
    fr: 'Votre numéro reste dans l’application, où les messages que vous tapez restent gratuits ; ceux qui partent par '
      + 'Messaging Me sont facturés par Meta. L’application perd ses listes de diffusion, son catalogue, ses messages '
      + 'd’absence et ses étiquettes, et ses appareils liés sont déliés.',
    en: 'Your number stays in the app, where the messages you type stay free; those sent through Messaging Me are billed by '
      + 'Meta. The app loses its broadcast lists, catalogue, away messages and labels, and its linked devices are unlinked.',
  },
  {
    fr: 'Pas encore de compte Meta Business ? La fenêtre de Meta le crée en chemin, avec votre profil Facebook. Avant le '
      + 'premier modèle, Meta vous demandera un moyen de paiement sur votre compte WhatsApp.',
    en: 'No Meta Business account yet? Meta\'s window creates one on the way, with your Facebook profile. Before the first '
      + 'template, Meta will ask for a payment method on your WhatsApp account.',
  },
];
