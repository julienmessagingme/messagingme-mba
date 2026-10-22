import { messageDe } from '../lib/erreur';

/**
 * Les routes par lesquelles on ENTRE : la console (`/auth/*`) et Claude Code (`/oauth/*` et sa découverte).
 * Un 500 y laisse les gens à la porte sans que la santé de l'API ne bouge : le 2026-10-21, la connexion Google a rendu
 * 500 pendant 19 h, le mot de passe marchait, et l'erreur n'était écrite que dans un journal que personne ne lisait.
 */
const ROUTES_DE_CONNEXION = /^\/(auth|oauth)\/|^\/\.well-known\/oauth/;

/** Silence entre deux alertes : une panne qui dure prévient une fois par demi-heure, pas à chaque essai. */
export const REPOS_ALERTE_CONNEXION_MS = 30 * 60_000;

/**
 * Construit l'alerte, à appeler sur chaque 5xx. Elle part au PREMIER 500 d'une route de connexion (jamais normal, pas
 * de seuil), puis se tait pendant le repos. Le repos est local à la copie de l'API : avec N copies, au plus N alertes
 * par demi-heure, ce qui reste lisible. Elle ne lève jamais : elle vit dans le gestionnaire d'erreurs.
 */
export function creerAlerteConnexion(alerter: (texte: string) => void, maintenant: () => number = Date.now) {
  let reposJusqua = 0;
  return (req: { method: string; url: string }, err: unknown): void => {
    const chemin = req.url.split('?')[0] ?? '';
    if (!ROUTES_DE_CONNEXION.test(chemin) || maintenant() < reposJusqua) return;
    reposJusqua = maintenant() + REPOS_ALERTE_CONNEXION_MS;
    try {
      alerter(
        `Connexion en panne : ${req.method} ${chemin} a rendu 500 (${String(messageDe(err)).slice(0, 200)}). `
        + `Des utilisateurs ne peuvent peut-être plus entrer. Détail : journal de mba-api, unhandled_route_error.`,
      );
    } catch {
      // Une alerte qui lève ne doit pas changer la réponse d'erreur.
    }
  };
}
