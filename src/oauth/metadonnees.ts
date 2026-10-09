import type { ScopeMcp } from '../mcp/outils';

/**
 * Ce que l'API annonce de son OAuth : les métadonnées de la ressource (RFC 9728), celles du serveur d'autorisation
 * (RFC 8414), et l'en-tête `WWW-Authenticate` du 401 de `/mcp`.
 *
 * 🔴 TOUT SE DÉRIVE DE `PUBLIC_API_URL`, JAMAIS DE L'EN-TÊTE `Host`. Le client compare l'adresse qu'il appelle au
 * champ `resource` et refuse si elles diffèrent (RFC 9728, 3.3), et l'émetteur est enregistré avec chaque jeton :
 * `https://api.messagingme.app` et son `/mcp` sont donc l'identité de la ressource. Les renommer déconnecte tous
 * les Claude déjà autorisés.
 */

/** Les deux droits qu'une autorisation peut porter, et rien d'autre (CHECK `oauth_autorisations_scopes_chk`). */
export const DROITS_OAUTH: readonly ScopeMcp[] = ['mcp:read', 'mcp:write'];

/**
 * La base de l'OAuth, ou `null` quand `PUBLIC_API_URL` n'est pas posée. Vide, les adresses publiques retombent sur
 * celle de la console (`adressesPubliques`), et l'émetteur annoncé serait faux : l'OAuth ne s'annonce alors pas.
 * Illisible comme adresse, non plus : un émetteur faux ne vaut pas mieux qu'aucun, et le démarrage ne doit pas en
 * dépendre.
 */
export function baseOauth(publicApiUrl: string): string | null {
  const base = publicApiUrl.trim().replace(/\/+$/, '');
  return base !== '' && URL.canParse(base) ? base : null;
}

/** L'adresse de la ressource, sans barre finale : celle que l'utilisateur ajoute dans Claude. */
export function ressourceMcp(base: string): string {
  return `${base}/mcp`;
}

/** Les métadonnées de la ressource (RFC 9728), servies à la racine ET à la forme à chemin `/mcp`. */
export function metadonneesRessource(base: string): Record<string, unknown> {
  return {
    resource: ressourceMcp(base),
    authorization_servers: [base],
    scopes_supported: DROITS_OAUTH,
    bearer_methods_supported: ['header'],
  };
}

/**
 * Les métadonnées du serveur d'autorisation (RFC 8414). Trois annonces décident de ce que fait un client :
 * `code_challenge_methods_supported` (sans elle, le client doit refuser de continuer) ; le couple
 * `token_endpoint_auth_methods_supported: ["none"]` + `client_id_metadata_document_supported`, qui lui fait présenter
 * sa fiche d'identité (Claude, ChatGPT) ; et `registration_endpoint` (lot 15), l'enregistrement dynamique en repli pour
 * un client qui n'en a pas (Cursor, VS Code).
 * `revocation_endpoint_auth_methods_supported` est annoncé aussi : omis, la RFC 8414 le fait valoir
 * `client_secret_basic`, qu'un client public ne peut pas présenter.
 */
export function metadonneesServeur(base: string): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    scopes_supported: DROITS_OAUTH,
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * L'en-tête du 401 de `/mcp`, celui qui déclenche la connexion chez Claude (un 200 ne la déclenche jamais).
 * `erreur` seulement quand un jeton a été présenté et refusé : sans authentification, la RFC 6750 (3.1) veut un
 * en-tête sans code d'erreur.
 */
export function enTeteWwwAuthenticate(base: string, erreur?: 'invalid_token'): string {
  const params = [
    `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    `scope="${DROITS_OAUTH.join(' ')}"`,
    ...(erreur ? [`error="${erreur}"`] : []),
  ];
  return `Bearer ${params.join(', ')}`;
}
