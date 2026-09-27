/**
 * Les en-têtes de sécurité posés sur chaque réponse de l'API.
 *
 * `Strict-Transport-Security` n'est pas ici : Cloudflare le pose devant l'API et Vercel devant la console. Le
 * reposer créerait une seconde source pour une valeur qui doit rester unique (le `max-age` le plus court gagnerait).
 *
 * La CSP de l'API est enforçante (sa surface est petite : JSON, redirections, images, deux pages HTML d'erreur de
 * lien tracé), celle de la console reste en Report-Only. `style-src 'unsafe-inline'` sert les attributs `style=`
 * de ces pages ; aucun `script-src` n'est ouvert, elles n'ont pas de JavaScript.
 */

/**
 * Figé et testé, parce qu'une CSP se relâche par petites touches : chaque directive doit se justifier par un chemin
 * réel de l'API, et `tests/entetes-securite.test.ts` interdit `script-src 'unsafe-inline'` et `default-src *`.
 */
export const CSP_API = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Les en-têtes. `Referrer-Policy: no-referrer` : une adresse de l'API porte des identifiants dans son chemin
 * (`/r/<code>/<jeton>` identifie un destinataire), qu'un référent livrerait au site de destination.
 */
export const ENTETES_SECURITE_API: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CSP_API,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // Aucune de ces capacités n'a de sens pour une API : on les refuse toutes plutôt que d'en énumérer une
  // partie, ce qui obligerait à tenir la liste à jour au fil des versions de navigateur.
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
});
