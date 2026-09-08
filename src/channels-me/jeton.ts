import { chaineAleatoire } from '../lib/jeton-aleatoire';

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
 * Jeton neuf : `cm-` + 8 caracteres tires (`chaineAleatoire`, `src/lib/jeton-aleatoire.ts`).
 *
 * 256 est un multiple EXACT de 32 (la taille de l'alphabet), donc le modulo de `chaineAleatoire` ne biaise
 * aucun caractere. Changer l'alphabet sans changer cette propriete reintroduirait un biais silencieux.
 */
export function nouveauJeton(): string {
  return PREFIXE_JETON + chaineAleatoire(LONGUEUR, ALPHABET);
}

/**
 * La FORME d'un jeton, sans ancrage : `cm-` suivi de huit caracteres de l'alphabet.
 *
 * 🔴 EXPORTEE PARCE QU'ELLE EST LUE AILLEURS QU'ICI. `PgChannelsMeLinkStore` doit ecarter, en SQL, les
 * messages qui portent un jeton (ce sont des CLICS, pas de la conversation ordinaire). Recopier le motif
 * la-bas en aurait fait une seconde definition de « un jeton » : changer l'alphabet ou la longueur ici
 * aurait laisse l'autre en arriere, sans erreur, et la mesure de banalite se serait mise a compter les
 * clics contre le lien. C'est la doctrine des fragments partages du depot.
 *
 * ⚠️ Compatible avec la syntaxe des expressions regulieres de Postgres comme avec celle de JavaScript : ni
 * classe nommee, ni echappement propre a l'un des deux.
 */
export const MOTIF_JETON = `${PREFIXE_JETON}[0-9a-hjkmnp-tv-z]{${LONGUEUR}}`;

const JETON_RE = new RegExp(`^${MOTIF_JETON}$`);

/**
 * Cette chaine est-elle EXACTEMENT un jeton ? Controle de forme sur nos propres jetons (validation d'entree,
 * garde de test), volontairement strict : ancre aux deux bouts, minuscules seulement.
 *
 * ⚠️ Ce n'est PAS le detecteur d'un message entrant. Un abonne peut ecrire devant, derriere, ou laisser son
 * telephone capitaliser : c'est l'automation `keyword` en mode `contains`, sur le corps normalise, qui
 * reconnait le message. `estJetonChaine` sur un corps de message repondrait presque toujours faux.
 *
 * Nommee `estJetonChaine` (et non `estJeton`) pour ne pas se confondre avec `estJeton` de
 * `src/links/jeton-contact.ts`, qui controle la forme d'un tout autre jeton (celui du suivi de clic) :
 * meme nom, deux features sans rapport, avant ce renommage du 2026-09-04.
 */
export function estJetonChaine(v: string): boolean {
  return JETON_RE.test(v);
}

/**
 * Le texte que l'abonne ENVOIE en appuyant sur le bouton : la phrase choisie par le client, et RIEN D'AUTRE.
 *
 * 🔴 LE JETON N'Y EST PLUS (2026-09-07, demande de Julien : « on garde juste le message »). Le texte etait
 * `phrase (cm-ab12cd34)`, et c'est ce suffixe qui allongeait l'URL `wa.me`, dont le parametre `text=` porte
 * tout le message. Le retirer EST le raccourcissement demande, et c'est le seul qui preserve le domaine
 * `wa.me` : c'est lui que WhatsApp reconnait pour dessiner le bouton « Discuter ». Un raccourcisseur tiers
 * l'aurait fait disparaitre.
 *
 * 🔴 CE QUI ROUTE DESORMAIS EST LA PHRASE ELLE-MEME, mot-cle de l'automation compagnon, en mode `contains`.
 * C'est ce mode qui rend le changement possible sans casser l'existant : un post DEJA PUBLIE envoie
 * `phrase (cm-xxxx)`, qui CONTIENT la phrase, donc son bouton continue de declencher. Un post distribue ne
 * se rattrape pas ; sans cette propriete, ce lot n'aurait pas pu etre fait.
 *
 * ⚠️ Deux textes a ne jamais confondre : le texte du POST est ce que l'abonne LIT (il contient l'URL),
 * celui-ci est ce qu'il ENVOIE. Seul le second declenche quoi que ce soit.
 *
 * La phrase est detouree, et la fonction reste TOTALE : phrase vide -> chaine vide (la route de creation
 * refuse deja la phrase vide, cette fonction n'a pas a en juger).
 */
export function textePreRempli(phrase: string): string {
  return phrase.trim();
}

/**
 * Le MOT-CLE de l'automation compagnon : la phrase, privee de sa ponctuation FINALE.
 *
 * 🔴 CE N'EST PAS UN CONFORT, C'EST LE RATTRAPAGE DES POSTS DEJA DISTRIBUES. Le 2026-09-08, un bouton dont
 * la phrase etait « je veux mon de code promo! » n'a demarre aucun scenario : le message REÇU etait
 * « je veux mon de code promo », sans le point d'exclamation. L'auto-detection de liens de WhatsApp exclut
 * une ponctuation finale de l'adresse qu'elle ouvre, donc ce caractere ne partait jamais. En mode
 * `contains`, un message plus COURT que le mot-cle ne correspond a rien.
 *
 * `encodeTexteWaMe` corrige les adresses A VENIR. Mais les posts deja publies portent l'ancienne adresse et
 * ne sont plus modifiables : eux enverront toujours le message ampute. Retirer la ponctuation finale du
 * MOT-CLE fait correspondre les DEUX formes, et c'est la seule moitie du remede qui les repare.
 *
 *   phrase stockee : « je veux mon de code promo! »   (inchangee : c'est ce que le client a ecrit et ce que
 *                                                      l'abonne enverra)
 *   mot-cle        : « je veux mon de code promo »    (ce qui declenche, en mode `contains`)
 *
 * ⚠️ Seule la ponctuation de FIN part. Celle du milieu est du texte (« -20%, c'est maintenant »), et la
 * retirer changerait le sens de la correspondance.
 *
 * ⚠️ Une phrase entierement faite de ponctuation rend la chaine vide. La route de creation refuse deja une
 * phrase dont la forme normalisee est vide, et `keywordsOf` ecarte un mot-cle vide : une automation au
 * mot-cle vide ne declenche JAMAIS, elle ne declenche pas sur tout.
 */
export function motCleDepuisPhrase(phrase: string): string {
  return phrase.trim().replace(/[!.,;:?)\]"'*»]+$/u, '').trim();
}
