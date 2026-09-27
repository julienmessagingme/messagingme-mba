import { chaineAleatoire } from '../lib/jeton-aleatoire';

/**
 * Le jeton de déclenchement d'un lien de chaîne WhatsApp (Channels Me) : le post porte une URL `wa.me` dont
 * le paramètre `text=` est le message que l'abonné enverra.
 *
 * Forme :
 *  - préfixe `cm-`, distinct du `test-` du jeton de test d'un scénario, qui vit dans le même espace ;
 *  - suffixe aléatoire de 8 caractères (40 bits) : il démarre un scénario qui envoie des messages facturés,
 *    il ne doit pas se deviner ;
 *  - alphabet minuscule sans i, l, o ni u (aucune ambiguïté à la recopie) et sans accent : il survit à
 *    `normalizeText`, appliquée des deux côtés de la comparaison, sans quoi les boutons des posts publiés
 *    deviendraient muets.
 *
 * Le jeton n'est jamais journalisé : c'est l'identifiant qui déclenche un scénario.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LONGUEUR = 8;

export const PREFIXE_JETON = 'cm-';

/**
 * Jeton neuf : `cm-` + 8 caractères tirés par `chaineAleatoire`. L'alphabet fait 32 caractères, diviseur de
 * 256 : le modulo ne biaise aucun caractère, propriété à préserver si l'alphabet change.
 */
export function nouveauJeton(): string {
  return PREFIXE_JETON + chaineAleatoire(LONGUEUR, ALPHABET);
}

/**
 * La forme d'un jeton, sans ancrage. Exportée parce que `PgChannelsMeLinkStore` écarte en SQL les messages
 * qui portent un jeton (des clics, pas de la conversation) : une copie du motif divergerait au premier
 * changement d'alphabet. Compatible avec les expressions régulières de Postgres comme de JavaScript.
 */
export const MOTIF_JETON = `${PREFIXE_JETON}[0-9a-hjkmnp-tv-z]{${LONGUEUR}}`;

/**
 * Le texte que l'abonné envoie en appuyant sur le bouton : la phrase choisie par le client, et rien d'autre
 * (le jeton allongeait l'URL `wa.me` ; un raccourcisseur tiers aurait perdu le domaine `wa.me`, qui fait
 * dessiner le bouton « Discuter »).
 *
 * C'est la phrase qui route, mot-clé de l'automation compagnon en mode `contains` : un post déjà publié
 * envoie `phrase (cm-xxxx)`, qui contient la phrase, et son bouton continue de déclencher. Le texte du post
 * est ce que l'abonné lit ; celui-ci est ce qu'il envoie, seul à déclencher quoi que ce soit.
 */
export function textePreRempli(phrase: string): string {
  return phrase.trim();
}

/**
 * Le mot-clé de l'automation compagnon : la phrase, privée de sa ponctuation finale. L'auto-détection de
 * liens de WhatsApp exclut une ponctuation finale de l'adresse ouverte : les posts déjà publiés envoient le
 * message amputé (« promo » pour « promo! »), plus court que le mot-clé, donc sans correspondance en
 * `contains`. `encodeTexteWaMe` corrige les adresses à venir ; ceci répare les posts déjà distribués.
 *
 * Seule la ponctuation de fin part, celle du milieu est du texte. Une phrase faite de ponctuation rend une
 * chaîne vide, que `keywordsOf` écarte : un mot-clé vide ne déclenche jamais.
 */
export function motCleDepuisPhrase(phrase: string): string {
  return phrase.trim().replace(/[!.,;:?)\]"'*»]+$/u, '').trim();
}
