/**
 * Les clients OAuth acceptés : Claude Code et Claude (claude.ai, Desktop, mobile), et eux seuls.
 *
 * 🔴 RECOPIÉS, JAMAIS RÉCUPÉRÉS À LA VOLÉE. Leurs fiches d'identité (Client ID Metadata Documents) ont été relues
 * le 2026-10-03 : les aller chercher à chaque autorisation ferait partir une requête vers une adresse fournie par
 * un tiers, et nous rendrait dépendants du Cloudflare de claude.ai, qui rend 403 à certaines adresses de nuage
 * (ticket anthropics/claude-code#84263). Un script relit les fiches publiées à chaque déploiement de l'API et dit
 * si elles divergent de cette copie (tâche 7 du plan `2026-10-03-oauth-mcp.md`).
 *
 * Tout autre `client_id` est refusé sans redirection. L'identifiant est aussi tenu par le CHECK
 * `oauth_autorisations_client_chk` (migration 0204) : en ajouter un ici demande une migration.
 */
export interface ClientOauth {
  /** L'adresse de la fiche, qui est l'identifiant du client. */
  readonly id: string;
  /** Le nom affiché sur la page de consentement. */
  readonly nom: string;
  /** Les `redirect_uris` de la fiche, recopiées telles quelles. */
  readonly adressesDeRetour: readonly string[];
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

/** Le client de cet identifiant, ou `null` : égalité exacte, aucune normalisation. */
export function clientConnu(id: string): ClientOauth | null {
  return CLIENTS_OAUTH.find((c) => c.id === id) ?? null;
}

/** Les deux seuls hôtes de boucle locale qu'une fiche déclare. `[::1]` n'en fait pas partie. */
const BOUCLE_LOCALE = new Set(['localhost', '127.0.0.1']);

/**
 * L'adresse de retour est-elle acceptée pour ce client ? Égalité exacte avec une adresse de la fiche, à une seule
 * exception : le PORT d'une adresse de boucle locale en `http` (OAuth 2.1, 8.4.2, et RFC 8252, 7.3), puisque
 * Claude Code écoute sur un port qui change à chaque session.
 *
 * 🔴 L'adresse est relue depuis ses composants, et doit être identique à sa reconstruction : des identifiants
 * (`http://localhost@evil.test/...`), une requête, un fragment ou une forme que l'analyseur normaliserait sont
 * refusés, parce que c'est vers la chaîne REÇUE que le code partira.
 */
export function adresseDeRetourAcceptee(client: ClientOauth, uri: string): boolean {
  if (client.adressesDeRetour.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  // Sans port, l'égalité exacte a déjà répondu.
  if (u.port === '' || u.protocol !== 'http:' || !BOUCLE_LOCALE.has(u.hostname)) return false;
  if (uri !== `http://${u.hostname}:${u.port}${u.pathname}`) return false;
  return client.adressesDeRetour.includes(`http://${u.hostname}${u.pathname}`);
}
