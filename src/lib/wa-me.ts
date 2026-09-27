/**
 * Le lien wa.me pré-rempli, écrit une fois.
 *
 * `https://wa.me/<chiffres>?text=<texte encodé>` ouvre WhatsApp sur une conversation avec notre numéro, le
 * message déjà saisi : c'est la personne qui écrit la première, ce qui ouvre la fenêtre de service de 24 h sans
 * template. Deux surfaces le fabriquent : le lien de test d'un scénario (le texte est un jeton) et le bouton
 * d'un post de chaîne (le texte est la phrase du lien, qui sert de mot-clé). Une URL publiée dans un post ne
 * se corrige plus : une seconde copie de la règle qui divergerait enverrait des abonnés sur un lien mort.
 *
 * Deux pièges : le numéro arrive tel que Meta l'affiche (« +33 5 25 68 02 50 ») et wa.me n'accepte que des
 * chiffres ; le texte doit être encodé, sinon il est tronqué au premier espace et le scénario ne démarre pas.
 */

/**
 * Lien wa.me vers `displayPhoneNumber`, avec `texte` déjà saisi. null si le numéro ne porte aucun chiffre : on
 * ne fabrique pas un lien cassé, l'écran n'affiche rien.
 */
export function lienWaMe(displayPhoneNumber: string | null, texte: string): string | null {
  const chiffres = (displayPhoneNumber ?? '').replace(/\D/g, '');
  if (chiffres === '') return null;
  return `https://wa.me/${chiffres}?text=${encodeTexteWaMe(texte)}`;
}

/**
 * L'encodage du paramètre `text`, plus strict que `encodeURIComponent`, qui laisse `!'()*` tels quels.
 * L'auto-détection de liens de WhatsApp exclut une ponctuation finale de l'adresse ouverte : « promo! »
 * arrivait sans son « ! », le message devenait plus court que le mot-clé (mode `contains`) et le scénario ne
 * partait pas. Les posts déjà distribués sont rattrapés côté mot-clé (`motCleDepuisPhrase`).
 */
export function encodeTexteWaMe(texte: string): string {
  return encodeURIComponent(texte).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
