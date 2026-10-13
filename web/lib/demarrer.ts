/**
 * LA PAGE FINALE DU TUNNEL DE LA BASE (lot 19) : ce qu'on donne à copier à un espace qui vient de naître pour vivre dans
 * Claude Code. Logique pure, tenue par `web/lib/demarrer.test.ts` ; l'écran est `web/app/demarrer/page.tsx`.
 */

/**
 * L'API publique, celle qui sert `/mcp` : la connexion OAuth ne s'annonce que sur l'hôte de `PUBLIC_API_URL`
 * (`src/http/mcp.ts`), jamais sur le domaine de la console. Le serveur du plugin (`plugin/.mcp.json`) et la vitrine la
 * nomment ; `tests/plugin.test.ts` et `tests/vitrine-developpeurs.test.ts` les tiennent égaux à elle.
 */
export const API_PUBLIQUE = 'https://api.messagingme.app';

/**
 * 🔴 LE PLUGIN CLAUDE CODE BRANCHE L'ESPACE (lot 10, livraison B, décision de Julien du 2026-10-12) : deux commandes,
 * sans clé, à la place de `claude mcp add` ; l'autorisation se valide ensuite par `/mcp` (le serveur s'y nomme
 * `SERVEUR_PLUGIN_MCP`), puis `COMMANDE_DEMARRAGE` lance la mise en service, qui lit d'abord où en est l'espace. Le
 * plugin vit dans `plugin/` et se publie dans `julienmessagingme/messagingme-plugin` ; `tests/plugin.test.ts` tient ces
 * noms égaux à ses manifestes. La page finale du tunnel et la vitrine les montrent ; la doc MCP garde `claude mcp add`
 * pour qui ne veut que le serveur.
 */
export const COMMANDES_PLUGIN = [
  '/plugin marketplace add julienmessagingme/messagingme-plugin',
  '/plugin install messagingme@messagingme',
] as const;
export const COMMANDE_DEMARRAGE = '/messagingme:demarrer';
export const SERVEUR_PLUGIN_MCP = 'plugin:messagingme:messagingme';

/** La variable d'environnement où ranger la clé d'API de l'application. */
export const VARIABLE_CLE = 'MESSAGINGME_API_KEY';

/** La valeur de `?suite=` qui fait de `/connecter-whatsapp` une étape du tunnel, et sa clé dans la mémoire de l'onglet. */
export const SUITE_DEMARRER = 'demarrer';
export const CLE_SUITE = 'mba.suite';

/**
 * La page du numéro est-elle une étape du tunnel ? Par son adresse, ou par la mémoire de l'onglet : le retour de
 * paiement d'un numéro fourni arrive sur `/connecter-whatsapp?abonnement=recu` (`src/stripe/abonnement.ts`), sans la
 * suite, et l'espace perdrait la page finale. La mémoire ne sert QUE ce retour : un onglet quitté en route, puis la page
 * rouverte depuis l'Accueil, ne doit pas se croire encore dans le tunnel.
 */
export function enSuiteDeDemarrage(recherche: string, memoire: string | null): boolean {
  const p = new URLSearchParams(recherche);
  return p.get('suite') === SUITE_DEMARRER || (p.has('abonnement') && memoire === SUITE_DEMARRER);
}
