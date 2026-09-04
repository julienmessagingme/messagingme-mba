import { randomBytes } from 'node:crypto';

/**
 * Le jeton de declenchement d'un lien de chaine WhatsApp (Channels Me).
 *
 * Une chaine diffuse mais n'ecoute pas. Le pont est un seul appui : le post porte une URL `wa.me` dont le
 * parametre `text=` n'est PAS le libelle du bouton (WhatsApp le dessine lui-meme) mais le message que
 * l'abonne ENVERRA. C'est donc ce texte, et lui seul, qui porte le jeton.
 *
 * Choix de forme, et pourquoi :
 *  - PREFIXE `cm-` : lisible, et il ne peut pas etre confondu avec le prefixe `test-` du jeton de test d'un
 *    scenario (`src/workflow/test-token.ts`), qui vit dans le meme espace de messages entrants.
 *  - suffixe ALEATOIRE de 8 caracteres (40 bits) : le jeton circule dans des messages publics, mais il
 *    demarre un scenario qui pose des tags et envoie des messages factures. Il ne doit pas se deviner.
 *  - alphabet minuscule SANS i, l, o ni u : pas d'ambiguite visuelle si un abonne recopie le texte a la main.
 *  - deja MINUSCULE et sans accent : c'est ce qui le fait survivre a `normalizeText` (src/automation/match.ts),
 *    appliquee des deux cotes de la comparaison, au corps du message ET au mot cle stocke. Un jeton qui n'y
 *    survivrait pas rendrait muets les boutons de tous les posts deja publies, sans lever la moindre erreur.
 *
 * Module PUR cote forme (la generation utilise crypto, aucune IO) -> testable sans base.
 * ⚠️ Le jeton n'est JAMAIS journalise : c'est l'identifiant qui declenche un scenario.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LONGUEUR = 8;

export const PREFIXE_JETON = 'cm-';

/**
 * Jeton neuf : `cm-` + 8 caracteres tires.
 *
 * 256 est un multiple EXACT de 32 (la taille de l'alphabet), donc le modulo ne biaise aucun caractere.
 * Changer l'alphabet sans changer cette propriete reintroduirait un biais silencieux.
 */
export function nouveauJeton(): string {
  let out = '';
  for (const b of randomBytes(LONGUEUR)) out += ALPHABET[b % ALPHABET.length];
  return PREFIXE_JETON + out;
}

const JETON_RE = new RegExp(`^${PREFIXE_JETON}[0-9a-hjkmnp-tv-z]{${LONGUEUR}}$`);

/**
 * Cette chaine est-elle EXACTEMENT un jeton ? Controle de forme sur nos propres jetons (validation d'entree,
 * garde de test), volontairement strict : ancre aux deux bouts, minuscules seulement.
 *
 * ⚠️ Ce n'est PAS le detecteur d'un message entrant. Un abonne peut ecrire devant, derriere, ou laisser son
 * telephone capitaliser : c'est l'automation `keyword` en mode `contains`, sur le corps normalise, qui
 * reconnait le message. `estJeton` sur un corps de message repondrait presque toujours faux.
 */
export function estJeton(v: string): boolean {
  return JETON_RE.test(v);
}

/**
 * Le texte que l'abonne ENVOIE en appuyant sur le bouton : la phrase que le client a choisie, puis le jeton
 * entre parentheses, pour qu'il se lise comme une reference technique anodine.
 *
 * ⚠️ Deux textes a ne jamais confondre : le texte du POST est ce que l'abonne LIT (il contient l'URL), celui
 * ci est ce qu'il ENVOIE (il contient le jeton). Seul le second declenche quoi que ce soit.
 *
 * La phrase est detouree : une phrase collee telle quelle depuis un traitement de texte laisserait sinon une
 * double espace avant la parenthese. Phrase vide -> le jeton seul, plutot qu'un texte commencant par une
 * espace (la route de creation refuse deja la phrase vide, mais cette fonction reste totale).
 */
export function textePreRempli(phrase: string, jeton: string): string {
  const p = phrase.trim();
  return p === '' ? `(${jeton})` : `${p} (${jeton})`;
}
