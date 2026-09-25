import { randomBytes } from 'node:crypto';

/**
 * LE JETON PUBLIC D'UN CONTACT : ce qui permet de savoir QUI a cliqué sur un lien tracé.
 *
 * 🔴 POURQUOI IL EXISTE. Le lien tracé est le MÊME pour tous les destinataires d'un template : au moment du
 * clic, l'information « qui » n'est nulle part dans la requête. Elle doit donc voyager DANS l'URL, et c'est
 * ce jeton qui la porte : `https://base/r/<code>/<jeton>`.
 *
 * 🔴 CE QU'IL N'EST PAS : un secret. Il voyage dans un message que le destinataire peut lire, transférer, ou
 * coller ailleurs. Deux conséquences à assumer plutôt qu'à ignorer :
 *  - un message TRANSFÉRÉ attribue le clic au destinataire d'origine. C'est la limite de tout suivi de lien,
 *    elle n'a pas de solution, et elle est sans gravité : au pire un clic est compté pour la mauvaise
 *    personne, jamais une donnée n'est divulguée ;
 *  - il ne doit donc JAMAIS servir d'authentification. Le connaître ne donne aucun droit : il ne fait que
 *    désigner un contact au moment de compter un clic.
 *
 * ⚠️ Et il ne porte AUCUNE information : ni numéro, ni nom, ni identifiant interne dérivable. C'est du hasard
 * pur. Dériver le jeton du numéro (un hachage, par exemple) le rendrait vérifiable : quelqu'un qui soupçonne
 * un numéro pourrait confirmer qu'il est dans la base en recalculant son jeton.
 */

/**
 * Longueur du jeton, en caractères. 16 caractères d'un alphabet de 30 valent environ 78,5 bits de hasard :
 * assez pour qu'une collision soit impossible en pratique sur des millions de contacts, et assez court pour
 * ne pas gonfler une URL qui voyage dans un SMS de repli quand le RCS n'est pas disponible.
 */
const LONGUEUR = 16;

/**
 * Alphabet SANS `0`, `1`, `l`, `o`, `i` ni `u`.
 *
 * Les cinq premiers parce qu'ils se confondent à la lecture, et qu'un jeton finit parfois recopié à la main
 * dans un ticket de support. Le `u` parce qu'un alphabet sans voyelle ne fabrique pas de mot malheureux au
 * milieu d'une URL envoyée à un client.
 */
const ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';

/**
 * Fabrique un jeton. `randomBytes` et non `Math.random` : ce dernier est prévisible, et un jeton devinable
 * permettrait d'attribuer des clics à des gens qui n'ont rien fait, donc de fausser une mesure.
 *
 * ⚠️ Le modulo introduit un biais de répartition (256 n'est pas un multiple de 30). Il est négligeable ici
 * parce qu'on cherche de l'unicité, pas de l'imprévisibilité cryptographique : ce jeton ne protège rien.
 */
export function fabriquerJeton(): string {
  const octets = randomBytes(LONGUEUR);
  let out = '';
  for (let i = 0; i < LONGUEUR; i += 1) out += ALPHABET[octets[i]! % ALPHABET.length];
  return out;
}

/**
 * La forme d'un jeton, vérifiée AVANT toute requête. Un lien public reçoit des robots et des scans : il n'y a
 * aucune raison de leur offrir un aller-retour en base par essai. Même doctrine que `CODE_RE` du redirecteur.
 */
export const JETON_RE = new RegExp(`^[${ALPHABET}]{${LONGUEUR}}$`);

export function estJeton(v: unknown): v is string {
  return typeof v === 'string' && JETON_RE.test(v);
}
