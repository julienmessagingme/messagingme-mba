/**
 * LES ÉTAPES DE LA FILIÈRE APPLICATION WHATSAPP BUSINESS, ÉCRITES UNE SEULE FOIS (2026-10-22). La page du lien
 * (`/brancher`) les affiche à côté du QR code ; les outils MCP de la connexion (`src/mcp/outils-numero.ts`) les font
 * redire par Claude. Le chemin des menus est celui de l'essai du 2026-10-21 (Android, WhatsApp Business).
 */

/** Avant le QR code, pour un numéro fourni : créer le compte de l'application avec ce numéro. */
export const ETAPES_COMPTE_FOURNI: ReadonlyArray<{ fr: string; en: string }> = [
  {
    fr: 'Sur un téléphone, installez l’application WhatsApp Business et créez le compte avec ce numéro.',
    en: 'On a phone, install the WhatsApp Business app and create the account with this number.',
  },
  {
    fr: 'Pour la vérification, choisissez l’appel : le code s’affiche sur la page en quelques secondes, saisissez-le dans l’application.',
    en: 'For the verification, choose the phone call: the code shows on the page within seconds, enter it in the app.',
  },
];

/** Relier le compte : le QR code de la page, scanné depuis le téléphone. */
export const ETAPES_RELIER_APPLICATION: ReadonlyArray<{ fr: string; en: string }> = [
  {
    fr: 'Sur le téléphone, dans WhatsApp Business : Paramètres, puis Appareils connectés, puis Connecter un appareil.',
    en: 'On the phone, in WhatsApp Business: Settings, then Linked devices, then Link a device.',
  },
  {
    fr: 'Scannez le QR code de la page. Il se renouvelle tout seul ; s’il a expiré, cliquez sur « Nouveau QR code ».',
    en: 'Scan the QR code on the page. It renews by itself; if it has expired, click “New QR code”.',
  },
  {
    fr: 'Le téléphone reste le vôtre : vous pouvez toujours y répondre, et une réponse tapée sur le téléphone fait se retirer l’agent IA de la conversation.',
    en: 'The phone stays yours: you can still reply on it, and a reply typed on the phone makes the AI agent step out of the conversation.',
  },
];
