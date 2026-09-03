/**
 * LES DEUX BASES D'ADRESSES QUE LE PRODUIT DISTRIBUE, ET POURQUOI IL EN FAUT DEUX.
 *
 * 🔴 `APP_URL` faisait DEUX métiers à la fois. Elle servait de base aux liens envoyés par e-mail (invitation
 * `/invite/<jeton>`, réinitialisation `/reset/<jeton>`), qui sont des pages du FRONT, ET aux adresses que le
 * produit distribue au dehors et qui sont servies par l'API : les liens tracés `/r/<code>` qui partent dans
 * des messages WhatsApp, les visuels RCS `/m/<fichier>` que l'opérateur télécom vient chercher, et l'URL
 * `/w/<code>` d'un webhook entrant qu'on donne à un tiers.
 *
 * Tant que le front et l'API vivaient sur le même hôte, une seule variable suffisait. Dès qu'ils se séparent
 * (bascule Vercel, `docs/PLAN-BASCULE-VERCEL-2026-09-03.md`), en garder une seule casse forcément un des deux
 * côtés : soit les e-mails envoient les gens vers l'API et ils tombent sur une page blanche, soit les liens
 * tracés font un détour inutile par le front.
 *
 * ⚠️ CE MODULE EXISTE POUR QUE LA RÈGLE SOIT ÉCRITE UNE FOIS. Elle porte un cas particulier qui se retiendrait
 * mal et se recopierait encore plus mal : `/r/` et `/m/` sont servis à la RACINE du front (ils ont leur propre
 * rewrite Next, sans préfixe), alors que `/w/` vit sous `/api/backend`, le préfixe du proxy. Les deux bases
 * ci-dessous ne sont donc PAS la même chaîne tant que l'API n'a pas son propre nom.
 */

export interface AdressesPubliques {
  /**
   * Base des adresses servies à la RACINE : liens tracés `/r/<code>`, visuels RCS `/m/<fichier>`.
   *
   * Aujourd'hui c'est le front, qui les relaie ; demain c'est l'API directement.
   */
  racine: string;
  /**
   * Base des routes d'API proprement dites, dont l'URL d'un webhook entrant `/w/<code>`.
   *
   * Aujourd'hui elle porte le préfixe `/api/backend` du proxy Next ; demain elle ne le porte plus, l'API
   * répondant sous son propre nom.
   */
  avecPrefixe: string;
}

/** Retire les barres obliques finales : `https://x/` et `https://x` doivent produire la même adresse. */
const sansBarreFinale = (url: string): string => url.replace(/\/+$/, '');

/**
 * Résout les deux bases.
 *
 * `publicApiUrl` vide est le cas NOMINAL d'aujourd'hui, pas une erreur : tout retombe sur `appUrl` et le
 * comportement est celui d'avant la bascule, au caractère près. C'est ce qui permet de déployer ce code sans
 * rien changer, puis de basculer par une simple variable d'environnement.
 */
export function adressesPubliques(appUrl: string, publicApiUrl: string): AdressesPubliques {
  const api = sansBarreFinale(publicApiUrl.trim());
  const front = sansBarreFinale(appUrl.trim());
  if (api === '') return { racine: front, avecPrefixe: `${front}/api/backend` };
  return { racine: api, avecPrefixe: api };
}
