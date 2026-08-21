/**
 * Distinguer le clic d'un destinataire d'un appel automatique, au moment de compter.
 *
 * MESURÉ le 2026-08-21 sur le premier lien tracé de la production : 70 requêtes sur le lien d'un template
 * qui n'avait JAMAIS été envoyé à personne. 59 portaient l'agent `facebookexternalhit` (le robot
 * d'exploration de Meta) ; les 11 autres venaient de vrais navigateurs mobiles, mais arrivaient de Facebook
 * (référent `*.facebook.com`, paramètre `fbclid`), soit l'équipe de revue de Meta qui ouvre le bouton
 * pendant l'examen du template. Zéro destinataire, par construction.
 *
 * Autrement dit : TOUT template portant un bouton URL est exploré puis cliqué par Meta AVANT son premier
 * envoi. Sans ce filtre, chaque campagne démarre avec un compteur déjà faux, et personne ne peut deviner
 * pourquoi.
 *
 * ⚠️ Ce filtre ne décide QUE du comptage. La redirection reste inconditionnelle : un lien déjà livré doit
 * fonctionner pour tout le monde, robot compris. Voir `src/http/links.ts`.
 *
 * ⚠️ RGPD : rien de tout cela n'est enregistré. On lit l'en-tête, on décide, on l'oublie. La table
 * `tracked_link_clicks` ne contient toujours ni agent, ni adresse IP, ni référent (migration 0066).
 */

/**
 * Marqueurs d'agents non humains, en minuscules.
 *
 * Le premier est celui qu'on a réellement mesuré ; les suivants sont le fond de robots que reçoit toute URL
 * publique. La liste est délibérément ÉTROITE : un faux positif ici efface le clic d'un vrai client, en
 * silence et définitivement, ce qui est pire que de laisser passer un robot exotique.
 *
 * 🔴 Chaque marqueur porte son DÉLIMITEUR (`/`, `-`, ou le mot entier). Un marqueur nu testé en sous-chaîne
 * libre attrape de vrais téléphones : « bot » seul écarte tous les appareils **CUBOT**, une marque
 * d'Android vendue en Europe, dont le nom de modèle figure dans le user-agent. C'est exactement le faux
 * positif que la liste étroite était censée éviter.
 *
 * `whatsapp` n'y est PAS. Un lien tracé vit sur un BOUTON, et Meta ne génère pas d'aperçu pour un bouton :
 * le cas ne se présente donc pas. L'y ajouter risquerait au contraire d'effacer les clics venus du
 * navigateur intégré de WhatsApp.
 */
const AGENTS_AUTOMATIQUES = [
  'facebookexternal', // couvre `facebookexternalhit` ET `facebookexternalua`, tous deux mesurés
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
 * Trois signaux, du plus fiable au plus faible, et il suffit d'UN pour écarter :
 *  1. l'agent se déclare robot ;
 *  2. le référent est Facebook (revue de template, jamais un destinataire) ;
 *  3. l'URL porte un `fbclid`, que Facebook ajoute en sortie de son redirecteur.
 */
export function estClicAutomatique(signaux: SignauxClic): boolean {
  // Un agent ABSENT ne disqualifie pas. C'est tentant (tout navigateur en envoie un), mais entre effacer le
  // clic d'un vrai client et laisser passer un robot muet, le premier est pire : il est invisible et
  // définitif. Tous les appels automatiques mesurés se déclaraient, eux.
  const agent = (signaux.userAgent ?? '').toLowerCase();
  if (agent !== '' && AGENTS_AUTOMATIQUES.some((m) => agent.includes(m))) return true;

  const referer = signaux.referer ?? '';
  if (referer !== '' && vientDeFacebook(referer)) return true;

  const params = signaux.parametres;
  if (params && Object.prototype.hasOwnProperty.call(params, 'fbclid')) return true;

  return false;
}
