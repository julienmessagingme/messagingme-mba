import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * LE GARDE D'USAGE DE L'API PUBLIQUE : ce que le produit compte, et ce qu'il déciderait d'en faire.
 *
 * 🔴 UNE REQUÊTE N'EST PAS UNE UNITÉ DE COÛT, ET C'EST TOUTE LA RAISON DE CE FICHIER. Avec les 60
 * requêtes par minute d'une clé, un intégrateur fait accepter 30 000 contacts (60 lots de 500) ou 3 000
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
  | 'sends.create'
  | 'sends.read'
  | 'mcp.call'
  | 'mcp.refus';

/**
 * CE QU'UNE ROUTE DEMANDE AU GARDE.
 *
 * ⚠️ `unites` EST CALCULÉ PAR LA ROUTE, parce qu'elle seule connaît le corps (500 contacts, 50
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
  /** Nombre d'appels refusés par le garde (0 tant qu'aucun seuil n'est posé). */
  refusees: number;
}

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
}

/**
 * LE TRAVAIL QUE COÛTE UNE OPÉRATION, en fonction PURE.
 *
 * 🔴 ELLE VIT AVEC LE CONTRAT, PAS AVEC LE STOCKAGE. C'est une règle de PRODUIT (« un lot de 500 contacts
 * coûte 500 »), et la mettre dans l'implémentation mémoire la ferait réécrire le jour où le stockage
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
 * ⚠️ ELLE N'EST PLUS EXPORTÉE (revue du 2026-09-14) : les six routes passent par `compterOuRefuser` juste
 * en dessous, et un symbole exporté que personne n'importe finit par être appelé de travers, sans la
 * résolution d'identité que l'autre fait.
 *
 * 🔴 POINT DE PASSAGE UNIQUE DES SIX ROUTES. Recopié six fois, le couple « compter puis refuser »
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
  await reply.code(429).send({ error: verdict.raison ?? 'quota d’usage atteint' });
  return false;
}

/**
 * COMPTER LE TRAVAIL D'UNE REQUÊTE AUTHENTIFIÉE, EN UN SEUL APPEL.
 *
 * 🔴 ELLE EXISTE PARCE QUE LES SIX ROUTES RECOPIAIENT LE MÊME OBJET (relevé en revue), dont le repli
 * `req.apiKeyId ?? 'inconnue'`. Six copies d'un repli, c'est six endroits où il peut diverger, et surtout
 * un compteur qui se rangerait sous « inconnue » sans que personne ne se demande pourquoi.
 *
 * ⚠️ ELLE REND `false` SI LA REQUÊTE N'EST PAS AUTHENTIFIÉE, sans rien compter : on ne mesure pas ce
 * qu'on a refusé à la porte, sinon les compteurs mélangeraient l'usage d'un client et le bruit d'un
 * robot, et un seuil posé plus tard mordrait sur le mauvais.
 */
export async function compterOuRefuser(
  usage: ApiUsageGuard,
  req: FastifyRequest,
  reply: FastifyReply,
  operation: OperationApi,
  taille = 1,
): Promise<boolean> {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) {
    await reply.code(401).send({ error: 'clé d’API requise' });
    return false;
  }
  return demanderOuRefuser(usage, reply, {
    tenantId,
    // ⚠️ « inconnue » NE DEVRAIT JAMAIS ARRIVER : le préhandler pose `apiKeyId` en même temps que
    // `req.auth`. Le repli est là pour que le compteur reste honnête si un jour une route est montée
    // derrière une AUTRE autorité, plutôt que de mentir sur l'identité de la clé.
    cleId: req.apiKeyId ?? 'inconnue',
    operation,
    unites: unitesDe(operation, taille),
  });
}
