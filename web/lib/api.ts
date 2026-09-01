'use client';

/**
 * POINT D'ENTREE des appels API de la console. Ne contient plus de code : il reexporte les modules par
 * domaine de `lib/api/`.
 *
 * 🔴 Pourquoi un barrel plutot qu'un deplacement des imports. Soixante-sept fichiers importent d'ici. Les
 * reecrire aurait melange, dans un meme diff, un deplacement de code et soixante-sept modifications d'appel :
 * plus personne n'aurait pu relire l'un sans l'autre. Le barrel garde le decoupage VERIFIABLE (rien ne change
 * pour les appelants) et laisse les imports se preciser au fil de l'eau, fichier par fichier.
 *
 * `ApiError` et `SESSION_EXPIRED_EVENT` viennent du socle HTTP et sont reexportes ici depuis toujours.
 */

export { ApiError, SESSION_EXPIRED_EVENT } from './http';
export * from './api/auth';
export * from './api/contacts';
export * from './api/campagnes';
export * from './api/templates';
export * from './api/inbox';
export * from './api/stats';
export * from './api/compte';
export * from './api/scenarios';
export * from './api/integrations';
