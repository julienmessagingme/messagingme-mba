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

/** Préfixe du proxy Next vers l'API. Exporté pour `/ops`, qui appelle sans session (autorité séparée). */
export const BASE = '/api/backend';

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

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const canRetry = RETRYABLE_METHODS.has(method);
  try {
    return await attempt<T>(path, init);
  } catch (err) {
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
    throw new ApiError(res.status, msg);
  }
  return body as T;
}
