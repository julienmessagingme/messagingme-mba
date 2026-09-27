/**
 * Les deux bases d'adresses que le produit distribue.
 *
 * `APP_URL` sert aux liens d'e-mail (`/invite/<jeton>`, `/reset/<jeton>`), des pages du front. Les adresses
 * distribuées au dehors et servies par l'API (liens tracés `/r/<code>`, visuels RCS `/m/<fichier>`, webhook
 * entrant `/w/<code>`) ont leur propre base dès que le front et l'API vivent sur deux hôtes.
 *
 * La règle est écrite ici une fois : `/r/` et `/m/` sont servis à la racine du front (rewrite Next sans
 * préfixe), alors que `/w/` vit sous `/api/backend`, le préfixe du proxy.
 */

export interface AdressesPubliques {
  /** Base des adresses servies à la racine : liens tracés `/r/<code>`, visuels RCS `/m/<fichier>`. */
  racine: string;
  /**
   * Base des routes d'API, dont l'URL d'un webhook entrant `/w/<code>` : elle porte le préfixe `/api/backend`
   * tant que l'API passe par le proxy Next.
   */
  avecPrefixe: string;
}

/** Retire les barres obliques finales : `https://x/` et `https://x` doivent produire la même adresse. */
const sansBarreFinale = (url: string): string => url.replace(/\/+$/, '');

/**
 * Résout les deux bases. `publicApiUrl` vide n'est pas une erreur : tout retombe sur `appUrl`, `/w/` passant
 * par le préfixe du proxy.
 */
export function adressesPubliques(appUrl: string, publicApiUrl: string): AdressesPubliques {
  const api = sansBarreFinale(publicApiUrl.trim());
  const front = sansBarreFinale(appUrl.trim());
  if (api === '') return { racine: front, avecPrefixe: `${front}/api/backend` };
  return { racine: api, avecPrefixe: api };
}
