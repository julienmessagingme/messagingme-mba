import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CodeApi } from './erreurs';

/**
 * LE GARDE D'USAGE DE L'API PUBLIQUE : ce que le produit compte, et ce qu'il déciderait d'en faire.
 *
 * 🔴 UNE REQUÊTE N'EST PAS UNE UNITÉ DE COÛT, ET C'EST TOUTE LA RAISON DE CE FICHIER. Avec les 60
 * requêtes par minute d'une clé, un intégrateur fait accepter 3 000 contacts (60 lots de 50) ou 3 000
 * destinataires (60 envois de 50) : le plafond de débit ne borne donc pas le travail, il borne la
 * politesse. Ce qui se compte ici est le TRAVAIL demandé.
 *
 * 🔴 PAS DE REDIS, ET LE CHOIX SE FAIT UNE SEULE FOIS. L'implémentation est injectée au bootstrap. Le jour
 * du multi-replica, on remplace le STOCKAGE, pas les routes. **Interdiction de conception : aucun
 * `if (redis)` dans une route.** L'implémentation mémoire n'est pas un brouillon jetable : elle exerce le
 * même contrat et sert aux tests.
 *
 * 🔴 L'IDENTIFIANT DE LA CLÉ, JAMAIS LA CLÉ NI SON EMPREINTE. Ces compteurs sont faits pour être REGARDÉS
 * (par `/ops`, dans un journal, dans un dump) : y faire entrer un secret, même haché, reviendrait à le
 * publier. `api_keys.id` désigne la clé sans rien en révéler, et c'est déjà ce que le limiteur de débit
 * utilise.
 */

/** Les opérations de l'API publique qui coûtent du travail. Fermée : un ajout se voit à la compilation. */
export type OperationApi =
  | 'contacts.upsert'
  | 'contacts.batch'
  // Lire une fiche (`GET /v1/contacts/{contactId}`, `POST /v1/contacts/search`) : une unité, et PAS lourde.
  | 'contacts.read'
  | 'sends.create'
  | 'sends.read'
  // Un texte libre à une personne : `POST /v1/messages/whatsapp` (fenêtre de 24 h) et `POST /v1/messages/rcs`.
  // UNE unité par appel : un message, une personne. Le travail ne dépend pas du corps envoyé.
  | 'messages.send'
  // Une lecture de catalogue (`GET /v1/templates`, `/v1/scenarios`, `/v1/rcs-messages`). UNE unité : le
  // travail ne dépend pas de ce que l'appelant envoie. ⚠️ `/v1/templates` interroge Meta (liste paginée du
  // WABA) : c'est la raison de la compter à part, pour voir une boucle de lectures avant qu'elle coûte.
  | 'catalogues.read'
  | 'mcp.call'
  | 'mcp.refus';

/**
 * CE QU'UNE ROUTE DEMANDE AU GARDE.
 *
 * ⚠️ `unites` EST CALCULÉ PAR LA ROUTE, parce qu'elle seule connaît le corps (50 contacts, 50
 * destinataires). Le garde, lui, ne lit jamais de corps de requête : il compte et il décide.
 */
export interface DemandeUsage {
  tenantId: string;
  /** `api_keys.id`. Jamais la clé, jamais son hash. Cf. le docblock du fichier. */
  cleId: string;
  operation: OperationApi;
  /** Le TRAVAIL demandé, dans l'unité de l'opération. Toujours ≥ 1 : un appel coûte au moins un appel. */
  unites: number;
}

/** Le verdict du garde. `raison` n'est renseignée que sur un refus, et elle est destinée à l'appelant. */
export interface VerdictUsage {
  accepte: boolean;
  raison?: string;
}

/**
 * UN COMPTEUR AGRÉGÉ, tel que `/ops` le montre. Une ligne par (minute, espace, clé, opération).
 *
 * ⚠️ `refusees` EXISTE ALORS QUE RIEN N'EST REFUSÉ AUJOURD'HUI, et ce n'est pas une colonne morte : c'est
 * elle qui dira, le jour où un seuil sera posé, s'il mord sur de vrais clients. Un seuil qu'on active sans
 * pouvoir observer son effet est un seuil qu'on désactivera en panique.
 */
export interface CompteurUsage {
  /** Début de la minute agrégée, en millisecondes depuis l'époque. */
  minute: number;
  tenantId: string;
  cleId: string;
  operation: OperationApi;
  /** Nombre d'APPELS acceptés, et le travail qu'ils demandaient. */
  appels: number;
  unites: number;
  /**
   * Nombre d'appels REFUSÉS, quota d'espace comme place d'opération lourde.
   *
   * 🔴 IL COMPTE LES DEUX DEPUIS L'ESSAI RÉEL DU 2026-09-14, et c'est ce que cet essai a trouvé : un refus
   * de place n'y apparaissait pas, alors que le commentaire du point de passage promettait le contraire.
   * Mesuré en production : dix lots simultanés, cinq refusés en 429, `refusees` à ZÉRO. Pire, les cinq
   * refusés étaient comptés comme ACCEPTÉS, donc les compteurs annonçaient 5 005 unités de travail dont
   * 2 500 n'avaient jamais été faites. Un compteur d'observation qui surcompte le travail et efface les
   * refus est exactement l'inverse de ce qu'il sert à voir.
   */
  refusees: number;
}

/**
 * LIBÉRER UNE PLACE D'OPÉRATION LOURDE. Rendue par `entrerLourde`, appelée quand la réponse est partie.
 *
 * ⚠️ IDEMPOTENTE PAR CONTRAT : elle peut être appelée deux fois (une réponse annulée puis fermée) sans
 * rendre une place de plus que ce qui a été pris. Une place rendue en double, c'est un plafond qui monte
 * tout seul, et ça ne se voit qu'un jour de charge.
 */
export type LiberationLourde = () => void;

export interface ApiUsageGuard {
  /**
   * Compte une demande et dit si elle passe.
   *
   * ⚠️ ELLE COMPTE MÊME QUAND ELLE REFUSE : un refus est précisément ce qu'on veut voir. Les compteurs
   * distinguent les deux (`appels`/`unites` d'un côté, `refusees` de l'autre).
   */
  demander(demande: DemandeUsage): VerdictUsage;
  /** Les compteurs agrégés encore en mémoire, du plus récent au plus ancien. */
  compteurs(): CompteurUsage[];
  /**
   * RÉSERVE UNE PLACE POUR UNE OPÉRATION LOURDE. Rend `null` quand il n'y en a plus.
   *
   * 🔴 LE CHIFFRE QUI REND CETTE PLACE NÉCESSAIRE : le pool sert **8 connexions pour TOUT le process
   * API**, et `ecrireFiches` (`src/api/contacts-v1.ts`, le chemin de `/v1/contacts/batch`) en demande
   * jusqu'à `ECRITURES_EN_VOL` à la fois par requête. Rien ne comptait les requêtes lourdes EN VOL : dix
   * lots simultanés mettent quarante acquisitions en file derrière huit places,
   * échouent au bout de huit secondes, et pendant ce temps l'Inbox et le worker se disputent les mêmes
   * huit emplacements.
   *
   * ⚠️ ET LE LIMITEUR DE DÉBIT NE PROTÈGE PAS DE ÇA : c'est une fenêtre FIXE, donc les 60 requêtes d'une
   * minute peuvent tomber dans la même milliseconde. Dix d'entre elles saturent le pool sans jamais
   * franchir le plafond affiché.
   */
  entrerLourde(): LiberationLourde | null;
  /**
   * NOTE UN REFUS QUE LE GARDE N'A PAS PRONONCÉ LUI-MÊME (aujourd'hui : la place d'opération lourde).
   *
   * ⚠️ ELLE N'AJOUTE NI APPEL NI UNITÉ : un appel refusé n'a pas travaillé. C'est toute la différence avec
   * `demander`, qui compte ce qui est entrepris.
   */
  noterRefus(demande: DemandeUsage): void;
}

/**
 * LE TRAVAIL QUE COÛTE UNE OPÉRATION, en fonction PURE.
 *
 * 🔴 ELLE VIT AVEC LE CONTRAT, PAS AVEC LE STOCKAGE. C'est une règle de PRODUIT (« un lot de 50 contacts
 * coûte 50 »), et la mettre dans l'implémentation mémoire la ferait réécrire le jour où le stockage
 * change, c'est-à-dire au pire moment.
 *
 * ⚠️ LE PLANCHER EST 1, y compris pour un lot vide ou une lecture : un appel qui ne coûterait rien
 * laisserait une boucle d'appels invisible des compteurs, et c'est exactement ce qu'on cherche à voir.
 */
export function unitesDe(operation: OperationApi, taille = 1): number {
  if (operation === 'contacts.batch' || operation === 'sends.create') return Math.max(1, Math.floor(taille));
  return 1;
}

/**
 * DEMANDER AU GARDE, ET REFUSER SI BESOIN, EN UN SEUL GESTE.
 *
 * ⚠️ ELLE N'EST PLUS EXPORTÉE (revue du 2026-09-14) : les routes qui comptent passent par `compterOuRefuser` juste
 * en dessous, et un symbole exporté que personne n'importe finit par être appelé de travers, sans la
 * résolution d'identité que l'autre fait.
 *
 * 🔴 POINT DE PASSAGE UNIQUE DES ROUTES PUBLIQUES. Recopié dans chacune, le couple « compter puis refuser »
 * finirait par diverger : une route qui compte sans refuser, ou qui refuse en 500 au lieu de 429, et
 * personne ne le verrait avant l'incident. C'est le motif qui a déjà coûté cher ici avec les en-têtes de
 * débit, recopiés trois fois avant d'être rassemblés dans `consommerAvecEntetes`.
 *
 * ⚠️ LE REFUS EST UN 429, JAMAIS UN 5xx : Cloudflare remplace le corps de toute réponse 5xx par sa page,
 * donc l'intégrateur ne verrait même pas ce qu'on lui reproche.
 *
 * ⚠️ `import type` UNIQUEMENT : ce fichier ne dépend d'aucun runtime HTTP, exactement comme
 * `rate-limit.ts`. C'est ce qui le garde chargeable depuis n'importe quel contexte, tests compris.
 */
async function demanderOuRefuser(
  usage: ApiUsageGuard,
  reply: FastifyReply,
  demande: DemandeUsage,
): Promise<boolean> {
  const verdict = usage.demander(demande);
  if (verdict.accepte) return true;
  await reply.code(429).send({ error: verdict.raison ?? 'quota d’usage atteint', code: 'rate_limited' satisfies CodeApi });
  return false;
}

/**
 * LES OPÉRATIONS QUI PÈSENT SUR LE POOL, et elles seules.
 *
 * ⚠️ UNE LECTURE N'EST PAS LOURDE : `sends.read` fait une requête, `mcp.call` en fait quelques-unes. Les
 * soumettre à ce plafond ferait refuser une consultation pendant qu'un lot écrit, ce qui transformerait
 * une protection du pool en panne d'écran.
 */
const LOURDES: ReadonlySet<OperationApi> = new Set<OperationApi>(['contacts.batch', 'sends.create']);

/** Cette opération pèse-t-elle sur le pool au point de mériter une place ? */
export function estLourde(operation: OperationApi): boolean {
  return LOURDES.has(operation);
}

/**
 * COMPTER LE TRAVAIL D'UNE REQUÊTE AUTHENTIFIÉE, EN UN SEUL APPEL.
 *
 * 🔴 ELLE EXISTE PARCE QUE LES ROUTES PUBLIQUES RECOPIAIENT LE MÊME OBJET (relevé en revue), dont le repli
 * `req.apiKeyId ?? 'inconnue'`. Une copie du repli par route, c'est autant d'endroits où il peut diverger, et
 * surtout un compteur qui se rangerait sous « inconnue » sans que personne ne se demande pourquoi.
 *
 * ⚠️ ELLE REND `false` SI LA REQUÊTE N'EST PAS AUTHENTIFIÉE, sans rien compter : on ne mesure pas ce
 * qu'on a refusé à la porte, sinon les compteurs mélangeraient l'usage d'un client et le bruit d'un
 * robot, et un seuil posé plus tard mordrait sur le mauvais.
 */
/**
 * RÉSERVER UNE PLACE LOURDE, ET LA RENDRE QUAND LA RÉPONSE EST PARTIE.
 *
 * 🔴 LA LIBÉRATION EST ACCROCHÉE À LA RÉPONSE, PAS À UN `finally` DE HANDLER, et c'est ce qui la rend
 * sûre : le handler de `/v1/sends` fait deux cents lignes et plusieurs sorties anticipées, donc un
 * `finally` y serait un invariant à tenir à la main. Une place qui fuit ne se voit pas tout de suite :
 * elle rétrécit le plafond jusqu'à ce que plus aucune requête lourde ne passe, et le redémarrage efface
 * la preuve.
 *
 * ⚠️ `Retry-After` EST POSÉ, parce qu'un 429 sans lui fait réessayer tout de suite, donc redemander la
 * place qui vient d'être refusée. C'est la même règle que sur les plafonds de débit.
 */
async function reserverPlaceLourde(
  usage: ApiUsageGuard,
  req: FastifyRequest,
  reply: FastifyReply,
  demande: DemandeUsage,
): Promise<boolean> {
  const liberer = usage.entrerLourde();
  if (!liberer) {
    // 🔴 LE REFUS EST NOTÉ AVANT D'ÊTRE RENDU : sans cela, une saturation ne laisse pour trace qu'un 429
    // chez l'appelant, et rien du tout chez nous. Mesuré en production le 2026-09-14.
    usage.noterRefus(demande);
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
    // ⚠️ « inconnue » NE DEVRAIT JAMAIS ARRIVER : le préhandler pose `apiKeyId` en même temps que
    // `req.auth`. Le repli est là pour que le compteur reste honnête si un jour une route est montée
    // derrière une AUTRE autorité, plutôt que de mentir sur l'identité de la clé.
    cleId: req.apiKeyId ?? 'inconnue',
    operation,
    unites: unitesDe(operation, taille),
  };
  /**
   * 🔴 LA PLACE SE PREND AVANT LE COMPTAGE, ET L'ORDRE A ÉTÉ INVERSÉ APRÈS L'ESSAI RÉEL DU 2026-09-14.
   * Il était l'inverse, avec un commentaire qui affirmait qu'un refus de place « apparaîtrait dans les
   * compteurs ». Il n'y apparaissait pas : le comptage avait déjà eu lieu, donc l'appel était enregistré
   * comme ACCEPTÉ avec tout son travail, puis refusé. Dix lots simultanés en production ont montré cinq
   * refus, `refusees` à zéro, et 2 500 unités comptées pour du travail jamais fait.
   *
   * ⚠️ UNE PLACE PRISE EST RENDUE MÊME SI LE QUOTA REFUSE ENSUITE : la libération est accrochée à la
   * réponse dès l'obtention, donc elle part avec elle quel que soit le verdict.
   */
  if (estLourde(operation) && !(await reserverPlaceLourde(usage, req, reply, demande))) return false;
  return demanderOuRefuser(usage, reply, demande);
}
