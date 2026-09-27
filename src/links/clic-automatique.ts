/**
 * Distinguer le clic d'un destinataire d'un appel automatique, au moment de compter.
 *
 * Tout template portant un bouton URL est exploré par le robot de Meta (`facebookexternalhit`) puis ouvert par
 * son équipe de revue (référent `*.facebook.com`, paramètre `fbclid`) avant son premier envoi. Sans ce filtre,
 * chaque campagne démarre avec un compteur déjà faux.
 *
 * Ce filtre ne décide que du comptage : la redirection reste inconditionnelle, robot compris (`src/http/links.ts`).
 * RGPD : on lit l'en-tête, on décide, on l'oublie. `tracked_link_clicks` ne garde ni agent, ni IP, ni référent.
 */

/**
 * Marqueurs d'agents non humains, en minuscules.
 *
 * Liste étroite : un faux positif efface le clic d'un vrai client, en silence et définitivement.
 * Chaque marqueur porte son délimiteur (`/`, `-` ou le mot entier) : « bot » seul en sous-chaîne écarterait les
 * téléphones CUBOT, dont le modèle figure dans le user-agent.
 * `whatsapp` n'y est pas : Meta ne génère pas d'aperçu pour un bouton, et on effacerait les clics venus du
 * navigateur intégré de WhatsApp.
 */
const AGENTS_AUTOMATIQUES = [
  'facebookexternal', // couvre `facebookexternalhit` et `facebookexternalua`
  // Robots d'indexation : nom complet, jamais le suffixe `bot` seul.
  'googlebot',
  'bingbot',
  'applebot',
  'yandexbot',
  'petalbot',
  'duckduckbot',
  'ahrefsbot',
  'semrushbot',
  'twitterbot',
  'linkedinbot',
  'telegrambot',
  'slackbot',
  'discordbot',
  // Formes toujours suivies d'un délimiteur : aucune ne peut apparaître dans un nom d'appareil.
  'crawler/',
  'spider/',
  'curl/',
  'wget/',
  'python-requests/',
  'go-http-client/',
  'okhttp/',
  'java/',
  'headlesschrome',
  'uptimerobot',
  'pingdom',
];

/** Ce qu'on lit de la requête pour décider. Rien d'autre n'entre ici. */
export interface SignauxClic {
  userAgent?: string | null;
  referer?: string | null;
  /** Paramètres de l'URL, tels que Fastify les rend (déjà décodés). */
  parametres?: Record<string, unknown> | null;
}

/** Le référent vient-il de Facebook ? Un destinataire WhatsApp n'arrive jamais de là. */
function vientDeFacebook(referer: string): boolean {
  let hote: string;
  try {
    hote = new URL(referer).hostname.toLowerCase();
  } catch {
    return false; // référent illisible : on ne présume rien, on laisse compter
  }
  // Égalité ou sous-domaine, jamais `endsWith` seul : `notfacebook.com` s'y glisserait.
  return hote === 'facebook.com' || hote.endsWith('.facebook.com');
}

/**
 * Vrai si ce clic ne doit pas être compté.
 *
 * Trois signaux, du plus fiable au plus faible, et il suffit d'un pour écarter :
 *  1. l'agent se déclare robot ;
 *  2. le référent est Facebook (revue de template, jamais un destinataire) ;
 *  3. l'URL porte un `fbclid`, que Facebook ajoute en sortie de son redirecteur.
 */
export function estClicAutomatique(signaux: SignauxClic): boolean {
  // Un agent absent ne disqualifie pas : entre effacer le clic d'un vrai client et laisser passer un robot
  // muet, le premier est pire (invisible et définitif).
  const agent = (signaux.userAgent ?? '').toLowerCase();
  if (agent !== '' && AGENTS_AUTOMATIQUES.some((m) => agent.includes(m))) return true;

  const referer = signaux.referer ?? '';
  if (referer !== '' && vientDeFacebook(referer)) return true;

  const params = signaux.parametres;
  if (params && Object.prototype.hasOwnProperty.call(params, 'fbclid')) return true;

  return false;
}
