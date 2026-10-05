import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CodeApi } from './erreurs';

/**
 * Le garde d'usage de l'API publique : ce que le produit compte, et ce qu'il déciderait d'en faire.
 *
 * Une requête n'est pas une unité de coût : avec 60 requêtes par minute, une clé fait accepter 3 000
 * contacts (60 lots de 50). Le plafond de débit borne la politesse ; ici se compte le travail demandé.
 *
 * Pas de Redis : l'implémentation est injectée au bootstrap (`GardeUsage`, `usage-guard.compteur.ts`), et elle
 * compte dans le compteur de débit PARTAGÉ par les copies de l'API (`src/db/debit.ts`) : `/ops/usage` montre le
 * total de toutes les copies. Aucune route ne connaît le stockage (aucun `if (redis)` dans une route).
 * 🔴 L'identifiant de la clé, jamais la clé ni son empreinte : ces compteurs sont faits pour être regardés (`/ops`,
 * journal, dump), un secret même haché y serait publié.
 */

/** Les opérations de l'API publique qui coûtent du travail. Fermée : un ajout se voit à la compilation. */
export type OperationApi =
  | 'contacts.upsert'
  | 'contacts.batch'
  // Lire une fiche (`GET /v1/contacts/{contactId}`, `POST /v1/contacts/search`) : une unité, pas lourde.
  | 'contacts.read'
  | 'sends.create'
  | 'sends.read'
  // Un texte libre à une personne (`POST /v1/messages/whatsapp` et `/rcs`) : une unité par appel.
  | 'messages.send'
  // Une lecture de catalogue (`/v1/templates`, `/v1/scenarios`, `/v1/rcs-messages`) : une unité, comptée à
  // part parce que `/v1/templates` interroge Meta, pour voir une boucle de lectures avant qu'elle coûte.
  | 'catalogues.read'
  | 'mcp.call'
  | 'mcp.refus';

/**
 * Ce qu'une route demande au garde. `unites` est calculé par la route, seule à connaître le corps : le garde
 * ne lit jamais de corps de requête.
 */
export interface DemandeUsage {
  tenantId: string;
  /** `api_keys.id`, ou `oauth:<oauth_autorisations.id>` pour un jeton OAuth. Jamais la clé ni le jeton, jamais leur hash. */
  cleId: string;
  operation: OperationApi;
  /** Le travail demandé, dans l'unité de l'opération. Toujours ≥ 1 : un appel coûte au moins un appel. */
  unites: number;
}

/**
 * Le verdict du garde. `raison` n'est renseignée que sur un refus, et elle est destinée à l'appelant. Un refus de
 * quota quotidien porte son code et l'attente jusqu'à sa remise à zéro ; les autres sont des `rate_limited` d'une minute.
 */
export interface VerdictUsage {
  accepte: boolean;
  raison?: string;
  quota?: { attenteMs: number };
}

/**
 * Un compteur agrégé, tel que `/ops` le montre : une ligne par (minute, espace, clé, opération). `refusees` dit si un
 * quota ou une place lourde mord sur de vrais clients.
 */
export interface CompteurUsage {
  /** Début de la minute agrégée, en millisecondes depuis l'époque. */
  minute: number;
  tenantId: string;
  cleId: string;
  operation: OperationApi;
  /** Nombre d'appels acceptés, et le travail qu'ils demandaient. */
  appels: number;
  unites: number;
  /** Nombre d'appels refusés, quota d'espace comme place d'opération lourde ; un refus n'ajoute rien à
   *  `appels` ni à `unites`. */
  refusees: number;
}

/**
 * Libère une place d'opération lourde, rendue par `entrerLourde` et appelée quand la réponse est partie.
 * Idempotente : appelée deux fois (réponse annulée puis fermée), elle ne rend pas une place de plus, sinon le
 * plafond monterait tout seul.
 */
export type LiberationLourde = () => void;

export interface ApiUsageGuard {
  /**
   * Compte une demande et dit si elle passe. Elle compte même quand elle refuse (`refusees` d'un côté,
   * `appels`/`unites` de l'autre) : un refus est ce qu'on veut voir. Ne lève pas : un compteur muet laisse passer.
   */
  demander(demande: DemandeUsage): Promise<VerdictUsage>;
  /** Les compteurs agrégés encore gardés, de toutes les copies de l'API, du plus récent au plus ancien. */
  compteurs(): Promise<CompteurUsage[]>;
  /**
   * Réserve une place pour une opération lourde ; `null` quand il n'y en a plus. Le pool (`DB_POOL_MAX` de
   * `mba-api`, `docker-compose.yml`) sert tout le process API, et `/v1/contacts/batch` en demande jusqu'à `ECRITURES_EN_VOL` par requête : dix
   * lots simultanés satureraient le pool, Inbox et worker compris. Le limiteur de débit n'y suffit pas :
   * fenêtre fixe, ses 60 requêtes peuvent tomber dans la même milliseconde.
   * 🔴 PAR COPIE, délibérément et seul de ce garde à l'être : ce qu'il protège est le pool DE LA COPIE, que chaque
   * copie a pour elle seule. Le compter au total ne protégerait rien de plus et diviserait la capacité par le
   * nombre de copies.
   */
  entrerLourde(): LiberationLourde | null;
  /**
   * Note un refus que le garde n'a pas prononcé lui-même (la place d'opération lourde). N'ajoute ni appel ni
   * unité : un appel refusé n'a pas travaillé. Ne lève pas.
   */
  noterRefus(demande: DemandeUsage): Promise<void>;
}

/**
 * Le travail que coûte une opération, en fonction pure, avec le contrat plutôt qu'avec le stockage : c'est
 * une règle de produit (« un lot de 50 contacts coûte 50 »). Plancher à 1, même pour un lot vide : un appel
 * qui ne coûterait rien laisserait une boucle d'appels invisible des compteurs.
 */
export function unitesDe(operation: OperationApi, taille = 1): number {
  if (operation === 'contacts.batch' || operation === 'sends.create') return Math.max(1, Math.floor(taille));
  return 1;
}

/**
 * Demander au garde, et refuser si besoin, en un seul geste, sous `compterOuRefuser`. Le refus est un 429,
 * jamais un 5xx : Cloudflare remplace le corps de toute réponse 5xx par sa page. `import type` uniquement :
 * ce fichier ne dépend d'aucun runtime HTTP, chargeable depuis les tests.
 */
async function demanderOuRefuser(
  usage: ApiUsageGuard,
  reply: FastifyReply,
  demande: DemandeUsage,
): Promise<boolean> {
  const verdict = await usage.demander(demande);
  if (verdict.accepte) return true;
  if (verdict.quota) {
    // Sans `retry-after`, un client réessaie aussitôt, et un quota du jour se rejouerait toute la nuit. Les en-têtes
    // `x-ratelimit-*` posés par le plafond d'appels décrivent la MINUTE : laissés ici, ils diraient de réessayer dans la
    // minute, à côté d'un `retry-after` de plusieurs heures.
    for (const e of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) reply.removeHeader(e);
    reply.header('retry-after', String(Math.max(1, Math.ceil(verdict.quota.attenteMs / 1000))));
    await reply.code(429).send({ error: verdict.raison ?? 'quota quotidien atteint', code: 'quota_exceeded' satisfies CodeApi });
    return false;
  }
  await reply.code(429).send({ error: verdict.raison ?? 'quota d’usage atteint', code: 'rate_limited' satisfies CodeApi });
  return false;
}

/**
 * Les opérations qui pèsent sur le pool, et elles seules. Une lecture n'est pas lourde : la soumettre à ce
 * plafond ferait refuser une consultation pendant qu'un lot écrit.
 */
const LOURDES: ReadonlySet<OperationApi> = new Set<OperationApi>(['contacts.batch', 'sends.create']);

/** Cette opération pèse-t-elle sur le pool au point de mériter une place ? */
export function estLourde(operation: OperationApi): boolean {
  return LOURDES.has(operation);
}

/**
 * Réserve une place lourde, et la rend quand la réponse est partie : la libération est accrochée à la
 * réponse, pas à un `finally` de handler (plusieurs sorties anticipées), sinon une place qui fuit rétrécit
 * le plafond jusqu'à ce que plus rien ne passe. `Retry-After` est posé : un 429 sans lui fait réessayer tout
 * de suite.
 */
async function reserverPlaceLourde(
  usage: ApiUsageGuard,
  req: FastifyRequest,
  reply: FastifyReply,
  demande: DemandeUsage,
): Promise<boolean> {
  const liberer = usage.entrerLourde();
  if (!liberer) {
    // Le refus est noté avant d'être rendu : sinon une saturation ne laisse de trace que chez l'appelant.
    await usage.noterRefus(demande);
    reply.header('retry-after', '2');
    await reply.code(429).send({ error: 'trop d’opérations lourdes en cours sur cette instance, réessayez dans un instant', code: 'rate_limited' satisfies CodeApi });
    return false;
  }
  reply.raw.on('close', liberer);
  return true;
}

export async function compterOuRefuser(
  usage: ApiUsageGuard,
  req: FastifyRequest,
  reply: FastifyReply,
  operation: OperationApi,
  taille = 1,
): Promise<boolean> {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) {
    await reply.code(401).send({ error: 'clé d’API requise', code: 'unauthorized' satisfies CodeApi });
    return false;
  }
  const demande: DemandeUsage = {
    tenantId,
    // « inconnue » ne devrait jamais arriver (le préhandler pose `apiAcces` avec `req.auth`) : le repli garde
    // le compteur honnête si une route est un jour montée derrière une autre autorité. Un jeton OAuth est rangé
    // sous son autorisation, préfixée (`oauth:<id>`) : jamais confondue avec une clé, et sans `|`, que la clé du
    // compteur réserve.
    cleId: req.apiAcces ? (req.apiAcces.type === 'cle' ? req.apiAcces.id : `oauth:${req.apiAcces.id}`) : 'inconnue',
    operation,
    unites: unitesDe(operation, taille),
  };
  /**
   * Point de passage unique des routes publiques : une requête non authentifiée rend `false` sans rien compter
   * (le bruit d'un robot n'est pas l'usage d'un client). La place se prend avant le comptage : un appel refusé
   * faute de place ne doit pas être compté accepté avec tout son travail. Une place prise est rendue même si
   * le quota refuse ensuite, la libération partant avec la réponse.
   */
  if (estLourde(operation) && !(await reserverPlaceLourde(usage, req, reply, demande))) return false;
  return demanderOuRefuser(usage, reply, demande);
}
