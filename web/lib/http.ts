'use client';

/**
 * Socle HTTP de la console : une seule porte vers l'API, partagée par tous les modules d'appels par domaine.
 *
 * Il vivait dans `api.ts` et y était module-privé, ce qui obligeait tout nouveau module d'API soit à vivre dans
 * ce fichier de 1300 lignes, soit à redéclarer l'authentification, le retry et la gestion du 401. Deux copies
 * de la règle « une 401 vide la session et prévient la coquille » finiraient par diverger en silence.
 */

import { getSession, clearSession } from './session';
import { LOCALE_STORAGE_KEY, type Locale } from './locale';

/**
 * OÙ VIT L'API, VUE DU NAVIGATEUR. Exporté pour `/ops`, qui appelle sans session (autorité séparée).
 *
 * 🔴 DEUX MONDES, ET UN SEUL ENDROIT QUI LE SAIT (bascule Vercel, `docs/PLAN-BASCULE-VERCEL-2026-09-03.md`).
 *
 * Sans `NEXT_PUBLIC_API_URL`, on garde `/api/backend` : le navigateur appelle la MÊME origine que la page, le
 * serveur Next relaie vers l'API, et il n'y a aucune requête d'origine croisée, donc aucun CORS. C'est le
 * montage du VPS, et il reste juste tant qu'il tourne.
 *
 * Avec la variable, le navigateur parle DIRECTEMENT à l'API, sous son propre nom. Le préfixe disparaît :
 * il appartenait au proxy, pas aux routes. L'API doit alors inscrire cette origine dans son `CORS_ORIGINS`,
 * sans quoi le navigateur refusera chaque appel.
 *
 * ⚠️ `NEXT_PUBLIC_*` est FIGÉ AU BUILD. Changer cette variable sur Vercel n'a d'effet qu'au déploiement
 * suivant : la modifier sans redéployer ne fait rien du tout, en silence.
 */
export const BASE = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '') || '/api/backend';

/**
 * Langue de la console, lue à la SOURCE persistée plutôt que par le contexte React.
 *
 * `useT()` est un hook : inappelable ici, et ce module est appelé depuis des fonctions ordinaires. Or les
 * messages jetés ici remontent partout via `err.message` et s'affichaient en français sur une console en
 * anglais. En cas de doute on retombe sur le français, jamais sur une erreur.
 *
 * ⚠️ Ne traduit QUE les deux replis de ce fichier. Un message d'erreur venu du serveur (`body.error`) passe
 * tel quel : il est rédigé en français côté API. C'est la limite connue, notée dans `todo.md`.
 */
function langue(): Locale {
  if (typeof window === 'undefined') return 'fr';
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY) === 'en' ? 'en' : 'fr';
  } catch {
    return 'fr';
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /**
     * Le corps de la réponse, tel quel.
     *
     * Certaines routes rendent une erreur STRUCTURÉE en plus de son message : le blocage d'activation d'un
     * agent liste ce qui manque et dans quel onglet le corriger. Sans ce champ, l'écran ne pourrait afficher
     * que « agent incomplet », c'est-à-dire un refus sans mode d'emploi.
     */
    public readonly corps?: unknown,
  ) {
    super(message);
  }
}

/**
 * Événement « la session vient d'expirer », émis dès qu'une réponse 401 a vidé la session locale. Écouté par
 * `AppShell`, qui affiche alors une bannière avec un bouton de reconnexion.
 */
export const SESSION_EXPIRED_EVENT = 'mba:session-expired';

/**
 * Un 5xx sur une LECTURE est très majoritairement transitoire (pool Postgres saturé une fraction de seconde,
 * conteneur qui vient de redémarrer). Une seule reprise, après une courte pause, évite d'infliger un écran
 * d'erreur pour un hoquet. On ne rejoue QUE les requêtes idempotentes : rejouer un POST enverrait des messages
 * WhatsApp en double, ce qu'aucun gain d'ergonomie ne justifie.
 */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD']);
const RETRY_DELAY_MS = 400;

/**
 * Cette erreur est-elle une ANNULATION voulue (`AbortController`), et non une panne ?
 *
 * 🔴 La distinction n'est pas cosmétique : un appelant qui la confond affiche un bandeau rouge chaque fois
 * qu'on quitte un écran, puisque quitter l'écran EST ce qui a annulé la requête. Exporté pour que chaque
 * appelant puisse l'ignorer explicitement, plutôt que d'attraper « toutes les erreurs » et de se taire.
 */
export function estAnnulation(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const canRetry = RETRYABLE_METHODS.has(method);
  try {
    return await attempt<T>(path, init);
  } catch (err) {
    // ⚠️ Une requête ANNULÉE ne se rejoue pas. Sans cette ligne, le retry repartait avec le MÊME signal, déjà
    // avorté : il échouait aussitôt, après avoir attendu la pause pour rien, et l'appelant recevait son
    // erreur 400 ms plus tard. Une annulation n'est pas un hoquet réseau, c'est une décision de l'écran.
    if (estAnnulation(err)) throw err;
    const transient = err instanceof ApiError ? err.status >= 500 : true; // panne réseau -> pas d'ApiError
    if (!canRetry || !transient) throw err;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return attempt<T>(path, init);
  }
}

async function attempt<T>(path: string, init: RequestInit): Promise<T> {
  const session = getSession();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (session) headers.set('authorization', `Bearer ${session.token}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    clearSession();
    // Prévient la coquille (AppShell) pour qu'elle propose un bouton « Reconnecter ». Sans ça, l'écran affichait
    // un message rouge dans un coin, le reste de l'interface restait actif, et l'utilisateur n'avait AUCUN
    // chemin visible vers la reconnexion. Même canal d'événement que la pastille de non-lus.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError(401, langue() === 'en' ? 'Session expired, sign in again.' : 'Session expirée, reconnecte-toi.');
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error
      ?? (langue() === 'en' ? `Error ${res.status}` : `Erreur ${res.status}`);
    throw new ApiError(res.status, msg, body);
  }
  return body as T;
}
