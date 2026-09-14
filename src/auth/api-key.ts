import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PreHandler } from './middleware';
import type { ApiKeyLookup } from './api-key-store.pg';
import { API_KEY_PREFIX } from './api-key-store.pg';
import { sha256Hex } from '../lib/signature';
import { consommerAvecEntetes, type RateLimiter } from './rate-limit';

declare module 'fastify' {
  interface FastifyRequest {
    apiScopes?: string[];
    /**
     * `api_keys.id` de la clé résolue. Jamais la clé, jamais son empreinte.
     *
     * ⚠️ IL EST POSÉ ICI PLUTÔT QUE DÉDUIT DE `req.auth.userId`, qui vaut `apikey:<id>` : une route qui
     * découperait cette chaîne dépendrait d'un format d'identifiant synthétique, et se tromperait le jour
     * où il change. Le garde d'usage a besoin de cet identifiant, pas d'une convention de nommage.
     */
    apiKeyId?: string;
  }
}

/**
 * LE FORMAT EXACT D'UNE CLÉ ÉMISE : 43 caractères base64url après le préfixe.
 *
 * 🔴 LA VALEUR VIENT DU GÉNÉRATEUR, PAS D'UNE CONVENTION, et elle a été vérifiée avant d'être posée :
 * `randomBytes(32).toString('base64url')` (`api-key-store.pg.ts`) rend exactement 43 caractères, et
 * `git log` sur ce fichier ne montre qu'UNE seule version depuis sa création. Toute clé jamais émise
 * respecte donc ce format.
 *
 * 🔴 CE CONTRÔLE NE POUVAIT PAS SE MESURER SUR LES CLÉS EN CIRCULATION : seul leur hash est stocké,
 * c'est tout l'intérêt. C'est la seule raison pour laquelle il a fallu remonter au générateur plutôt que
 * d'interroger la base. Mesuré en base le 2026-09-14, en revanche : 2 clés existent, 1 est active, et
 * elle servait le jour même. Un format trop strict aurait coupé un client en production.
 */
const FORMAT_CLE = /^[A-Za-z0-9_-]{43}$/;

/**
 * LA CLÉ DU BUDGET DE LOOKUPS SPÉCULATIFS. Fixe, et c'est tout le sujet : ce budget est GLOBAL.
 *
 * 🔴 UN COMPTEUR INDEXÉ SUR L'EMPREINTE NE FREINE RIEN, ET C'EST UN TEST QUI L'A MONTRÉ. Le plan de ce
 * lot prévoyait un limiteur « indexé sur l'empreinte SHA-256 du bearer ». Écrit, testé, mesuré : trente
 * fausses clés TOUTES DIFFÉRENTES produisent trente compteurs à 1, dont aucun n'atteint son plafond, et
 * les trente requêtes Postgres partent quand même. Or une rafale de clés distinctes est exactement le
 * scénario qu'on ferme. Ce qui se borne ici, c'est donc le NOMBRE DE LOOKUPS SPÉCULATIFS par minute,
 * toutes empreintes confondues.
 */
const CLE_BUDGET_SPECULATIF = 'lookups-speculatifs';

/**
 * LES EMPREINTES DÉJÀ RÉSOLUES AVEC SUCCÈS PAR CE PROCESS, en nombre borné.
 *
 * 🔴 ELLE EXISTE POUR NE PAS PRENDRE LES CLIENTS EN OTAGE. Sans elle, une attaque qui épuise le budget
 * spéculatif refuserait aussi les porteurs légitimes, c'est-à-dire qu'un attaquant couperait l'API de
 * tous les clients à notre place. Une empreinte déjà reconnue échappe donc au budget.
 *
 * 🔴 ELLE NE MET RIEN EN CACHE, ET LA NUANCE EST TOUTE LA SÉCURITÉ. Elle ne dit pas « cette clé est
 * valide », elle dit « cette empreinte a déjà été résolue une fois, elle ne sert pas à sonder » : le
 * lookup a lieu À CHAQUE FOIS, donc une clé RÉVOQUÉE cesse de fonctionner immédiatement. Un cache de
 * validité, lui, aurait créé une fenêtre pendant laquelle une clé révoquée passe encore.
 *
 * ⚠️ BORNÉE, comme toutes les tables indexées sur une valeur que l'appelant choisit : au plafond, on
 * oublie la plus ancienne. Les vrais porteurs appellent régulièrement, donc ils se réinscrivent.
 */
class EmpreintesConnues {
  private readonly vues = new Set<string>();
  constructor(private readonly max: number) {}
  connait(empreinte: string): boolean { return this.vues.has(empreinte); }
  /**
   * 🔴 UNE EMPREINTE QUI CESSE DE SE RÉSOUDRE EST OUBLIÉE, ET C'EST UN TROU RELEVÉ EN REVUE. Sans cela,
   * une clé RÉVOQUÉE gardait son laissez-passer : son porteur échappait au budget spéculatif (il est
   * « déjà connu ») tout en échouant au lookup à chaque appel, donc il pouvait marteler Postgres sans
   * qu'aucun plafond ne le compte, le plafond métier n'étant atteint qu'après un lookup RÉUSSI. Un ancien
   * client mécontent, ou une intégration qu'on vient de couper, suffisait à rouvrir exactement ce que ce
   * lot ferme.
   */
  oublier(empreinte: string): void { this.vues.delete(empreinte); }
  retenir(empreinte: string): void {
    if (this.vues.has(empreinte)) return;
    if (this.vues.size >= this.max) {
      const plusAncienne = this.vues.values().next().value;
      if (plusAncienne !== undefined) this.vues.delete(plusAncienne);
    }
    this.vues.add(empreinte);
  }
}

/**
 * preHandler de la surface `/v1` : authentifie une CLÉ D'API (Bearer `mba_...`). Autorité SÉPARÉE du JWT
 * tenant (montée indépendamment, comme /ops). Sur succès, pose un `req.auth` SYNTHÉTIQUE avec le rôle
 * dédié `'api'` (JAMAIS 'admin' : les routes /v1 gate par SCOPE via requireScope, pas par rôle) et
 * `req.apiScopes`. Le tenant vient à 100% de la clé résolue (pas d'`:tenantId` dans l'URL /v1).
 * Headers x-ratelimit-* sur toute réponse (succès et 429).
 *
 * 🔴 DEUX PLAFONDS, ET ILS NE SE REMPLACENT PAS. `limiteurMetier` est indexé sur l'identifiant de la
 * clé RÉSOLUE : il borne le travail qu'un porteur légitime demande, et il est donc inatteignable sans un
 * lookup réussi. `prefiltre` borne les LOOKUPS SPÉCULATIFS, c'est-à-dire précisément ce que l'autre ne
 * peut pas voir. Avant ce lot, une rafale de fausses clés n'était comptée par aucun des deux, et chacune
 * coûtait un SHA-256 et une requête Postgres, sur un budget de 8 connexions partagé avec la console et le
 * worker.
 *
 * 🔴 `prefiltre` EST OBLIGATOIRE, ET C'EST DÉLIBÉRÉ. Optionnel, il aurait fini par manquer à un
 * appelant, et la protection aurait disparu sans bruit : c'est le motif « une capacité câblée sur un
 * consommateur sur deux », déjà payé plusieurs fois ici. Le désactiver se fait par la CONFIGURATION
 * (`API_KEY_PREFILTRE_MAX=0`), pas en oubliant un argument.
 */
export function makeRequireApiKey(store: ApiKeyLookup, limiteurMetier: RateLimiter, prefiltre: RateLimiter): PreHandler {
  const connues = new EmpreintesConnues(1000);
  return async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    /**
     * 🔴 LE FORMAT SE CONTRÔLE AVANT TOUT LE RESTE : avant le SHA-256, avant la base. C'est ce qui rend
     * une rafale de `mba_x` gratuite pour nous. Le refus est le MÊME message que pour une clé absente :
     * dire « mauvais format » renseignerait gratuitement celui qui cherche la forme des clés.
     */
    if (!raw || !raw.startsWith(API_KEY_PREFIX) || !FORMAT_CLE.test(raw.slice(API_KEY_PREFIX.length))) {
      await reply.code(401).send({ error: 'clé d’API requise' });
      return;
    }
    /**
     * 🔴 L'EMPREINTE, JAMAIS LA VALEUR. Ce qui est retenu en mémoire se retrouve dans un dump de tas ou
     * un journal de diagnostic : une tentative étant presque toujours un secret VOISIN du vrai, y écrire
     * le bearer reviendrait à journaliser des clés. C'est la règle de `/ops`, appliquée ici.
     *
     * ⚠️ ET LE SHA-256 EST CALCULÉ UNE FOIS, réutilisé pour le lookup : deux calculs seraient deux fois le
     * coût que ce lot existe pour réduire.
     */
    const empreinte = sha256Hex(raw);
    /**
     * 🔴 LE BUDGET NE S'APPLIQUE QU'AUX EMPREINTES JAMAIS RÉSOLUES. Un porteur légitime le traverse une
     * seule fois, au premier appel après un démarrage ; ensuite il n'y est plus soumis. Sans cette
     * exception, une attaque qui épuise le budget couperait l'API de tous les clients, c'est-à-dire
     * qu'elle obtiendrait de nous le déni de service qu'elle cherche.
     *
     * ⚠️ LE COÛT ASSUMÉ : sous attaque soutenue, un client dont l'empreinte n'est pas encore connue de ce
     * process peut attendre la fenêtre suivante. C'est une minute pour une première connexion, contre des
     * milliers de requêtes Postgres épargnées.
     */
    if (!connues.connait(empreinte) && !(await consommerAvecEntetes(prefiltre, CLE_BUDGET_SPECULATIF, reply, 'trop de requêtes'))) return;
    const found = await store.findActiveByHash(empreinte);
    if (!found) {
      // Elle ne se résout plus (révoquée, ou jamais valide) : elle perd son laissez-passer et repasse
      // sous le budget dès l'appel suivant.
      connues.oublier(empreinte);
      await reply.code(401).send({ error: 'clé d’API invalide ou révoquée' });
      return;
    }
    // Elle a été résolue : elle ne sert pas à sonder. Le lookup reste fait à chaque appel, donc une
    // révocation prend effet tout de suite.
    connues.retenir(empreinte);
    /**
     * 🔴 L'ARRÊT D'URGENCE D'UN ESPACE, ÉTENDU À LA SURFACE PUBLIQUE (tranché par Julien le 2026-09-14).
     * `tenants.status = 'locked'` était lu par la garde de SESSION et par elle seule : un espace suspendu
     * gardait donc `/v1` et `/mcp`, c'est-à-dire les deux portes par lesquelles des messages partent.
     *
     * ⚠️ 403 ET NON 401 : la clé est bonne, c'est l'espace qui est suspendu. Un 401 enverrait
     * l'intégrateur régénérer une clé parfaitement valide. Le code `tenant_locked` est le même que celui
     * de la console, pour qu'un client n'ait pas deux vocabulaires à connaître.
     *
     * ⚠️ ON NE BLOQUE QUE SUR `locked` EXPLICITE : bloquer sur « tout ce qui n'est pas active » fermerait
     * l'API de tous les espaces le jour où un statut est ajouté.
     */
    if (found.tenantStatus === 'locked') {
      await reply.code(403).send({ error: 'espace suspendu', code: 'tenant_locked' });
      return;
    }
    // Séquence en-têtes + 429 partagée avec les deux plafonds de `middleware.ts` : elle vit dans
    // `rate-limit.ts`, elle ne se recopie pas (c'en était la troisième copie).
    if (!(await consommerAvecEntetes(limiteurMetier, found.id, reply, 'trop de requêtes'))) return;
    // Empreinte de dernier usage : best-effort, ne doit jamais bloquer/échouer la requête.
    void store.touchLastUsed(found.id).catch(() => { /* best-effort */ });
    req.auth = { userId: `apikey:${found.id}`, tenantId: found.tenantId, role: 'api' };
    req.apiScopes = found.scopes;
    req.apiKeyId = found.id;
  };
}

/** preHandler à composer APRÈS makeRequireApiKey : exige un scope précis (403 sinon). */
export function requireScope(scope: string): PreHandler {
  return async function checkScope(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.apiScopes?.includes(scope)) {
      await reply.code(403).send({ error: `scope requis : ${scope}` });
    }
  };
}
