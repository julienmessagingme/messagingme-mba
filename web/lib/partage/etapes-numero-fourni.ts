/**
 * LES ÉTAPES DU NUMÉRO FOURNI, UNE FOIS PAYÉ, ÉCRITES UNE SEULE FOIS (essai réel 99, 2026-10-13). La page du parcours
 * (`web/components/ParcoursNumero.tsx`) les affiche ; les outils MCP de la connexion (`src/mcp/outils-numero.ts`) les
 * font redire par Claude, qui y ajoute le lien et le paiement avant, et « revenir le voir » après. Écrites à part, elles
 * disaient deux choses (la page demandait l'appel). L'ordre et le choix du SMS sont ceux de Julien, qui a fait l'essai.
 */

/** Sans code au bout de ce délai, l'autre méthode de vérification. */
export const SECONDES_SANS_CODE = 45;

export const ETAPES_NUMERO_FOURNI: ReadonlyArray<{ fr: string; en: string }> = [
  {
    fr: 'Cliquez sur « Ouvrir la fenêtre de Meta » et allez jusqu’au bout de la fenêtre.',
    en: 'Click “Open the Meta window” and go all the way through it.',
  },
  {
    fr: 'À l’écran du numéro, choisissez « Enter a new phone number » : le pays GB (+44), puis les chiffres qui suivent +44.',
    en: 'On the phone number screen, choose “Enter a new phone number”: the country GB (+44), then the digits that follow +44.',
  },
  {
    fr: 'Pour la vérification, choisissez « Text message » si Meta vous laisse le choix.',
    en: 'For the verification, choose “Text message” if Meta gives you the choice.',
  },
  {
    fr: 'Le code s’affiche sur la page en quelques secondes : saisissez-le dans la fenêtre de Meta.',
    en: 'The code shows on the page within seconds: enter it in the Meta window.',
  },
  {
    fr: `Pas de code au bout de ${SECONDES_SANS_CODE} secondes : attendez que Meta propose de renvoyer le code, puis essayez `
      + 'l’autre méthode (« Phone call », ou « Text message » si vous n’aviez pas eu le choix).',
    en: `No code after ${SECONDES_SANS_CODE} seconds: wait until Meta offers to send the code again, then try the other `
      + 'method (“Phone call”, or “Text message” if you had no choice).',
  },
  {
    fr: 'Allez jusqu’au dernier écran de Meta, « Finish » : c’est lui qui termine la connexion.',
    en: 'Go to Meta’s last screen, “Finish”: that is what completes the connection.',
  },
];
