import { randomBytes } from 'node:crypto';

/**
 * Le jeton public d'un contact : ce qui permet de savoir qui a cliqué sur un lien tracé.
 *
 * Le lien tracé est le même pour tous les destinataires d'un template : le « qui » doit donc voyager dans
 * l'URL (`https://base/r/<code>/<jeton>`).
 *
 * Ce n'est pas un secret : il voyage dans un message lisible et transférable (un message transféré attribue le
 * clic au destinataire d'origine). Il ne doit jamais servir d'authentification.
 * C'est du hasard pur : dérivé du numéro (un hachage), il permettrait de confirmer qu'un numéro est en base.
 */

/**
 * 16 caractères d'un alphabet de 30, environ 78,5 bits : aucune collision en pratique, et une URL assez courte
 * pour le SMS de repli.
 */
const LONGUEUR = 16;

/**
 * Sans `0`, `1`, `l`, `o`, `i` (confusion à la lecture, un jeton finit parfois recopié dans un ticket) ni `u`
 * (sans voyelle, pas de mot malheureux au milieu d'une URL).
 */
const ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';

/**
 * `randomBytes` et non `Math.random`, prévisible : un jeton devinable permettrait de fausser la mesure.
 * Le biais du modulo (256 n'est pas multiple de 30) est négligeable : on cherche l'unicité, ce jeton ne
 * protège rien.
 */
export function fabriquerJeton(): string {
  const octets = randomBytes(LONGUEUR);
  let out = '';
  for (let i = 0; i < LONGUEUR; i += 1) out += ALPHABET[octets[i]! % ALPHABET.length];
  return out;
}

/**
 * La forme d'un jeton, vérifiée avant toute requête : un lien public reçoit robots et scans, inutile de leur
 * offrir un aller-retour en base. Même doctrine que `CODE_RE` du redirecteur.
 */
export const JETON_RE = new RegExp(`^[${ALPHABET}]{${LONGUEUR}}$`);

export function estJeton(v: unknown): v is string {
  return typeof v === 'string' && JETON_RE.test(v);
}
