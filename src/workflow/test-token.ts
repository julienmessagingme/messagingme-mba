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
 * Forme attendue du JETON, c'est-à-dire de la partie GAUCHE. Le suffixe de bloc, lui, n'a pas de forme :
 * voir `lireJetonDeTest`.
 */
const JETON_RE = new RegExp(`^${PREFIX}[0-9a-hjkmnp-tv-z]{${RANDOM_LEN}}$`);

/**
 * Le jeton et le BLOC qu'il désigne, ou `null` si ce n'en est pas un. C'EST LE FILTRE DU CHEMIN CHAUD :
 * `null` veut dire « message ordinaire », et le webhook passe au suivant sans rien coûter.
 *
 * ⚠️ UNE SEULE FONCTION POUR FILTRER ET POUR LIRE. Il y avait un prédicat `looksLikeTestToken` à côté,
 * retiré le 2026-09-16 : deux portes sur la même forme divergent, et la divergence serait MUETTE dans le
 * sens le plus coûteux (le filtre accepte, la lecture rend `null`, le message est consommé, rien ne démarre).
 *
 * 🔴 LE SUFFIXE N'A AUCUNE FORME IMPOSÉE, ET C'EST UNE CORRECTION DE LA REVUE FINALE (2026-09-16). Il était
 * borné à `[0-9a-z_-]{1,64}`, sur une MESURE d'un jour (« les 64 blocs de production portent tous un UUID
 * minuscule »). Or `parseGraph` (`src/workflow/graph.ts`) accepte comme `node.id` n'importe quelle chaîne non
 * vide : majuscules, point, deux-points, accents, longueur libre. Un identifiant hors de cette classe faisait
 * rendre `null` ici, donc le message N'ÉTAIT PAS CONSOMMÉ, et il descendait jusqu'à l'agent de Meta, qui
 * répondait au testeur. Le mauvais sens : une supposition qui échoue doit donner un refus LISIBLE, jamais une
 * fuite silencieuse.
 *
 * Ce qui discrimine est donc la partie GAUCHE, et elle seule : `test-` plus huit caractères Crockford, ce
 * qu'un message de client n'écrit jamais par hasard. Tout ce qui suit le PREMIER point est un POINTEUR, rendu
 * tel quel à l'appelant. Un bloc introuvable est alors refusé par `runFrom`, avec sa raison et sa trace.
 *
 * 🔴 ET LA CASSE DU SUFFIXE EST PRÉSERVÉE. Le texte entier était mis en minuscules : un identifiant portant
 * une majuscule passait le filtre puis échouait à l'égalité, donc un refus pour une raison invisible. Seul le
 * JETON est mis en minuscules, parce que lui seul a une forme connue, et parce que c'est sur la première
 * lettre du message qu'un clavier de téléphone met une majuscule tout seul.
 *
 * ⚠️ Les espaces restent retirés PARTOUT : WhatsApp en ajoute, et un copier-coller en laisse. Conséquence
 * assumée et documentée : un `node.id` contenant une espace ne peut pas voyager. Il donne alors le refus
 * lisible du bloc introuvable, pas une fuite.
 *
 * ⚠️ `nodeId` À NULL EST LE CAS D'AVANT, pas une erreur : les liens déjà distribués n'ont pas de point, et
 * ils doivent continuer de démarrer le scénario à son entrée.
 */
export function lireJetonDeTest(body: string | null): { jeton: string; nodeId: string | null } | null {
  const texte = (body ?? '').trim().replace(/\s+/g, '');
  const point = texte.indexOf('.');
  const jeton = (point === -1 ? texte : texte.slice(0, point)).toLowerCase();
  if (!JETON_RE.test(jeton)) return null;
  if (point === -1) return { jeton, nodeId: null };
  const nodeId = texte.slice(point + 1);
  // Un point suivi de rien ne DÉSIGNE rien : ce n'est pas un lien que ce produit fabrique.
  return nodeId === '' ? null : { jeton, nodeId };
}

/**
 * LE BLOC QUE CE SUFFIXE DÉSIGNE, dans un graphe donné : son identifiant EXACT, ou le suffixe tel quel quand
 * rien ne correspond (l'exécuteur rendra alors son refus lisible, avec sa trace).
 *
 * 🔴 LA CASSE EST TOLÉRÉE ICI, ET NULLE PART AILLEURS (seconde passe de revue finale, 2026-09-16). Le premier
 * correctif mettait tout le message en minuscules : un identifiant de bloc portant une majuscule passait le
 * filtre puis échouait à l'égalité. Le second préservait la casse du suffixe, ce qui réparait ce cas-là mais
 * cassait le cas COURANT, mesuré par le relecteur : un testeur qui recopie son mot en capitales ne trouvait
 * plus son bloc. Les deux cas se ferment en résolvant ici, en deux temps : l'égalité d'abord, la tolérance
 * ensuite.
 *
 * ⚠️ ET LA COMPARAISON DE `runFrom` NE BOUGE PAS. Elle sert aussi la cible `node` de `/v1/sends`, qui reçoit
 * un identifiant EXACT résolu depuis un code `nod_`. Élargir une comparaison partagée pour le confort d'un
 * seul appelant est le motif que ce dépôt paie le plus cher. On lui donne donc l'identifiant canonique, et
 * c'est elle qui garde le dernier mot sur un bloc introuvable.
 *
 * ⚠️ DEUX BLOCS QUI NE DIFFÈRENT QUE PAR LA CASSE : on n'en choisit AUCUN, et le refus lisible reprend la
 * main. Deviner lequel enverrait au testeur une séquence qu'il n'a pas demandée.
 */
export function blocDesigne(graphe: { nodes: Array<{ id: string }> }, nodeId: string): string {
  if (graphe.nodes.some((n) => n.id === nodeId)) return nodeId;
  const bas = nodeId.toLowerCase();
  const proches = graphe.nodes.filter((n) => n.id.toLowerCase() === bas);
  return proches.length === 1 ? proches[0]!.id : nodeId;
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
