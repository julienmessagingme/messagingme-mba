import { chaineAleatoire } from '../lib/jeton-aleatoire';
import { lienWaMe } from '../lib/wa-me';

/**
 * Jeton de test d'un scénario : le mot que le testeur envoie sur WhatsApp pour déclencher un scénario depuis
 * son propre téléphone.
 *
 * Il est pré-rempli dans un lien `wa.me/<numéro>?text=<jeton>` (et son QR) : c'est le testeur qui écrit, donc
 * qui ouvre la fenêtre de service 24 h, ce qui rend le test légitime même pour un scénario qui commence par un
 * message de session.
 *
 * Forme :
 *  - préfixe lisible `test-` : un vrai client n'écrit jamais ça par hasard.
 *  - 🔴 suffixe aléatoire : le jeton ne doit pas être devinable, sinon n'importe qui pourrait déclencher le
 *    scénario d'un client (tags, champs, messages facturés).
 *  - alphabet Crockford sans I/L/O/U : pas d'ambiguïté si on le recopie à la main.
 */

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const PREFIX = 'test-';
const RANDOM_LEN = 8;

/**
 * Jeton neuf : `test-` + 8 caractères aléatoires (40 bits). Tirage partagé avec `nouveauJeton`
 * (`src/channels-me/jeton.ts`) via `chaineAleatoire` : même alphabet, seul le préfixe diffère.
 */
export function newTestToken(): string {
  return PREFIX + chaineAleatoire(RANDOM_LEN, CROCKFORD);
}

/** Forme attendue du jeton, c'est-à-dire de la partie gauche (le suffixe de bloc n'a pas de forme). */
const JETON_RE = new RegExp(`^${PREFIX}[0-9a-hjkmnp-tv-z]{${RANDOM_LEN}}$`);

/**
 * Le jeton et le bloc qu'il désigne, ou `null` si ce n'en est pas un. C'est le filtre du chemin chaud : `null`
 * veut dire « message ordinaire ». Une seule fonction pour filtrer et pour lire : deux portes sur la même
 * forme divergeraient en silence (le filtre accepte, la lecture rend `null`, le message est consommé, rien
 * ne démarre).
 *
 * Seule la partie gauche discrimine (`test-` plus huit caractères Crockford). Ce qui suit le premier point est
 * un pointeur rendu tel quel, sans forme imposée : `parseGraph` accepte comme `node.id` n'importe quelle
 * chaîne non vide, et un suffixe refusé ici laisserait le message descendre jusqu'à l'agent de Meta au lieu
 * du refus lisible de `runFrom`.
 *
 * Seul le jeton est mis en minuscules (un clavier de téléphone capitalise la première lettre) ; la casse du
 * suffixe est préservée. Les espaces sont retirés partout (WhatsApp et le copier-coller en ajoutent) : un
 * `node.id` contenant une espace donne donc le refus lisible du bloc introuvable.
 *
 * `nodeId` à null : lien sans point, qui démarre le scénario à son entrée (les liens déjà distribués).
 */
export function lireJetonDeTest(body: string | null): { jeton: string; nodeId: string | null } | null {
  const texte = (body ?? '').trim().replace(/\s+/g, '');
  const point = texte.indexOf('.');
  const jeton = (point === -1 ? texte : texte.slice(0, point)).toLowerCase();
  if (!JETON_RE.test(jeton)) return null;
  if (point === -1) return { jeton, nodeId: null };
  const nodeId = texte.slice(point + 1);
  // Un point suivi de rien ne désigne rien : ce n'est pas un lien que ce produit fabrique.
  return nodeId === '' ? null : { jeton, nodeId };
}

/**
 * Le bloc que ce suffixe désigne dans un graphe : son identifiant exact, sinon l'unique bloc égal à la casse
 * près (un testeur qui recopie son mot en capitales), sinon le suffixe tel quel, que l'exécuteur refusera
 * lisiblement.
 *
 * La tolérance vit ici et pas dans la comparaison de `runFrom`, qui sert aussi la cible `node` de `/v1/sends`
 * avec un identifiant exact : on ne l'élargit pas pour le confort d'un seul appelant. Deux blocs qui ne
 * diffèrent que par la casse : on n'en choisit aucun, plutôt que d'envoyer une séquence non demandée.
 */
export function blocDesigne(graphe: { nodes: Array<{ id: string }> }, nodeId: string): string {
  if (graphe.nodes.some((n) => n.id === nodeId)) return nodeId;
  const bas = nodeId.toLowerCase();
  const proches = graphe.nodes.filter((n) => n.id.toLowerCase() === bas);
  return proches.length === 1 ? proches[0]!.id : nodeId;
}

/**
 * Lien WhatsApp qui ouvre une conversation avec le jeton déjà saisi (URL construite par `src/lib/wa-me.ts`).
 * null si le tenant n'a pas encore de numéro. Seule règle propre au test : un jeton vide ne donne pas de lien.
 */
export function waMeTestLink(displayPhoneNumber: string | null, token: string): string | null {
  if (token === '') return null;
  return lienWaMe(displayPhoneNumber, token);
}
