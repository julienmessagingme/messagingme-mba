/**
 * Les en-têtes de sécurité posés sur CHAQUE réponse de l'API.
 *
 * Demandé par le plan RSSI du 2026-09-09 (« ajouter CSP en Report-Only puis les en-têtes web de base »),
 * livré le 2026-09-10. Ils ne réparent aucun défaut connu : ils réduisent ce qu'une faille future pourrait
 * faire, et c'est précisément ce qu'un questionnaire de sécurité vient vérifier.
 *
 * 🔴 CE QUI N'EST PAS ICI, ET POURQUOI. `Strict-Transport-Security` est DÉJÀ posé, par Cloudflare devant
 * l'API (`max-age=63072000; preload`) et par Vercel devant la console (mesuré le 2026-09-10 sur les deux
 * hôtes). Le reposer ici ne changerait rien et créerait une seconde source de vérité pour une valeur qui
 * doit rester unique : deux `max-age` différents, et c'est le plus court qui gagnerait sans qu'on le sache.
 *
 * 🔴 LA CSP DE L'API EST ENFORÇANTE, celle de la console est en Report-Only, et l'écart est voulu. La
 * surface de l'API est minuscule et connue : du JSON, deux redirections, des images, et DEUX pages HTML
 * (les erreurs de lien tracé, `src/http/links.ts`). On peut donc la fermer tout de suite. La console, elle,
 * est une application Next entière avec le SDK Meta et Google Sign-In : y poser une CSP enforçante sans
 * observation casserait la connexion des clients, ce qui est exactement le risque que le plan demande
 * d'éviter en commençant par Report-Only.
 *
 * ⚠️ `style-src 'unsafe-inline'` n'est pas une facilité : les pages d'erreur de lien portent leurs styles en
 * attribut `style=`, et sans lui elles s'afficheraient nues à un destinataire qui a cliqué un lien mort.
 * Aucun `script-src` n'est ouvert : ces pages n'ont pas une ligne de JavaScript.
 */

/**
 * ⚠️ FIGÉ ET TESTÉ, parce qu'une CSP se relâche par petites touches. Chaque directive ajoutée ici doit
 * pouvoir se justifier par un chemin réel de l'API ; `tests/entetes-securite.test.ts` interdit les deux
 * relâchements qui vident une CSP de son sens (`script-src 'unsafe-inline'` et `default-src *`).
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
 * Les en-têtes, en une table lisible.
 *
 * `Referrer-Policy: no-referrer` et non `strict-origin-when-cross-origin` : une adresse de l'API porte des
 * identifiants dans son chemin (`/r/<code>/<jeton>` identifie un destinataire), et un référent envoyé au
 * site de destination les lui livrerait. C'est le seul en-tête de cette liste qui ferme une fuite RÉELLE
 * plutôt qu'hypothétique.
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
