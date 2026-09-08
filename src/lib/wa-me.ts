/**
 * LE LIEN wa.me PRÉ-REMPLI, ÉCRIT UNE FOIS.
 *
 * `https://wa.me/<chiffres>?text=<texte encodé>` ouvre WhatsApp sur une conversation avec NOTRE numéro, le
 * message déjà saisi : la personne n'a plus qu'à appuyer sur Envoyer. C'est donc elle qui écrit la première,
 * ce qui ouvre la fenêtre de service de 24 h et dispense de tout template approuvé.
 *
 * Deux surfaces le fabriquent, et c'est pour cela que la règle sort de son premier appelant :
 *  - le lien de TEST d'un scénario (`waMeTestLink`, src/workflow/test-token.ts), où le texte est un jeton ;
 *  - le bouton d'un post de chaîne WhatsApp (Channels Me), où le texte est la PHRASE du lien, et rien
 *    d'autre. ⚠️ Elle était suivie du jeton jusqu'au 2026-09-07 ; c'est ce suffixe qui allongeait l'URL, et
 *    c'est la phrase qui route désormais. Là, l'URL part dans un post PUBLIÉ : une seconde copie de la règle
 *    qui divergerait enverrait des abonnés sur un lien mort, sans recours possible, le post étant déjà
 *    distribué.
 *
 * Deux pièges portés ici, et nulle part ailleurs :
 *  1. le numéro arrive tel que Meta l'AFFICHE (« +33 5 25 68 02 50 ») ; wa.me n'accepte que des chiffres,
 *     donc tout le reste est retiré ;
 *  2. le texte est un MESSAGE, pas une étiquette : il contient des espaces et des accents, et sans encodage
 *     il serait tronqué au premier espace, ce qui couperait la phrase et empêcherait le scénario de
 *     démarrer, la phrase étant devenue le mot-clé.
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
  return `https://wa.me/${chiffres}?text=${encodeTexteWaMe(texte)}`;
}

/**
 * L'encodage du paramètre `text`, plus strict que `encodeURIComponent`.
 *
 * 🔴 MESURÉ LE 2026-09-08, SUR UN BOUTON QUI NE DÉMARRAIT AUCUN SCÉNARIO. La phrase du lien était
 * « je veux mon de code promo! » ; le message REÇU était « je veux mon de code promo », sans le point
 * d'exclamation. La correspondance étant en mode `contains`, un message plus COURT que le mot-clé ne
 * correspond à rien, et le scénario ne partait jamais.
 *
 * La cause : `encodeURIComponent` laisse `!`, `'`, `(`, `)` et `*` TELS QUELS (ce sont des sous-délimiteurs
 * licites dans une URL). L'adresse finissait donc par `...promo!`, et l'auto-détection de liens de WhatsApp
 * traite une ponctuation finale comme la ponctuation de la PHRASE, pas comme une partie du lien : elle
 * l'exclut de ce qui est ouvert. Le `!` ne partait donc jamais dans le message.
 *
 * ⚠️ Ce n'est pas réparable en aval : ces adresses vivent dans des posts DÉJÀ DISTRIBUÉS. D'où la seconde
 * moitié du remède, côté mot-clé (`motCleDepuisPhrase`, src/channels-me/jeton.ts), qui rattrape ceux-là.
 */
export function encodeTexteWaMe(texte: string): string {
  return encodeURIComponent(texte).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
