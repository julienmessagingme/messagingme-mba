import { chaineAleatoire } from '../lib/jeton-aleatoire';
import { lienWaMe } from '../lib/wa-me';

/**
 * Jeton de TEST d'un scénario (Lot F) : le mot que le testeur envoie sur WhatsApp pour déclencher un scénario
 * depuis son propre téléphone, sans campagne et sans attendre qu'un vrai client écrive.
 *
 * Il est pré-rempli dans un lien `wa.me/<numéro>?text=<jeton>` (et son QR) : WhatsApp ouvre la conversation
 * avec le texte déjà saisi, l'utilisateur n'a plus qu'à appuyer sur Envoyer. C'est lui qui ouvre donc la
 * fenêtre de service 24 h, ce qui rend le test légitime même pour un scénario qui commence par un message de
 * session (message rapide / formulaire).
 *
 * Choix de forme, et pourquoi :
 *  - PRÉFIXE lisible `test-` : le testeur voit ce qu'il envoie, et un vrai client n'écrit jamais ça par hasard.
 *  - suffixe ALÉATOIRE : le jeton ne doit pas être devinable, sinon n'importe qui pourrait déclencher le
 *    scénario d'un client (il pose des tags, remplit des champs, envoie des messages facturés).
 *  - alphabet Crockford SANS I/L/O/U : pas d'ambiguïté visuelle si quelqu'un le recopie à la main.
 *
 * Module PUR côté forme (la génération utilise crypto, aucune IO) -> testable sans base.
 */

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const PREFIX = 'test-';
const RANDOM_LEN = 8;

/**
 * Jeton neuf : `test-` + 8 caractères aléatoires (40 bits, impossible à deviner par force brute utile).
 * Tirage partagé avec `nouveauJeton` (`src/channels-me/jeton.ts`) via `chaineAleatoire`
 * (`src/lib/jeton-aleatoire.ts`) : même alphabet, même méthode, seul le préfixe diffère.
 */
export function newTestToken(): string {
  return PREFIX + chaineAleatoire(RANDOM_LEN, CROCKFORD);
}

/**
 * Longueur maximale du suffixe qui désigne un BLOC. Un identifiant de bloc est un `crypto.randomUUID()`, donc
 * 36 caractères ; 64 laisse de la marge sans ouvrir la porte à un corps de message arbitraire.
 */
const NODE_MAX = 64;

/**
 * Forme attendue d'un jeton, avec un suffixe de BLOC facultatif (2026-09-16). Sert à éviter d'interroger la
 * base pour chaque message entrant : seuls les messages qui RESSEMBLENT à un jeton déclenchent une
 * résolution. C'est le filtre du chemin chaud.
 *
 * 🔴 CE QUI DISCRIMINE EST LA PARTIE GAUCHE, PAS LE SUFFIXE. `test-` suivi de 8 caractères Crockford est ce
 * qu'un message de client n'écrit jamais par hasard ; le suffixe ne décide que du sort d'un texte qui est
 * DÉJÀ un jeton. L'ouvrir ne coûte donc aucune requête de plus, et le refermer trop fort coûterait des blocs
 * intestables en silence. Il reste borné (`NODE_MAX`) et NON VIDE : un point suivi de rien est refusé.
 *
 * 🔴 L'IDENTIFIANT ENTIER, ET C'EST UN CHANGEMENT PAR RAPPORT AU PREMIER JET DU PLAN. Il proposait un préfixe
 * de huit caractères, plus court dans le lien. Mais le navigateur aurait dû RETIRER les tirets de l'UUID pour
 * fabriquer le suffixe, et le serveur comparer sur la même normalisation : un invariant partagé de part et
 * d'autre d'une frontière que ce dépôt interdit justement de franchir (aucun fichier de `web/` n'importe
 * `src/`), donc recopié à la main des deux côtés, donc voué à diverger sans qu'aucun test ne le voie.
 * L'identifiant entier supprime la question : la comparaison devient une ÉGALITÉ, et le cas « deux blocs
 * correspondent » n'existe plus. Le lien est plus long, mais il est pré-rempli.
 *
 * ⚠️ LA CLASSE DU SUFFIXE EST MESURÉE, pas devinée : les 64 blocs de production portent tous un UUID
 * minuscule (2026-09-16). Elle accepte en plus la forme de repli de `uid()`
 * (`web/components/WorkflowBuilder.tsx`, `id-<base36>-<horodatage>`), qui sort quand `crypto.randomUUID`
 * n'existe pas. La borner à la FORME d'un UUID rendrait ces blocs intestables SANS erreur : le message
 * partirait comme un message ordinaire.
 */
const TOKEN_RE = new RegExp(`^${PREFIX}[0-9a-hjkmnp-tv-z]{${RANDOM_LEN}}(\\.[0-9a-z_-]{1,${NODE_MAX}})?$`);

/**
 * Le jeton et le BLOC qu'il désigne, ou `null` si ce n'en est pas un. C'EST LE FILTRE DU CHEMIN CHAUD :
 * `null` veut dire « message ordinaire », et le webhook passe au suivant sans rien coûter.
 *
 * ⚠️ UNE SEULE FONCTION POUR FILTRER ET POUR LIRE. Il y avait un prédicat `looksLikeTestToken` à côté,
 * retiré le 2026-09-16 : deux portes sur la même forme divergent, et la divergence serait MUETTE dans le
 * sens le plus coûteux (le filtre accepte, la lecture rend `null`, le message est consommé, rien ne démarre).
 * Lecture sur le texte NORMALISÉ :
 * WhatsApp peut ajouter des espaces, et un téléphone peut capitaliser la première lettre automatiquement.
 *
 * Volontairement STRICT (message entier, pas « contient ») : un client qui écrirait « je teste test-abc » ne
 * doit pas déclencher un test, et une phrase ne doit jamais être confondue avec un jeton.
 *
 * ⚠️ `nodeId` À NULL EST LE CAS D'AVANT, pas une erreur : les liens déjà distribués n'ont pas de point, et
 * ils doivent continuer de démarrer le scénario à son entrée.
 */
export function lireJetonDeTest(body: string | null): { jeton: string; nodeId: string | null } | null {
  const texte = normalizeTestToken(body);
  if (!TOKEN_RE.test(texte)) return null;
  const point = texte.indexOf('.');
  return point === -1
    ? { jeton: texte, nodeId: null }
    : { jeton: texte.slice(0, point), nodeId: texte.slice(point + 1) };
}


/** Minuscules + espaces retirés : la forme sous laquelle un jeton est comparé et stocké. */
export function normalizeTestToken(body: string | null): string {
  return (body ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Lien WhatsApp qui ouvre une conversation avec le jeton DÉJÀ saisi. `displayPhoneNumber` arrive tel que Meta
 * l'affiche (« +33 5 25 68 02 50 ») : wa.me n'accepte que des chiffres, sans + ni espaces.
 * null si le tenant n'a pas encore de numéro (rien à proposer, on ne fabrique pas un lien cassé).
 *
 * La construction de l'URL vit dans `src/lib/wa-me.ts` depuis que la chaîne WhatsApp la fabrique aussi. Ce
 * qui reste ICI est la seule chose propre au TEST : un jeton VIDE ne donne pas de lien. Ce refus porte sur le
 * jeton, pas sur l'URL, donc il ne descend pas dans le module partagé, dont l'autre appelant compose toujours
 * un texte non vide (une phrase suivie du jeton du lien).
 */
export function waMeTestLink(displayPhoneNumber: string | null, token: string): string | null {
  if (token === '') return null;
  return lienWaMe(displayPhoneNumber, token);
}
