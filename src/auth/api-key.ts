import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PreHandler } from './middleware';
import type { ApiKeyLookup } from './api-key-store.pg';
import { API_KEY_PREFIX } from './api-key-store.pg';
import { sha256Hex } from '../lib/signature';
import { ClesResolues, consommerAvecEntetes, consommerEnSilence, type RateLimiter } from './rate-limit';
import type { PlafondEspace } from './plafond-espace';
import { refuser } from '../api/erreurs';
import { DROIT_RELAIS } from '../mba/cle-relais';
import type { AccesOauthLookup } from '../oauth/store.pg';
import { formeDeJeton, PREFIXE_ACCES } from '../oauth/jetons';
import { LimiteOffreError, STATUT_REFUS_OFFRE, corpsRefusLimite } from '../offres/refus';
import type { HorsOffreMembre } from '../offres/membres';

/**
 * Les deux plafonds d'une clé résolue ; une clé n'est comptée que par l'un des deux. Deux champs requis :
 * sans limiteur de relais, la clé du relais retomberait dans le plafond de l'espace, et l'agent de Meta
 * perdrait ses outils dès qu'un intégrateur charge l'API.
 */
export interface PlafondsCle {
  /** Le plafond de l'espace, commun à toutes ses clés, `/v1` et `/mcp` confondus (minute et heure). */
  readonly espace: PlafondEspace;
  /** Le compteur par clé, réservé à la clé du relais du Meta Business Agent (droit `DROIT_RELAIS`). */
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
     * Ce qui a ouvert l'appel : une clé (`api_keys.id`) ou une autorisation OAuth (`oauth_autorisations.id`),
     * jamais le jeton ni son empreinte. Posé ici plutôt que déduit de `req.auth.userId` (`apikey:<id>`,
     * `oauth:<id>`) : une route ne doit pas dépendre d'un format d'identifiant synthétique.
     */
    apiAcces?: { type: 'cle' | 'oauth'; id: string };
    /**
     * La personne derrière un jeton OAuth, `null` derrière une clé, qui n'en a pas. Elle signe les écritures de
     * `/mcp` ; son rôle n'est pas ici, il est relu en base à chaque appel et doit valoir `admin`.
     */
    apiPersonne?: { userId: string } | null;
  }
}

/** Ce que la base a dit du porteur d'un appel, clé ou jeton, une fois résolu. */
interface Porteur {
  readonly tenantId: string;
  readonly tenantStatus?: string;
  readonly scopes: string[];
  readonly acces: { type: 'cle' | 'oauth'; id: string };
  readonly personne: { userId: string } | null;
  /** La personne d'un jeton au-delà de l'offre (lot 6, B2a) ; toujours `null` pour une clé, qui n'a pas de personne. */
  readonly horsOffre: HorsOffreMembre | null;
}

/**
 * Le format exact d'une clé émise : 43 caractères base64url après le préfixe, ce que rend
 * `randomBytes(32).toString('base64url')` (`api-key-store.pg.ts`), seul générateur qui ait jamais existé.
 * Seul le hash des clés est stocké : le format se vérifie sur le générateur, pas sur la base. Trop strict, il
 * couperait un client en production.
 */
const FORMAT_CLE = /^[A-Za-z0-9_-]{43}$/;

/**
 * La clé du budget de lookups spéculatifs : fixe, parce que ce budget est global. Un compteur indexé sur
 * l'empreinte ne freine rien : trente fausses clés toutes différentes font trente compteurs à 1, et les
 * trente requêtes Postgres partent. On borne donc le nombre de lookups spéculatifs par minute, toutes
 * empreintes confondues.
 */
const CLE_BUDGET_SPECULATIF = 'lookups-speculatifs';

/**
 * preHandler de `/v1`, `/mcp` et du relais : authentifie une clé d'API (Bearer `mba_...`) ou un jeton d'accès
 * OAuth (Bearer `mbo_...`, migration 0204), autorité séparée du JWT tenant (comme `/ops`). Le préfixe aiguille, et
 * les deux suivent le même ordre. Sur succès, pose un `req.auth` synthétique au rôle dédié `'api'` (jamais 'admin',
 * même pour un jeton dont la personne est admin : `/v1` se garde par scope, `requireScope`, et le vrai rôle
 * ouvrirait un jour une route qui le composerait), `req.apiScopes`, `req.apiAcces` et `req.apiPersonne`. Le tenant
 * vient tout entier de la clé ou de l'autorisation résolue.
 *
 * 🔴 Un jeton OAuth ne porte que `mcp:read` et `mcp:write` (CHECK de 0204) : `/v1` et le relais le refusent par
 * leurs droits, sans code de plus. Il compte dans le plafond de l'ESPACE, partagé avec `/v1` (décision du
 * 2026-10-03). Un jeton révoqué, échu, ou dont la personne n'est plus admin ou est désactivée rend 401 : Claude
 * redemande une connexion, que le consentement refusera à un non-admin.
 *
 * En-têtes `x-ratelimit-*` sur les réponses comptées : ceux de l'espace de la clé, ou de sa clé pour le
 * relais. Le 401 d'une clé inconnue et le 429 du budget spéculatif n'en portent aucun (`consommerEnSilence`).
 *
 * 🔴 Deux protections, qui ne se remplacent pas : `plafonds` ne compte que des clés qui existent (ce qu'un
 * espace demande) ; `prefiltre` borne les lookups spéculatifs, qu'une rafale de fausses clés toutes
 * différentes ferait sinon payer d'un SHA-256 et d'une requête Postgres chacune, sur le pool partagé de la copie.
 * `prefiltre` est obligatoire ; le désactiver se fait par la configuration (`API_KEY_PREFILTRE_MAX=0`).
 *
 * La clé du relais du Meta Business Agent n'entre pas dans le plafond de l'espace : elle garde un compteur
 * par clé, pour qu'un intégrateur qui épuise l'API ne prive pas l'agent de Meta de ses outils. Elle se
 * reconnaît à son droit `DROIT_RELAIS`, que seule la publication attribue et qui n'ouvre que les routes du
 * relais.
 */
export function makeRequireApiKey(
  store: ApiKeyLookup,
  plafonds: PlafondsCle,
  prefiltre: RateLimiter,
  oauth: AccesOauthLookup,
): PreHandler {
  // Les empreintes déjà résolues par ce process : hors budget spéculatif (`ClesResolues`), avec l'espace et le
  // droit de relais de leur clé, pour que le plafond se prenne avant la base. Clés et jetons partagent la table :
  // leurs empreintes ne se rencontrent pas, et un jeton n'est jamais du relais.
  const connues = new ClesResolues<CleResolue>(1000);
  const plafonner = (cle: CleResolue, empreinte: string, reply: FastifyReply): Promise<boolean> => (cle.relais
    ? consommerAvecEntetes(plafonds.relais, empreinte, reply, 'trop de requêtes', 'rate_limited')
    : plafonds.espace.consommer(cle.tenantId, reply));
  /** La base, à chaque appel : une révocation, une désactivation ou une rétrogradation prend effet tout de suite. */
  const resoudre = async (empreinte: string, jeton: boolean): Promise<Porteur | null> => {
    if (jeton) {
      const a = await oauth.resoudreAcces(empreinte);
      if (!a?.valide) return null;
      return { tenantId: a.tenantId, tenantStatus: a.tenantStatus, scopes: a.scopes, acces: { type: 'oauth', id: a.autorisationId }, personne: { userId: a.userId }, horsOffre: a.horsOffre };
    }
    const k = await store.findActiveByHash(empreinte);
    if (!k) return null;
    return { tenantId: k.tenantId, tenantStatus: k.tenantStatus, scopes: k.scopes, acces: { type: 'cle', id: k.id }, personne: null, horsOffre: null };
  };
  return async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const jeton = raw.startsWith(PREFIXE_ACCES);
    /**
     * Le format se contrôle avant tout, avant le SHA-256 et la base : une rafale de `mba_x` ou de `mbo_x` ne coûte
     * rien. Même message que pour une clé absente, pour ne pas renseigner sur la forme des clés.
     */
    const bienForme = jeton
      ? formeDeJeton(raw, PREFIXE_ACCES)
      : raw.startsWith(API_KEY_PREFIX) && FORMAT_CLE.test(raw.slice(API_KEY_PREFIX.length));
    if (!bienForme) {
      await refuser(reply, 401, 'unauthorized', 'clé d’API requise');
      return;
    }
    /**
     * 🔴 L'empreinte, jamais la valeur : ce qui est retenu en mémoire finit dans un dump ou un journal, et une
     * tentative est presque toujours un secret voisin du vrai. Calculée une fois, réutilisée pour le lookup.
     */
    const empreinte = sha256Hex(raw);
    // Lue une fois : elle décide à la fois du budget spéculatif et du moment où se prend le plafond.
    const vue = connues.valeur(empreinte);
    const connue = vue !== undefined;
    /**
     * Le budget ne s'applique qu'aux empreintes jamais résolues : un porteur légitime le traverse une fois après
     * un démarrage, et une attaque qui l'épuise ne coupe pas l'API des clients connus. Coût assumé : sous
     * attaque, une première connexion peut attendre une minute. En silence : ce budget partagé n'a pas
     * d'en-têtes à lui.
     */
    if (!connue && !(await consommerEnSilence(prefiltre, CLE_BUDGET_SPECULATIF, reply, 'trop de requêtes', 'rate_limited'))) return;
    /**
     * Le plafond ne compte que des clés qui existent : il se prend avant la base pour une empreinte déjà
     * résolue, après pour les autres, une fois par appel. Le prendre avant la base pour toutes les empreintes
     * rendrait la clé de sa table choisie par l'appelant : à `API_KEY_PREFILTRE_MAX=0`, des bearers inventés la
     * rempliraient et évinceraient un vrai client. Coût : les appels d'une clé avant sa première résolution sont
     * comptés après leur lecture.
     *
     * L'espace d'une clé résolue, ou l'empreinte de celle du relais, jamais la valeur. Seules les empreintes
     * résolues entrent dans `connues` : ces tables sont bornées par les espaces et clés du relais qui existent,
     * sans plafond de clés (qui rouvrirait l'éviction). Un espace suspendu au-delà de son plafond reçoit 429
     * avant 403. Le lookup reste fait à chaque appel accepté : une révocation prend effet tout de suite.
     */
    if (vue !== undefined && !(await plafonner(vue, empreinte, reply))) return;
    const found = await resoudre(empreinte, jeton);
    if (!found) {
      // Elle ne se résout plus (révoquée, échue, ou jamais valide) : elle perd son laissez-passer et repasse
      // sous le budget dès l'appel suivant.
      connues.oublier(empreinte);
      await refuser(reply, 401, 'unauthorized', jeton ? 'jeton d’accès invalide, échu ou révoqué' : 'clé d’API invalide ou révoquée');
      return;
    }
    // Elle a été résolue : elle ne sert pas à sonder.
    const resolue: CleResolue = { tenantId: found.tenantId, relais: found.scopes.includes(DROIT_RELAIS) };
    connues.retenir(empreinte, resolue);
    // Première résolution dans ce process : le plafond se prend ici, sur une clé qui existe.
    if (!connue && !(await plafonner(resolue, empreinte, reply))) return;
    /**
     * 🔴 L'arrêt d'urgence d'un espace s'étend à la surface publique : un espace `locked` perd `/v1` et `/mcp`,
     * les deux portes par où des messages partent. 403 et non 401 : la clé est bonne, un 401 ferait régénérer
     * une clé valide ; même code `tenant_locked` que la console. On ne bloque que sur `locked` explicite.
     */
    if (found.tenantStatus === 'locked') {
      await refuser(reply, 403, 'tenant_locked', 'espace suspendu');
      return;
    }
    /**
     * 🔴 Le gel des membres en trop (lot 6, B2a) : la personne d'un jeton au-delà de l'offre perd `/mcp` comme la console.
     * 402 et non 401 : un 401 ferait relancer la connexion OAuth à Claude, en boucle.
     */
    if (found.horsOffre) {
      // Le corps de la session de la console (`requireAuth`) : la limite, son maximum et le lien de l'offre.
      const e = new LimiteOffreError(found.tenantId, found.horsOffre.limite, found.horsOffre.max);
      await reply.code(STATUT_REFUS_OFFRE).send({ ...corpsRefusLimite(e), acces: 'suspendu' });
      return;
    }
    // Date de dernier usage d'une clé : best-effort, ne doit jamais faire échouer la requête. Celle d'un jeton
    // s'écrit dans sa résolution (`PgOauthStore.resoudreAcces`).
    if (found.acces.type === 'cle') void store.touchLastUsed(found.acces.id).catch(() => { /* best-effort */ });
    req.auth = { userId: `${found.acces.type === 'cle' ? 'apikey' : 'oauth'}:${found.acces.id}`, tenantId: found.tenantId, role: 'api' };
    req.apiScopes = found.scopes;
    req.apiAcces = found.acces;
    req.apiPersonne = found.personne;
  };
}

/** preHandler à composer après makeRequireApiKey : exige un scope précis (403 sinon). */
export function requireScope(scope: string): PreHandler {
  return async function checkScope(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.apiScopes?.includes(scope)) {
      await refuser(reply, 403, 'missing_scope', `scope requis : ${scope}`);
    }
  };
}
