/**
 * LE LIEN wa.me PRÉ-REMPLI, ÉCRIT UNE FOIS.
 *
 * `https://wa.me/<chiffres>?text=<texte encodé>` ouvre WhatsApp sur une conversation avec NOTRE numéro, le
 * message déjà saisi : la personne n'a plus qu'à appuyer sur Envoyer. C'est donc elle qui écrit la première,
 * ce qui ouvre la fenêtre de service de 24 h et dispense de tout template approuvé.
 *
 * Deux surfaces le fabriquent, et c'est pour cela que la règle sort de son premier appelant :
 *  - le lien de TEST d'un scénario (`waMeTestLink`, src/workflow/test-token.ts), où le texte est un jeton ;
 *  - le bouton d'un post de chaîne WhatsApp (Channels Me), où le texte est une phrase lisible suivie du
 *    jeton du lien. Là, l'URL part dans un post PUBLIÉ : une seconde copie de la règle qui divergerait
 *    enverrait des abonnés sur un lien mort, sans recours possible, le post étant déjà distribué.
 *
 * Deux pièges portés ici, et nulle part ailleurs :
 *  1. le numéro arrive tel que Meta l'AFFICHE (« +33 5 25 68 02 50 ») ; wa.me n'accepte que des chiffres,
 *     donc tout le reste est retiré ;
 *  2. le texte est un MESSAGE, pas une étiquette : il contient des espaces et des accents, et sans encodage
 *     il serait tronqué au premier espace, ce qui coupe le jeton et empêche le scénario de démarrer.
 *
 * Module PUR : aucune IO, aucune configuration lue, testable sans base.
 */

/**
 * Lien wa.me vers `displayPhoneNumber`, avec `texte` déjà saisi.
 *
 * null si le numéro est absent, vide, ou ne porte aucun chiffre : on ne fabrique pas un lien cassé, l'écran
 * appelant n'affiche simplement rien.
 */
export function lienWaMe(displayPhoneNumber: string | null, texte: string): string | null {
  const chiffres = (displayPhoneNumber ?? '').replace(/\D/g, '');
  if (chiffres === '') return null;
  return `https://wa.me/${chiffres}?text=${encodeURIComponent(texte)}`;
}
