import { randomBytes } from 'node:crypto';

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

/** Jeton neuf : `test-` + 8 caractères aléatoires (40 bits, impossible à deviner par force brute utile). */
export function newTestToken(): string {
  let out = '';
  for (const b of randomBytes(RANDOM_LEN)) out += CROCKFORD[b % 32];
  return PREFIX + out;
}

/**
 * Forme attendue d'un jeton. Sert à éviter d'interroger la base pour chaque message entrant : seuls les
 * messages qui RESSEMBLENT à un jeton déclenchent une résolution. C'est le filtre du chemin chaud.
 */
const TOKEN_RE = new RegExp(`^${PREFIX}[0-9a-hjkmnp-tv-z]{${RANDOM_LEN}}$`);

/**
 * Le corps d'un message est-il (exactement) un jeton de test ? Comparaison sur le texte NORMALISÉ : WhatsApp
 * peut ajouter des espaces, et un téléphone peut capitaliser la première lettre automatiquement.
 *
 * Volontairement STRICT (message entier, pas « contient ») : un client qui écrirait « je teste test-abc » ne
 * doit pas déclencher un test, et une phrase ne doit jamais être confondue avec un jeton.
 */
export function looksLikeTestToken(body: string | null): boolean {
  return TOKEN_RE.test(normalizeTestToken(body));
}

/** Minuscules + espaces retirés : la forme sous laquelle un jeton est comparé et stocké. */
export function normalizeTestToken(body: string | null): string {
  return (body ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Lien WhatsApp qui ouvre une conversation avec le jeton DÉJÀ saisi. `displayPhoneNumber` arrive tel que Meta
 * l'affiche (« +33 5 25 68 02 50 ») : wa.me n'accepte que des chiffres, sans + ni espaces.
 * null si le tenant n'a pas encore de numéro (rien à proposer, on ne fabrique pas un lien cassé).
 */
export function waMeTestLink(displayPhoneNumber: string | null, token: string): string | null {
  const digits = (displayPhoneNumber ?? '').replace(/\D/g, '');
  if (digits === '' || token === '') return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(token)}`;
}
