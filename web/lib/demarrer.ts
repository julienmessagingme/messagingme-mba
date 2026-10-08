/**
 * LA PAGE FINALE DU TUNNEL DE LA BASE (lot 19) : ce qu'on donne à copier à un espace qui vient de naître pour vivre dans
 * Claude Code. Logique pure, tenue par `web/lib/demarrer.test.ts` ; l'écran est `web/app/demarrer/page.tsx`.
 */

/** Le nom local du serveur MCP dans Claude Code : ce que le prompt nomme. */
export const NOM_SERVEUR_MCP = 'messagingme';

/**
 * L'API publique, quand `BASE` est relative (l'ancienne console du VPS, le serveur des tests) : la connexion OAuth ne
 * s'annonce que sur l'hôte de `PUBLIC_API_URL` (`src/http/mcp.ts`), donc une commande sans clé pointée sur le domaine de
 * la page ne s'ouvrirait jamais.
 */
export const API_PUBLIQUE = 'https://api.messagingme.app';

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

/**
 * 🔴 LA COMMANDE QUI BRANCHE CLAUDE CODE, SANS CLÉ (décision de Julien du 2026-10-08) : la connexion OAuth se valide
 * ensuite par `/mcp` dans Claude Code (il ne l'ouvre pas tout seul), et rien de secret ne passe par le terminal. L'adresse est celle de l'API (`BASE`), qui sert
 * `/mcp` : jamais celle de la console, où `/mcp` rend 404.
 */
export function commandeMcp(origineApi: string): string {
  return `claude mcp add --transport http ${NOM_SERVEUR_MCP} ${origineApi.replace(/\/+$/, '')}/mcp`;
}

/**
 * Le prompt à coller dans Claude Code : le serveur à utiliser, où vit la clé de l'application (jamais dans le code), la
 * documentation de l'API, et le numéro à brancher s'il ne l'est pas encore.
 */
export function promptDeDemarrage(o: { langue: 'fr' | 'en'; docApi: string; numeroConnecte: boolean }): string {
  if (o.langue === 'en') {
    return [
      `My Messaging Me workspace (WhatsApp) is connected to Claude Code through the "${NOM_SERVEUR_MCP}" MCP server: use its tools to read and set up my workspace.`,
      `For my application's code, the API key is in the ${VARIABLE_CLE} environment variable: never in the code, nor in a file tracked by git.`,
      `The API documentation is here: ${o.docApi}`,
      ...(o.numeroConnecte ? [] : ['My WhatsApp number is not connected yet: offer to connect it (start_whatsapp_connection).']),
      'Start by asking me what my application should do with WhatsApp.',
    ].join('\n');
  }
  return [
    `Mon espace Messaging Me (WhatsApp) est branché à Claude Code par le serveur MCP « ${NOM_SERVEUR_MCP} » : utilise ses outils pour lire et régler mon espace.`,
    `Pour le code de mon application, la clé d’API est dans la variable d’environnement ${VARIABLE_CLE} : jamais dans le code, ni dans un fichier suivi par git.`,
    `La documentation de l’API est ici : ${o.docApi}`,
    ...(o.numeroConnecte ? [] : ['Mon numéro WhatsApp n’est pas encore connecté : propose de le brancher (start_whatsapp_connection).']),
    'Commence par me demander ce que mon application doit faire avec WhatsApp.',
  ].join('\n');
}
