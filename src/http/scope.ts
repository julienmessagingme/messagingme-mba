import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Helpers partagés par TOUTES les routes de la console.
 *
 * `scopeTenant` était recopié à l'identique dans 22 fichiers de ce dossier : c'est le contrôle d'accès
 * tenant du produit, donc une divergence locale (un durcissement appliqué à 21 copies sur 22) serait
 * silencieuse. Une seule définition, importée partout.
 *
 * 🔴 DEPUIS LE LOT 3 DE L'AUDIT PONYTAIL (2026-09-26), ELLE N'A PLUS QU'UN APPELANT : `etapeEspace`, plus bas.
 * Elle était appelée en première ligne de 259 handlers, sous la forme `const tenant = scopeTenant(req); if
 * (tenant === null) return reply.code(403)...`, recopiée 259 fois avec trois corps de refus différents. Le
 * contrôle est désormais une ÉTAPE posée au montage sur chaque route `:tenantId` des modules `acces: 'tenant'`,
 * et le handler lit l'espace vérifié par `espaceVerifie`, qui échoue fermé si l'étape manque.
 */

/**
 * Tenant effectif = celui du JWT ; l'URL doit correspondre. `null` si interdit.
 *
 * 🔴 ELLE ÉCHOUE FERMÉ, ET C'EST UN CORRECTIF (audit de surface publique du 2026-09-03). Elle rendait
 * auparavant le tenant PRIS DANS L'URL quand `req.auth` était absent. Autrement dit, elle n'était un contrôle
 * d'accès que tant que la garde d'authentification avait bien été posée au montage, ailleurs, dans un autre
 * fichier. Or chaque module de routes recevait alors sa garde en paramètre OPTIONNEL et la dégradait en
 * silence (`garde ? { preHandler: garde } : {}`, le motif était dans 45 endroits) : un câblage qui aurait
 * oublié `auth` aurait monté ces routes sans aucun contrôle, et cette fonction aurait alors distribué à
 * chacun le tenant qu'il demandait. C'est-à-dire tous les espaces, à tout le monde, sans une ligne d'erreur.
 *
 * Ce n'était pas un trou vivant : `src/index.ts` fournit toujours `auth`. Mais un contrôle d'accès dont la
 * sûreté dépend d'un appelant lointain n'est pas un contrôle d'accès, c'est une convention. Et le prix d'une
 * convention muette monte le jour où l'API répond sous son propre nom.
 *
 * ⚠️ Le pendant : une route tenant montée SANS garde rend désormais 403 au lieu de servir. C'est le
 * comportement voulu. Si un jour une route à `:tenantId` doit être publique, elle ne passe pas par ici.
 *
 * 🔴 LES DEUX MOITIÉS DU DÉFAUT SONT FERMÉES DEPUIS LE 2026-09-15, et le paragraphe ci-dessus est désormais
 * au PASSÉ pour cette raison. Plan `docs/superpowers/plans/2026-09-14-dependances-non-optionnelles.md`.
 *
 * - Lot 1 : la couverture du garde-fou de `buildServer` ne s'écrit plus à la main, elle se DÉRIVE du registre
 *   (`modulesDeRoutes`, `src/server.ts`), où chaque module déclare sa classe d'accès. Ce texte disait qu'il
 *   « faudra y penser encore au 37e » : il n'y a plus de liste à allonger.
 * - Lot 2 : la garde n'est plus optionnelle NULLE PART. Mesuré après coup : zéro signature de module de
 *   routes portant une garde optionnelle, zéro occurrence du motif de dégradation. `gardeEtendue` elle-même
 *   exige désormais une garde et rend toujours un `preHandler`, là où elle acceptait `undefined` et rendait
 *   un objet vide pour sept modules.
 *
 * ⚠️ CE QUI RESTE VRAI, ET POURQUOI CETTE FONCTION NE BOUGE PAS : elle échoue toujours fermé. Une garde
 * requise par le type se pose au montage ; elle ne dit rien de ce qu'un module en fait. C'est
 * `tests/scope-tenant.test.ts` qui vérifie que toute route portant `:tenantId` d'un module `tenant` finit
 * par `etapeEspace` derrière au moins une garde, et qu'une session d'un autre espace y est refusée, route
 * par route, sur le serveur construit.
 */
export function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant === undefined) return null;
  return authTenant === tenantId ? authTenant : null;
}

/**
 * L'espace vérifié de chaque requête, posé par `etapeEspace` et lu par `espaceVerifie`.
 *
 * ⚠️ UNE `WeakMap` PRIVÉE, ET PAS UNE PROPRIÉTÉ DE LA REQUÊTE. Rien d'autre que l'étape ne peut y écrire :
 * un handler, un hook ou une dépendance qui poserait `req.espace` à la main n'aurait aucun effet sur ce que
 * l'accesseur rend. Et l'entrée disparaît avec la requête, sans rien à nettoyer.
 */
const espacesVerifies = new WeakMap<object, string>();

/**
 * 🔴 L'ÉTAPE D'ESPACE : le contrôle d'isolation entre clients, posé au MONTAGE et plus dans chaque handler.
 *
 * Même règle (`scopeTenant`), même refus au caractère près (403, `{ error: 'tenant interdit' }`), même place
 * dans le cycle : elle est ajoutée EN DERNIER à la chaîne `preHandler` de la route, donc elle tourne après la
 * garde d'authentification (qui pose `req.auth`) et après la garde de rôle ou le plafond coûteux, exactement là
 * où se trouvait la première instruction du handler. Un `addHook('preHandler')` de contexte aurait tourné
 * AVANT les gardes de route (mesuré sur Fastify 5.12.1), donc sans `req.auth`, et refusé toute la console.
 *
 * ⚠️ `await` sur l'envoi, comme `makeRequireRole` : une réponse envoyée arrête la chaîne, le handler n'est
 * jamais atteint et aucune dépendance n'est appelée.
 */
export async function etapeEspace(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tenant = scopeTenant(req);
  if (tenant === null) {
    await reply.code(403).send({ error: 'tenant interdit' });
    return;
  }
  espacesVerifies.set(req, tenant);
}

/**
 * L'espace de la requête, VÉRIFIÉ par `etapeEspace`. C'est ce que lit chaque handler d'une route `:tenantId`.
 *
 * 🔴 IL ÉCHOUE FERMÉ. Si l'étape n'a pas tourné (route montée hors du poseur, montage asynchrone, test qui
 * monte un module à la main), il LÈVE : le gestionnaire d'erreurs rend alors un 500 opaque et journalise
 * `unhandled_route_error`. Il ne rend jamais l'espace de l'URL, ni celui de la session, sans que l'un ait été
 * comparé à l'autre : c'est la leçon du 2026-09-03 sur `scopeTenant`, appliquée à son successeur.
 */
export function espaceVerifie(req: object): string {
  const tenant = espacesVerifies.get(req);
  if (tenant === undefined) throw new Error('espaceVerifie : aucune étape d’espace n’a vérifié cette requête');
  return tenant;
}

/** L'état du poseur, un par instance Fastify : un seul hook `onRoute`, allumé le temps d'un montage. */
const poseurs = new WeakMap<FastifyInstance, { actif: boolean }>();

/**
 * Monte des routes en posant `etapeEspace` à la fin de la chaîne de CHAQUE route dont l'adresse porte
 * `:tenantId`. C'est le seul point de passage, pour la production (`entree` dans `src/server.ts`, qui l'applique
 * aux modules `acces: 'tenant'`) comme pour les tests qui montent un module à la main.
 *
 * 🔴 LE CRITÈRE EST LA CLASSE DU MODULE, PUIS LE CHEMIN, et jamais le chemin seul : les routes `jeton-ops`
 * portent aussi `:tenantId` (`/ops/credits/:tenantId`), sans session, et l'étape les aurait toutes refusées.
 * C'est l'appelant qui décide de passer par ici ; le chemin ne fait que désigner les routes du module.
 *
 * ⚠️ TOUJOURS UN NOUVEAU TABLEAU, jamais un `push`. La chaîne reçue est souvent PARTAGÉE : `requireAdmin` est
 * un seul tableau distribué à tous les modules admin, et `gardeEtendue` le rend tel quel sans extra. Un `push`
 * y empilerait l'étape une fois par route, pour toutes les routes de tous les modules.
 *
 * ⚠️ `onRoute` est SYNCHRONE (il tourne pendant `app.get(...)`), d'où le drapeau allumé puis éteint autour
 * de `monter`. Une route enregistrée plus tard (dans un `app.register`) ne recevrait pas l'étape : elle
 * échouerait alors fermé par `espaceVerifie`, et le test de chaîne la signalerait. Il n'en existe aucune.
 * La route HEAD qu'une route GET engendre repasse par `onRoute` avec les options d'origine : elle reçoit
 * l'étape elle aussi, une seule fois.
 */
export function monterAvecEtapeEspace(app: FastifyInstance, monter: () => void): void {
  let etat = poseurs.get(app);
  if (etat === undefined) {
    const nouveau = { actif: false };
    app.addHook('onRoute', (r) => {
      if (!nouveau.actif || !r.path.includes(':tenantId')) return;
      const chaine = r.preHandler === undefined ? [] : Array.isArray(r.preHandler) ? r.preHandler : [r.preHandler];
      r.preHandler = [...chaine, etapeEspace];
    });
    poseurs.set(app, nouveau);
    etat = nouveau;
  }
  const avant = etat.actif;
  etat.actif = true;
  try {
    monter();
  } finally {
    etat.actif = avant;
  }
}

/** Chaîne réellement renseignée (une chaîne d'espaces ne compte pas). */
export function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Identifiant qui a la forme d'un uuid.
 *
 * 🔴 POURQUOI CE CONTRÔLE EST DANS LA COUCHE HTTP. Un identifiant de chemin part tel quel dans un `where id =
 * $1` sur une colonne `uuid` : une valeur mal formée n'y rend pas zéro ligne, elle fait LEVER Postgres
 * (`22P02`), donc un 500, dont Cloudflare remplace le corps par sa page d'erreur. Une adresse tapée de
 * travers doit rendre 404, pas une page d'incident.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function estUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
