import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PreHandler } from './middleware';
import type { ApiKeyLookup } from './api-key-store.pg';
import { API_KEY_PREFIX } from './api-key-store.pg';
import { sha256Hex } from '../lib/signature';
import { ClesResolues, consommerAvecEntetes, consommerEnSilence, type RateLimiter } from './rate-limit';
import type { PlafondEspace } from './plafond-espace';
import { refuser } from '../api/erreurs';
import { DROIT_RELAIS } from '../mba/cle-relais';

/**
 * Les deux plafonds d'une clé RÉSOLUE, et une clé n'est comptée que par l'un des deux.
 *
 * 🔴 DEUX CHAMPS REQUIS, ET PAS UN LIMITEUR OPTIONNEL POUR LE RELAIS : absent, le relais retomberait dans le
 * plafond de l'espace sans que rien ne le dise, et l'agent de Meta perdrait ses outils dès qu'un intégrateur
 * charge l'API. C'est le motif « une capacité câblée sur un consommateur sur deux ».
 */
export interface PlafondsCle {
  /** Le plafond de l'ESPACE, commun à toutes ses clés, `/v1` et `/mcp` confondus (minute ET heure). */
  readonly espace: PlafondEspace;
  /** Le compteur PAR CLÉ, réservé à la clé du relais du Meta Business Agent (droit `DROIT_RELAIS`). */
  readonly relais: RateLimiter;
}

/** Ce qu'une résolution a dit d'une clé, et qui ne change jamais : son espace, et si c'est la clé du relais. */
interface CleResolue {
  readonly tenantId: string;
  readonly relais: boolean;
}

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
 * preHandler de la surface `/v1` : authentifie une CLÉ D'API (Bearer `mba_...`). Autorité SÉPARÉE du JWT
 * tenant (montée indépendamment, comme /ops). Sur succès, pose un `req.auth` SYNTHÉTIQUE avec le rôle
 * dédié `'api'` (JAMAIS 'admin' : les routes /v1 gate par SCOPE via requireScope, pas par rôle) et
 * `req.apiScopes`. Le tenant vient à 100% de la clé résolue (pas d'`:tenantId` dans l'URL /v1).
 * En-têtes x-ratelimit-* sur les réponses COMPTÉES (succès, et 429 du plafond) : ceux de l'ESPACE de la clé, ou
 * ceux de sa clé pour le relais du Meta Business Agent. Le 401 d'une clé INCONNUE de ce process et le 429 du
 * budget spéculatif commun n'en portent aucun : ce budget n'appartient à personne (`consommerEnSilence`).
 * ⚠️ Une clé déjà résolue puis révoquée prend encore ses en-têtes sur son 401, posés avant la lecture qui la
 * découvre révoquée : ce sont ceux de SON espace, qu'elle connaissait déjà, rien d'un autre espace.
 *
 * 🔴 DEUX PLAFONDS, ET ILS NE SE REMPLACENT PAS. `plafonds` ne compte que des clés qui EXISTENT : il borne ce
 * qu'un ESPACE demande, toutes ses clés confondues (`plafonds.espace`, 2026-09-25), et ce qu'il coûte une fois
 * au-delà. Il ne voit donc PAS une rafale de fausses clés toutes différentes. `prefiltre` borne les LOOKUPS
 * SPÉCULATIFS, c'est-à-dire précisément ce que l'autre ne peut pas voir. Avant le lot du 2026-09-14, une
 * rafale de fausses clés n'était comptée par aucun des deux, et chacune coûtait un SHA-256 et une requête
 * Postgres, sur un budget de 8 connexions partagé avec la console et le worker.
 *
 * 🔴 LA CLÉ DU RELAIS DU META BUSINESS AGENT N'ENTRE PAS DANS LE PLAFOND DE L'ESPACE (décision de Julien du
 * 2026-09-25). Elle garde son compteur PAR CLÉ (`plafonds.relais`, le plafond d'avant) : un intégrateur qui
 * épuise l'API de l'espace ne doit jamais priver l'agent de Meta de ses outils en pleine conversation. Elle se
 * reconnaît à son droit `DROIT_RELAIS`, que seule la publication attribue (absent de `VALID_API_SCOPES`) et qui
 * ne donne accès qu'aux routes du relais : c'est exactement la clé retenue dans `mba_relais_cle_id`, sans lecture
 * de plus, y compris pendant la publication, quand la clé neuve sert avant d'être retenue.
 *
 * 🔴 `prefiltre` EST OBLIGATOIRE, ET C'EST DÉLIBÉRÉ. Optionnel, il aurait fini par manquer à un
 * appelant, et la protection aurait disparu sans bruit : c'est le motif « une capacité câblée sur un
 * consommateur sur deux », déjà payé plusieurs fois ici. Le désactiver se fait par la CONFIGURATION
 * (`API_KEY_PREFILTRE_MAX=0`), pas en oubliant un argument.
 */
export function makeRequireApiKey(store: ApiKeyLookup, plafonds: PlafondsCle, prefiltre: RateLimiter): PreHandler {
  // Les empreintes déjà résolues par ce process : elles échappent au budget spéculatif (`ClesResolues`), et
  // portent l'espace et le droit de relais de leur clé, pour que le plafond se prenne AVANT la base.
  const connues = new ClesResolues<CleResolue>(1000);
  const plafonner = (cle: CleResolue, empreinte: string, reply: FastifyReply): Promise<boolean> => (cle.relais
    ? consommerAvecEntetes(plafonds.relais, empreinte, reply, 'trop de requêtes', 'rate_limited')
    : plafonds.espace.consommer(cle.tenantId, reply));
  return async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    /**
     * 🔴 LE FORMAT SE CONTRÔLE AVANT TOUT LE RESTE : avant le SHA-256, avant la base. C'est ce qui rend
     * une rafale de `mba_x` gratuite pour nous. Le refus est le MÊME message que pour une clé absente :
     * dire « mauvais format » renseignerait gratuitement celui qui cherche la forme des clés.
     */
    if (!raw || !raw.startsWith(API_KEY_PREFIX) || !FORMAT_CLE.test(raw.slice(API_KEY_PREFIX.length))) {
      await refuser(reply, 401, 'unauthorized', 'clé d’API requise');
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
    // Lue UNE fois : elle décide à la fois du budget spéculatif et du moment où se prend le plafond.
    const vue = connues.valeur(empreinte);
    const connue = vue !== undefined;
    /**
     * 🔴 LE BUDGET NE S'APPLIQUE QU'AUX EMPREINTES JAMAIS RÉSOLUES. Un porteur légitime le traverse une
     * seule fois, au premier appel après un démarrage ; ensuite il n'y est plus soumis. Sans cette
     * exception, une attaque qui épuise le budget couperait l'API de tous les clients, c'est-à-dire
     * qu'elle obtiendrait de nous le déni de service qu'elle cherche.
     *
     * ⚠️ LE COÛT ASSUMÉ : sous attaque soutenue, un client dont l'empreinte n'est pas encore connue de ce
     * process peut attendre la fenêtre suivante. C'est une minute pour une première connexion, contre des
     * milliers de requêtes Postgres épargnées.
     *
     * 🔴 EN SILENCE : ce budget est PARTAGÉ par tous les appelants, ses en-têtes n'appartiennent à personne
     * (`consommerEnSilence`). Les `x-ratelimit-*` qu'un client lit sont ceux de SON espace, posés plus bas.
     */
    if (!connue && !(await consommerEnSilence(prefiltre, CLE_BUDGET_SPECULATIF, reply, 'trop de requêtes', 'rate_limited'))) return;
    /**
     * 🔴 LE PLAFOND NE COMPTE QUE DES CLÉS QUI EXISTENT (2026-09-21, même défaut que sur `/w/:code` et les
     * rappels RCS). Il se prend donc AVANT la base pour une empreinte déjà résolue, APRÈS pour les autres, et
     * une seule fois par appel. Ce qui suit a été écrit quand il était compté par clé ; le raisonnement vaut
     * tel quel pour le plafond de l'espace, dont l'espace vient de la résolution retenue dans `connues`.
     *
     * Le contre-audit du 2026-09-14 l'avait remonté AVANT la base pour TOUTES les empreintes : compté sur
     * l'identifiant de la clé résolue, chaque 429 d'une clé valide trop pressée payait une requête Postgres.
     * Mais la clé de sa table devenait alors choisie par l'APPELANT, et la table porte un plafond de clés.
     * Tant que le budget spéculatif tourne, il bornait le nombre d'empreintes inconnues qui y entraient ; à
     * `API_KEY_PREFILTRE_MAX=0`, le levier d'urgence, plus rien. Des bearers inventés remplissaient la table,
     * et un vrai client qui s'y présentait comme une clé NEUVE (premier appel après un démarrage, ou entrée
     * expirée puis purgée) recevait 429 : le levier censé libérer l'API permettait d'en couper un client.
     *
     * Ce que ce placement garde : une clé déjà résolue qui dépasse son plafond est refusée SANS requête
     * Postgres, ce qui était l'objet du contre-audit. Ce qu'il coûte, dit tel quel : les appels d'une clé
     * arrivés avant sa première résolution par ce process (le premier, ou une rafale simultanée au démarrage,
     * elle-même bornée par le budget spéculatif) sont comptés après leur lecture, donc un 429 y paie une
     * requête ; dès que l'empreinte est retenue, les refus se prennent avant la base. Et le levier à 0 ne freine
     * plus une fausse clé RÉPÉTÉE avant la base : ce n'est que ce qu'il faisait déjà pour des fausses clés
     * toutes différentes, chacune ouvrant son propre compteur.
     *
     * ⚠️ L'ESPACE D'UNE CLÉ RÉSOLUE, OU L'EMPREINTE DE CELLE DU RELAIS, JAMAIS LA VALEUR, pour la même raison
     * que le budget spéculatif. Seules les empreintes RÉSOLUES entrent dans `connues`, donc les tables de ces
     * limiteurs sont bornées par le nombre d'espaces et de clés du relais qui existent, sans plafond de clés
     * (`server.ts`) : un tel plafond y rouvrirait l'éviction.
     *
     * ⚠️ CONSÉQUENCE ASSUMÉE : un espace suspendu au-delà de son plafond reçoit 429 avant de recevoir 403. Les
     * deux refusent, et le 403 revient dès la fenêtre suivante. Idem pour une clé révoquée déjà connue : son
     * dernier appel est compté à l'espace avant que la lecture ne la découvre révoquée, puis elle est oubliée.
     *
     * Le lookup reste fait à CHAQUE appel accepté : une révocation prend effet tout de suite.
     */
    if (vue !== undefined && !(await plafonner(vue, empreinte, reply))) return;
    const found = await store.findActiveByHash(empreinte);
    if (!found) {
      // Elle ne se résout plus (révoquée, ou jamais valide) : elle perd son laissez-passer et repasse
      // sous le budget dès l'appel suivant.
      connues.oublier(empreinte);
      await refuser(reply, 401, 'unauthorized', 'clé d’API invalide ou révoquée');
      return;
    }
    // Elle a été résolue : elle ne sert pas à sonder. Le lookup reste fait à chaque appel, donc une
    // révocation prend effet tout de suite.
    const resolue: CleResolue = { tenantId: found.tenantId, relais: found.scopes.includes(DROIT_RELAIS) };
    connues.retenir(empreinte, resolue);
    // Première résolution dans ce process : le plafond se prend ici, sur une clé qui existe.
    if (!connue && !(await plafonner(resolue, empreinte, reply))) return;
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
      await refuser(reply, 403, 'tenant_locked', 'espace suspendu');
      return;
    }
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
      await refuser(reply, 403, 'missing_scope', `scope requis : ${scope}`);
    }
  };
}
