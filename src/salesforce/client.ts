import { z } from 'zod';
import { fetchPublic, estRedirectionRefusee, estRefusAdresseInterne } from '../lib/connexion-publique';
import { lireCorpsBorne } from '../lib/corps-borne';
import { parseRetryAfter, withRetry, type RetryOpts } from '../meta/http';
import { lireMyDomain } from './my-domain';

/**
 * LE CLIENT REST SALESFORCE (plan 2026-09-26, lot L1) : un jeton par org, et des appels à l'API de cette org.
 *
 * 🔴 L'ADRESSE DE L'ORG EST SAISIE PAR UN CLIENT : chaque appel passe par `fetchPublic` (la socket s'ouvre sur ce
 * qui a été vérifié), avec `redirect: 'error'`, un plafond de temps, et une lecture BORNÉE du corps. Ce fichier est
 * dans l'inventaire de `tests/lib-adresse-privee.test.ts`, qui y interdit tout `fetch(` nu.
 *
 * 🔴 L'IDENTITÉ EST L'UTILISATEUR D'INTÉGRATION DU CLIENT, en client credentials (décision de Julien) : notre clé
 * d'app (`SALESFORCE_CLIENT_ID` / `_SECRET`, variables du serveur) demande un jeton À L'ORG DU CLIENT, qui le rend au
 * nom de l'utilisateur que son admin a désigné « Run As ». Aucun jeton de rafraîchissement, aucune personne attachée.
 * La réponse ne porte pas forcément de durée : le jeton est gardé jusqu'à ce que Salesforce le refuse
 * (`INVALID_SESSION_ID`), et on en redemande UN, une seule fois, avant de rendre l'erreur.
 *
 * ⚠️ LE CLASSEMENT SE FAIT SUR LE CODE DE SALESFORCE, PAS SUR LE STATUT : `UNABLE_TO_LOCK_ROW` arrive en 400 et
 * passe au rejeu suivant, `REQUEST_LIMIT_EXCEEDED` (le quota du jour du client) arrive en 403 et ne se rejoue PAS
 * dans la minute. Et un refus d'adresse interne ou une redirection lèvent le même « fetch failed » qu'une panne
 * réseau, que `withRetry` rejouerait : on les reconnaît AVANT, et ils sont définitifs.
 *
 * ⚠️ LE QUOTA EST CELUI DU CLIENT : l'en-tête `Sforce-Limit-Info` (« api-usage=18/15000 ») est relu à chaque
 * réponse et remis à `noterQuota`, qui décide quoi en faire (l'écrire, ralentir).
 */

/** La version de l'API. Mesurée au lot L0 sur de vraies orgs (`docs/salesforce-mesures-2026-09.md`). */
export const VERSION_API_SALESFORCE = 'v67.0';

/** Plafond de temps d'un appel. Une org qui ne répond pas en 20 s ne répondra pas mieux après. */
const DELAI_APPEL_MS = 20_000;

/**
 * Plafond d'un corps de réponse, en octets. Une page de requête SOQL rend jusqu'à 2 000 enregistrements, un
 * rapport jusqu'à 2 000 lignes de détail : 8 Mo les couvre avec une large marge, sans laisser une réponse
 * démesurée remplir la mémoire.
 */
const MAX_OCTETS_REPONSE = 8 * 1024 * 1024;

export type CodeErreurSalesforce =
  | 'jeton_refuse'
  | 'adresse_interne'
  | 'adresse_changee'
  | 'injoignable'
  | 'reponse_illisible'
  | 'reponse_trop_grosse'
  | 'quota_epuise'
  | 'passager'
  | 'refus';

/**
 * Une erreur de Salesforce ou du chemin vers lui. `retryable` est lu par `withRetry` ; `errorCode` est le code
 * de Salesforce quand il en a donné un (`REQUIRED_FIELD_MISSING`, `DUPLICATES_DETECTED`...).
 */
export class SalesforceApiError extends Error {
  constructor(
    readonly code: CodeErreurSalesforce,
    readonly status: number | null,
    readonly retryable: boolean,
    message: string,
    readonly errorCode: string | null = null,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SalesforceApiError';
  }
}

export interface JetonSalesforce {
  accessToken: string;
  /** L'origine où parler à l'API, VÉRIFIÉE égale à celle qu'on a appelée. */
  origine: string;
  orgId: string | null;
  userId: string | null;
}

export interface QuotaSalesforce {
  utilise: number;
  max: number;
}

export interface DepsClientSalesforce {
  clientId: string;
  clientSecret: string;
  /** `fetchPublic` par défaut ; injectable pour les tests. */
  fetchImpl?: typeof fetch;
  retry?: RetryOpts;
  delaiMs?: number;
  maxOctets?: number;
  noterQuota?: (origine: string, quota: QuotaSalesforce) => void;
}

export type MethodeHttp = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ClientSalesforce {
  /** Un jeton pour l'org de cette origine, pris dans le cache du process ou demandé. */
  jeton(origine: string): Promise<JetonSalesforce>;
  oublierJeton(origine: string): void;
  /**
   * Un appel à l'API de l'org. `chemin` commence par `/` (par exemple `/services/data/v67.0/limits`). Le corps de
   * réponse est lu par `schema` (`safeParse`) ; un 204 rend `donnees: null`.
   */
  requete<T>(origine: string, methode: MethodeHttp, chemin: string, schema: z.ZodType<T>, corps?: unknown, entetes?: Record<string, string>): Promise<{ statut: number; donnees: T | null }>;
}

const schemaJeton = z.object({
  access_token: z.string().min(1),
  instance_url: z.string().min(1),
  id: z.string().optional(),
});

/** L'identité rendue avec le jeton : `https://login.salesforce.com/id/<orgId>/<userId>`. */
const ID_RE = /\/id\/(00D[0-9A-Za-z]{12,15})\/(005[0-9A-Za-z]{12,15})$/;

const schemaErreursRest = z.array(z.object({ message: z.string().optional(), errorCode: z.string().optional() }).passthrough());
const schemaErreurOAuth = z.object({ error: z.string(), error_description: z.string().optional() }).passthrough();

/** Les codes de Salesforce qu'un rejeu un peu plus tard fait passer. */
const CODES_PASSAGERS = new Set(['UNABLE_TO_LOCK_ROW', 'SERVER_UNAVAILABLE', 'QUERY_TIMEOUT']);

/** Lit « api-usage=18/15000 » dans `Sforce-Limit-Info`. */
export function lireQuota(entete: string | null): QuotaSalesforce | null {
  const m = entete ? /api-usage=(\d+)\/(\d+)/.exec(entete) : null;
  return m ? { utilise: Number(m[1]), max: Number(m[2]) } : null;
}

function entetesDe(res: Response): Record<string, string> {
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return h;
}

export function creerClientSalesforce(deps: DepsClientSalesforce): ClientSalesforce {
  const fetchImpl = deps.fetchImpl ?? fetchPublic;
  const delaiMs = deps.delaiMs ?? DELAI_APPEL_MS;
  const maxOctets = deps.maxOctets ?? MAX_OCTETS_REPONSE;
  const jetons = new Map<string, JetonSalesforce>();
  const enVol = new Map<string, Promise<JetonSalesforce>>();

  /** Un appel HTTP brut : corps lu, borné, et les refus d'adresse classés DÉFINITIFS avant tout rejeu. */
  async function appeler(url: string, init: RequestInit): Promise<{ res: Response; texte: string }> {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(delaiMs) });
    } catch (err) {
      if (estRefusAdresseInterne(err)) {
        throw new SalesforceApiError('adresse_interne', null, false, "L'adresse de l'org mène à une adresse interne : connexion refusée.");
      }
      if (estRedirectionRefusee(err)) {
        throw new SalesforceApiError('adresse_changee', null, false, "L'adresse de l'org a changé (Salesforce redirige ailleurs) : reconnectez l'org avec sa nouvelle adresse.");
      }
      throw new SalesforceApiError('injoignable', null, true, "L'org Salesforce ne répond pas.");
    }
    const corps = await lireCorpsBorne(res, maxOctets);
    if (corps.trop_gros) throw new SalesforceApiError('reponse_trop_grosse', res.status, false, 'La réponse de Salesforce dépasse la taille admise.');
    if (corps.casse) throw new SalesforceApiError('injoignable', res.status, true, 'La réponse de Salesforce a été coupée en cours de route.');
    const quota = lireQuota(res.headers.get('sforce-limit-info'));
    if (quota && deps.noterQuota) deps.noterQuota(new URL(url).origin, quota);
    return { res, texte: corps.texte };
  }

  function lireJson(texte: string): unknown {
    if (texte === '') return null;
    try { return JSON.parse(texte); } catch { return undefined; }
  }

  async function demanderJeton(origine: string): Promise<JetonSalesforce> {
    const corps = new URLSearchParams({ grant_type: 'client_credentials', client_id: deps.clientId, client_secret: deps.clientSecret });
    const { res, texte } = await withRetry(async () => {
      const r = await appeler(`${origine}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: corps.toString(),
      });
      if (r.res.status === 429 || r.res.status >= 500) {
        throw new SalesforceApiError('passager', r.res.status, true, 'Salesforce ne délivre pas de jeton pour le moment.', null, parseRetryAfter(entetesDe(r.res)));
      }
      return r;
    }, deps.retry);
    const json = lireJson(texte);
    if (!res.ok) {
      const e = schemaErreurOAuth.safeParse(json);
      // Le message de Salesforce reste dans `errorCode` ; la raison lisible ne cite rien de ce qu'il a renvoyé.
      throw new SalesforceApiError('jeton_refuse', res.status, false, "L'org a refusé de délivrer un jeton à Messaging Me.", e.success ? e.data.error : null);
    }
    const p = schemaJeton.safeParse(json);
    if (!p.success) throw new SalesforceApiError('reponse_illisible', res.status, false, "La réponse du jeton n'a pas la forme attendue.");
    // 🔴 L'adresse rendue par le jeton est une donnée EXTERNE : elle doit désigner la même org, sinon on
    // enverrait le jeton ailleurs.
    const instance = lireMyDomain(p.data.instance_url);
    if (!instance.ok || instance.origine !== origine) {
      throw new SalesforceApiError('reponse_illisible', res.status, false, "Le jeton désigne une autre adresse que celle de l'org.");
    }
    const id = p.data.id ? ID_RE.exec(p.data.id) : null;
    return { accessToken: p.data.access_token, origine, orgId: id?.[1] ?? null, userId: id?.[2] ?? null };
  }

  const client: ClientSalesforce = {
    async jeton(origine) {
      const connu = jetons.get(origine);
      if (connu) return connu;
      const vol = enVol.get(origine);
      if (vol) return vol;
      const p = demanderJeton(origine)
        .then((j) => { jetons.set(origine, j); return j; })
        .finally(() => enVol.delete(origine));
      enVol.set(origine, p);
      return p;
    },

    oublierJeton(origine) {
      jetons.delete(origine);
    },

    async requete(origine, methode, chemin, schema, corps, entetes) {
      if (!chemin.startsWith('/')) throw new Error('chemin Salesforce sans « / » initial');
      const unAppel = async (jeton: JetonSalesforce) => withRetry(async () => {
        const { res, texte } = await appeler(`${origine}${chemin}`, {
          method: methode,
          headers: {
            authorization: `Bearer ${jeton.accessToken}`,
            accept: 'application/json',
            ...(corps !== undefined ? { 'content-type': 'application/json' } : {}),
            ...entetes,
          },
          ...(corps !== undefined ? { body: JSON.stringify(corps) } : {}),
        });
        const json = lireJson(texte);
        if (res.ok) {
          if (res.status === 204 || json === null) return { statut: res.status, donnees: null };
          const p = schema.safeParse(json);
          if (!p.success) throw new SalesforceApiError('reponse_illisible', res.status, false, "La réponse de Salesforce n'a pas la forme attendue.");
          return { statut: res.status, donnees: p.data };
        }
        const erreurs = schemaErreursRest.safeParse(json);
        const premier = erreurs.success ? erreurs.data[0] : undefined;
        const errorCode = premier?.errorCode ?? null;
        const message = premier?.message ?? `Salesforce a répondu ${res.status}.`;
        const retryAfterMs = parseRetryAfter(entetesDe(res));
        if (errorCode === 'INVALID_SESSION_ID' || res.status === 401) {
          throw new SalesforceApiError('jeton_refuse', res.status, false, 'Le jeton a été refusé par Salesforce.', errorCode);
        }
        if (errorCode === 'REQUEST_LIMIT_EXCEEDED') {
          throw new SalesforceApiError('quota_epuise', res.status, false, "Le quota d'appels à l'API de l'org est épuisé pour la journée.", errorCode);
        }
        if (res.status === 429 || res.status >= 500 || (errorCode !== null && CODES_PASSAGERS.has(errorCode))) {
          throw new SalesforceApiError('passager', res.status, true, message, errorCode, retryAfterMs);
        }
        throw new SalesforceApiError('refus', res.status, false, message, errorCode);
      }, deps.retry);

      const jeton = await client.jeton(origine);
      try {
        return await unAppel(jeton);
      } catch (err) {
        // UN seul nouveau jeton : la session a pu expirer côté Salesforce. Un second refus est réel.
        if (err instanceof SalesforceApiError && err.code === 'jeton_refuse') {
          client.oublierJeton(origine);
          return unAppel(await client.jeton(origine));
        }
        throw err;
      }
    },
  };
  return client;
}
