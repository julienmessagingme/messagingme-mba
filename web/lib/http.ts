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
 * ⚠️ Ne traduit QUE les replis d'`attempt` (session expirée, « Erreur N », l'incident d'un 5xx) ; ceux de
 * `requestBlob` (« session expirée », « média indisponible ») restent en français. Un message d'erreur venu du
 * serveur (`body.error`) passe tel quel, rédigé en français côté API : c'est la limite connue, notée dans
 * `todo.md`. Seule exception, le corps opaque d'une panne (`OPAQUE_DU_SERVEUR`), remplacé par la phrase
 * traduite de `messageDErreur`.
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
/**
 * Le recul avant de rejouer un GET en echec transitoire.
 *
 * EXPORTE parce qu un test e2e en DERIVE sa fenetre d observation : il attend que la lecture d un reglage
 * ait cesse de bouger, et cette fenetre doit rester plus longue que ce delai. Recopier le nombre la-bas en
 * ferait deux verites, et la seconde deviendrait fausse en silence.
 */
export const RETRY_DELAY_MS = 400;

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

/**
 * Le MÊME appel authentifié, mais qui rend des OCTETS.
 *
 * 🔴 POURQUOI IL FAUT PASSER PAR LÀ POUR ÉCOUTER UN VOCAL OU VOIR UNE PHOTO. Une balise `<audio src="...">`
 * ou `<img src="...">` ne sait pas poser d'en-tête `Authorization` : elle ne peut donc atteindre aucune de nos
 * routes. On récupère les octets ici, et l'écran en fabrique une URL d'objet locale. `request` ne convient
 * pas, il parse du JSON.
 *
 * ⚠️ Aucun rejeu : une pièce jointe pèse jusqu'à 25 Mo (`MEDIA_ENTRANT_TAILLE_MAX_KO` côté serveur), et
 * rejouer un téléchargement raté doublerait la bande passante pour un geste que l'opérateur peut relancer
 * d'un clic.
 */
export async function requestBlob(path: string): Promise<Blob> {
  const session = getSession();
  const headers = new Headers();
  if (session) headers.set('authorization', `Bearer ${session.token}`);
  const res = await fetch(`${BASE}${path}`, { headers });
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, 'session expirée');
  }
  if (!res.ok) {
    /**
     * 🔴 LE CORPS DE L'ERREUR EST LU, PLUS JETÉ (2026-09-19). Le serveur distingue désormais « expiré chez
     * WhatsApp » (410, `media_expire`) de « trop lourd » (422, avec la taille) : un message générique « média
     * indisponible » ferait réessayer un fichier qui ne reviendra jamais.
     */
    const corps = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const msg = typeof corps?.error === 'string' ? corps.error : `média indisponible (${res.status})`;
    throw new ApiError(res.status, msg, corps ?? undefined);
  }
  return res.blob();
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
  if (!res.ok) throw new ApiError(res.status, messageDErreur(res.status, body, langue()), body);
  return body as T;
}

/**
 * Ce que le gestionnaire global de l'API écrit sur SA panne (`CORPS_OPAQUE_5XX`, `src/server.ts`) : opaque, et
 * en anglais. Recopié ici parce que la frontière de build interdit d'importer le serveur ; la parité est tenue
 * par `tests/corps-opaque-parite.test.ts`.
 */
export const OPAQUE_DU_SERVEUR = 'Internal Server Error';

/**
 * LE TEXTE D'UNE RÉPONSE EN ÉCHEC, tel que l'écran l'affichera.
 *
 * 🔴 UN 5xx N'A RIEN À DIRE, ET L'ÉCRAN DOIT QUAND MÊME DIRE QUELQUE CHOSE (2026-09-22). L'API rend
 * « Internal Server Error » sur sa propre panne, délibérément sans détail, et Cloudflare remplace le corps de
 * ses 5xx par une page HTML, qui n'est pas du JSON. L'écran affichait donc « Internal Server Error » ou
 * « Erreur 502 », en anglais pour l'un et sans conduite à tenir pour les deux. Le statut reste dans la phrase :
 * c'est ce qu'un client recopie quand il nous écrit.
 *
 * ⚠️ UNE RAISON QUE LE SERVEUR A VRAIMENT ÉCRITE PASSE TELLE QUELLE, quel que soit le statut : un 503 « non
 * configuré » dit quelque chose que la phrase générique effacerait.
 */
export function messageDErreur(status: number, corps: unknown, lang: Locale): string {
  const ecrit = (corps as { error?: unknown } | null)?.error;
  if (typeof ecrit === 'string' && ecrit.trim() !== '' && ecrit !== OPAQUE_DU_SERVEUR) return ecrit;
  if (status >= 500) {
    return lang === 'en'
      ? `Something went wrong on our side (error ${status}). Try again in a moment.`
      : `Incident de notre côté (erreur ${status}). Réessaie dans un instant.`;
  }
  return lang === 'en' ? `Error ${status}` : `Erreur ${status}`;
}
