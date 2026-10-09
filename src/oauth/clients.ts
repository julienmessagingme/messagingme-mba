/**
 * Les clients OAuth, en trois sortes (lot 15, spec `2026-10-09-oauth-autres-clients-design.md`, § 1) :
 * - ÉPINGLÉS : Claude Code et Claude (claude.ai, Desktop, mobile), recopiés ici ;
 * - à FICHE D'IDENTITÉ : un `client_id` qui est une adresse `https`, dont la fiche est récupérée avec nos gardes
 *   (`src/oauth/fiche-client.ts`) ; le domaine de l'adresse prouve l'éditeur ;
 * - ENREGISTRÉS : un `client_id` `mcl_…` rendu par `POST /oauth/register` (RFC 7591), gardé en base ; son nom est
 *   celui qu'il a déclaré, rien ne le vérifie.
 *
 * 🔴 LES ÉPINGLÉS SONT RECOPIÉS, JAMAIS RÉCUPÉRÉS À LA VOLÉE. Leurs fiches ont été relues le 2026-10-03 : les aller
 * chercher nous rendrait dépendants du Cloudflare de claude.ai, qui rend 403 à certaines adresses de nuage (ticket
 * anthropics/claude-code#84263). Un script relit les fiches publiées à chaque déploiement de l'API et dit si elles
 * divergent de cette copie (tâche 7 du plan `2026-10-03-oauth-mcp.md`).
 */
export interface ClientOauth {
  /** L'identifiant du client : l'adresse de sa fiche, ou `mcl_…` pour un client enregistré. */
  readonly id: string;
  /** Le nom affiché sur la page de consentement : vérifié pour un épinglé, déclaré sinon. */
  readonly nom: string;
  /** Les adresses de retour acceptées, telles que la fiche ou l'enregistrement les déclare. */
  readonly adressesDeRetour: readonly string[];
}

/** Comment le nom d'un client est établi : recopié par nous, prouvé par le domaine de sa fiche, ou déclaré par lui. */
export type MarqueClient = 'epingle' | 'domaine' | 'declaree';

/** Un client résolu, de n'importe quelle sorte. `domaine` : l'hôte de l'adresse d'une fiche d'identité. */
export interface ClientResolu extends ClientOauth {
  readonly marque: MarqueClient;
  readonly domaine?: string;
}

export const CLIENTS_OAUTH: readonly ClientOauth[] = [
  {
    id: 'https://claude.ai/oauth/claude-code-client-metadata',
    nom: 'Claude Code',
    adressesDeRetour: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  },
  {
    id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    nom: 'Claude',
    adressesDeRetour: ['https://claude.ai/api/mcp/auth_callback'],
  },
];

/** Le client ÉPINGLÉ de cet identifiant, ou `null` : égalité exacte, aucune normalisation. */
export function clientConnu(id: string): ClientOauth | null {
  return CLIENTS_OAUTH.find((c) => c.id === id) ?? null;
}

/** La forme d'un identifiant rendu par l'enregistrement dynamique (CHECK `oauth_clients_id_chk`, migration 0227). */
const FORME_ENREGISTRE = /^mcl_[A-Za-z0-9]{32}$/;
export function estClientEnregistre(id: string): boolean {
  return FORME_ENREGISTRE.test(id);
}

/**
 * L'identifiant est-il l'adresse d'une fiche d'identité qu'on peut aller lire ? `https`, un chemin, ni identifiants,
 * ni requête, ni fragment, 2 000 caractères au plus, et identique à sa reconstruction : c'est cette chaîne exacte que
 * la fiche doit porter dans son `client_id`. Un épinglé n'en est pas une : il n'est jamais récupéré.
 */
export function estAdresseDeFiche(id: string): boolean {
  if (id.length > 2000 || clientConnu(id)) return false;
  let u: URL;
  try {
    u = new URL(id);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.username === '' && u.password === '' && u.search === '' && u.hash === ''
    && u.pathname !== '/' && u.href === id;
}

/** Les deux seuls hôtes de boucle locale qu'une fiche déclare. `[::1]` n'en fait pas partie. */
const BOUCLE_LOCALE = new Set(['localhost', '127.0.0.1']);

/**
 * L'adresse de retour est-elle acceptée pour ce client ? Égalité exacte avec une adresse déclarée, à une seule
 * exception : le PORT d'une adresse de boucle locale en `http` (OAuth 2.1, 8.4.2, et RFC 8252, 7.3), puisque
 * Claude Code écoute sur un port qui change à chaque session. L'adresse déclarée peut porter un port (un client
 * enregistré déclare souvent `http://127.0.0.1:33418/`) : il est ignoré à la comparaison.
 *
 * 🔴 L'adresse est relue depuis ses composants, et doit être identique à sa reconstruction : des identifiants
 * (`http://localhost@evil.test/...`), une requête, un fragment ou une forme que l'analyseur normaliserait sont
 * refusés, parce que c'est vers la chaîne REÇUE que le code partira.
 */
export function adresseDeRetourAcceptee(client: ClientOauth, uri: string): boolean {
  if (client.adressesDeRetour.includes(uri)) return true;
  const sansPort = boucleLocaleSansPort(uri);
  if (sansPort === null) return false;
  return client.adressesDeRetour.some((a) => a === sansPort || boucleLocaleSansPort(a) === sansPort);
}

/** Une adresse de boucle locale `http` à port, sans son port ; `null` pour toute autre forme. */
function boucleLocaleSansPort(uri: string): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.port === '' || u.protocol !== 'http:' || !BOUCLE_LOCALE.has(u.hostname)) return null;
  // Une origine seule (`http://127.0.0.1:8787`) vaut sa forme à barre, comme en https.
  const recon = `http://${u.hostname}:${u.port}${u.pathname}`;
  if (uri !== recon && !(u.pathname === '/' && `${uri}/` === recon)) return null;
  return `http://${u.hostname}${u.pathname}`;
}

/**
 * La politique des adresses de retour d'un client NON épinglé (décision de Julien du 2026-10-09, spec § 4) : `https`
 * sur tout hôte, ou la boucle locale `http://localhost` et `http://127.0.0.1` sur tout port. Ni identifiants, ni
 * requête, ni fragment, et identique à sa reconstruction. Les schémas d'application (`cursor://`, `vscode://`) sont
 * refusés : n'importe quelle application de la machine peut en revendiquer un.
 */
export function adresseDeRetourPermise(uri: string): boolean {
  if (uri.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return false;
  // Une origine seule s'écrit sans la barre que l'analyseur ajoute (`https://app.exemple.fr`) : acceptée telle quelle.
  if (u.protocol === 'https:') return u.href === uri || (u.pathname === '/' && u.href === `${uri}/`);
  if (u.protocol === 'http:' && BOUCLE_LOCALE.has(u.hostname)) {
    const recon = `http://${u.hostname}${u.port === '' ? '' : `:${u.port}`}${u.pathname}`;
    return uri === recon || (u.pathname === '/' && `${uri}/` === recon);
  }
  return false;
}
