import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifySession, verifySessionOps, verifyLienNumero } from './token';
import type { Session } from './token';
import type { MfaStore } from './mfa-store.pg';
import { ipIndicative, type SurveillanceOps } from '../ops/tentatives';
import { consommerAvecEntetes, type RateLimiter } from './rate-limit';
import { consommerPartageAvecEntetes, type PlafondPartage } from './plafond-partage';
import { LimiteOffreError, STATUT_REFUS_OFFRE, corpsRefusLimite } from '../offres/refus';
import type { HorsOffreMembre } from '../offres/membres';

/** L'exploitant d'une requête `/ops`, tel que la garde l'a revérifié en base. */
export interface ExploitantVerifie {
  identityId: string;
  /** L'adresse relue en base, en minuscules : c'est elle qui signe chaque écriture d'exploitation. */
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Session;
    /** Posé par la seule garde de `/ops` (`makeRequireOps`). Absent partout ailleurs. */
    ops?: ExploitantVerifie;
  }
}

export type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
/** Une garde de route : un preHandler seul, ou une chaîne exécutée dans l'ordre (Fastify
 *  court-circuite dès qu'un maillon répond). Sert à composer [requireAuth, requireRole]. */
export type Guard = PreHandler | PreHandler[];

/** Relit l'état d'auth courant du compte en base. null = compte supprimé. `tenantStatus` (optionnel) porte le
 *  statut de l'espace pour le crochet de barrage (locked -> accès coupé). */
/**
 * L'état d'un compte relu à chaque requête. `horsOffre` (lot 6, B2a) : le membre dépasse les limites de l'offre de son
 * espace (`GelMembres`), `null` s'il y tient. REQUIS : un chargeur qui l'oublierait laisserait passer les membres en trop.
 */
export type UserStateLoader = (userId: string, tenantId: string) => Promise<{ role: string; disabled: boolean; tenantStatus?: string; horsOffre: HorsOffreMembre | null } | null>;

/**
 * Garde de rôle à utiliser dans un handler déjà authentifié : rend true (et répond 403) si l'appelant n'est
 * pas admin.
 */
export function forbidNonAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.auth && req.auth.role !== 'admin') {
    void reply.code(403).send({ error: 'action réservée aux administrateurs' });
    return true;
  }
  return false;
}

/**
 * preHandler de groupe : exige que `req.auth.role` soit dans `roles`. À composer après `makeRequireAuth`,
 * dont il suppose `req.auth` ; 401 défensif si l'auth manque, 403 si le rôle n'est pas autorisé.
 */
export function makeRequireRole(roles: readonly string[]): PreHandler {
  const allowed = new Set(roles);
  return async function requireRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.auth) {
      await reply.code(401).send({ error: 'authentification requise' });
      return;
    }
    if (!allowed.has(req.auth.role)) {
      await reply.code(403).send({ error: 'action réservée aux administrateurs' });
      return;
    }
  };
}

/**
 * L'adresse fait-elle partie de l'exploitation ? Comparée en minuscules des deux côtés : la liste vient d'une
 * variable d'environnement tapée à la main, l'adresse d'un formulaire ou de Google. Liste absente ou vide =
 * personne.
 */
export function estAdresseOps(adresses: readonly string[] | undefined, email: string): boolean {
  const cherchee = email.trim().toLowerCase();
  return cherchee !== '' && (adresses ?? []).some((a) => a.trim().toLowerCase() === cherchee);
}

/** Ce que la garde de `/ops` lit : le secret des sessions, le second facteur, la liste. */
export interface AutoriteOps {
  secret: string;
  /** Absent : `/ops` refuse tout. L'absence ferme, jamais n'ouvre. */
  mfa?: Pick<MfaStore, 'lire'>;
  opsEmails?: readonly string[];
}

/**
 * preHandler de `/ops` : une session d'exploitation (`signSessionOps`), en `Authorization: Bearer`. 401 sinon.
 * 🔴 Trois contrôles, dans cet ordre, et les deux derniers à CHAQUE requête :
 *  1. la signature et la portée (`verifySessionOps`), sans toucher la base : un appel sans session valide ne
 *     coûte aucune lecture pour être refusé, et son compte (`surveillerOps`) est regroupé, un seul comptage en vol
 *     par copie ;
 *  2. l'adresse de l'identité, relue en base, toujours dans la liste : retirer quelqu'un de `OPS_EMAILS` coupe son
 *     accès à la requête suivante, sans attendre la fin de ses 12 heures ;
 *  3. son second facteur toujours actif : une identité dont le facteur a été retiré ou réinitialisé perd l'accès.
 * Autorité distincte de la session d'espace, dans les deux sens : un admin d'espace n'atteint pas `/ops`, une
 * session d'exploitation n'ouvre aucune route d'espace. Liste vide ou autorité absente = refus pour tous.
 */
export function makeRequireOps(autorite: AutoriteOps | undefined, surveillance?: SurveillanceOps): PreHandler {
  return async function requireOps(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const jeton = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const session = autorite && jeton ? await verifySessionOps(jeton, autorite.secret) : null;
    const etat = session && autorite?.mfa && estAdresseOps(autorite.opsEmails, session.email)
      ? await autorite.mfa.lire(session.identityId)
      : null;
    // L'adresse relue en base, pas celle du jeton : c'est elle que la liste doit contenir, et elle qui signe.
    if (!etat || etat.secret === null || !estAdresseOps(autorite?.opsEmails, etat.email)) {
      // Signalé avant de répondre, sans rien attendre (la promesse ne rejette jamais) : `/ops` ouvre la lecture de
      // tous les clients. Le jeton présenté n'est jamais transmis (voir `ops/tentatives.ts`).
      void surveillance?.refus({ chemin: req.url, ip: ipIndicative(req) });
      await reply.code(401).send({ error: 'ops: non autorisé' });
      return;
    }
    req.ops = { identityId: etat.identityId, email: etat.email.trim().toLowerCase() };
  };
}

/**
 * L'exploitant de la requête, pour signer une écriture ou une observation. 🔴 Échoue fermé : sans la garde de
 * `/ops` devant, il lève (500 opaque) plutôt que de laisser une écriture partir sans auteur.
 */
export function auteurOps(req: FastifyRequest): string {
  if (!req.ops) throw new Error('auteurOps : aucune garde d’exploitation n’a vérifié cette requête');
  return req.ops.email;
}

/**
 * preHandler qui exige un Bearer JWT valide et pose `req.auth` ; 401 sinon. 🔴 Les routes dérivent le tenant
 * de `req.auth`, jamais de l'URL.
 *
 * `loadState` relit l'état du compte en base à chaque requête : compte supprimé ou révoqué, 401 immédiat ;
 * rôle rafraîchi (un changement prend effet tout de suite). Sans lui (tests sans base), vérification JWT
 * seule.
 */
export function makeRequireAuth(secret: string, loadState?: UserStateLoader, limiteur?: RateLimiter): PreHandler {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      await reply.code(401).send({ error: 'authentification requise' });
      return;
    }
    const session = await verifySession(token, secret);
    if (!session) {
      await reply.code(401).send({ error: 'token invalide ou expiré' });
      return;
    }
    // Le plafond se prend ici :
    //  - après `verifySession`, la clé étant `session.userId` : `req.ip` désigne le proxy (pas de
    //    `trustProxy`), un plafond sur lui serait global à la plateforme ;
    //  - avant `loadState` : un appelant qui martèle ne coûte pas une requête SQL par refus ;
    //  - avant la branche des sessions d'emprunt, qui sort par un `return` anticipé.
    if (limiteur && !(await consommerAvecEntetes(limiteur, session.userId, reply))) return;
    // 🔴 Session d'emprunt : lecture seule, quelle que soit la route. Une garde ici plutôt que route par route :
    // une route oubliée serait la faille. `GET` et `HEAD` seulement, une route d'écriture ajoutée demain comprise.
    if (session.impersonated === true) {
      const methode = req.method.toUpperCase();
      if (methode !== 'GET' && methode !== 'HEAD') {
        await reply.code(403).send({ error: 'session d’observation : lecture seule', code: 'impersonation_read_only' });
        return;
      }
      // Pas de relecture d'état : le porteur n'a pas de compte dans cet espace, le loader révoquerait la session.
      // Sa légitimité vient de sa signature, émise par `/ops`.
      req.auth = session;
      return;
    }
    if (loadState) {
      const state = await loadState(session.userId, session.tenantId);
      if (!state || state.disabled) {
        await reply.code(401).send({ error: 'session révoquée' });
        return;
      }
      // Barrage de paiement : un espace `locked` coupe l'accès à toutes les routes gardées ; on ne bloque que sur
      // 'locked' explicite.
      if (state.tenantStatus === 'locked') {
        await reply.code(403).send({ error: 'espace suspendu', code: 'tenant_locked' });
        return;
      }
      /**
       * 🔴 Le gel des membres au retour en Base (lot 6, B2a, spec § 7) : au-delà des limites de l'offre, 402 à CHAQUE
       * requête, lecture comprise. `acces: 'suspendu'` distingue ce refus de celui d'une invitation au-delà de la limite
       * (même code) : la console affiche alors une page, pas un bandeau. Rien n'est effacé, l'accès revient au réabonnement.
       */
      if (state.horsOffre) {
        const e = new LimiteOffreError(session.tenantId, state.horsOffre.limite, state.horsOffre.max);
        await reply.code(STATUT_REFUS_OFFRE).send({ ...corpsRefusLimite(e), acces: 'suspendu' });
        return;
      }
      session.role = state.role; // rôle frais : les changements de rôle sont immédiats
    }
    req.auth = session;
  };
}

/**
 * LA GARDE DES ROUTES DE LA CONNEXION DU NUMÉRO (lot 3c, livraison A) : une session d'admin, exactement comme la garde
 * `admin` (la même chaîne, appelée telle quelle), OU le jeton du lien que donne Claude Code (`verifyLienNumero`).
 * Pour le jeton, à chaque appel :
 *  - le plafond par utilisateur, sur celui qui a demandé le lien, comme pour une session ;
 *  - 🔴 l'utilisateur relu en base : révoqué, supprimé ou rétrogradé, le lien ne sert plus ; l'espace suspendu non plus,
 *    ni un membre en trop de l'offre (lot 6, B2a : le même 402 que sa session) ;
 *  - 🔴 une écriture refusée (409 `lien_termine`) dès que l'espace a un numéro connecté ET activé : c'est ce qui fait
 *    mourir le lien. Un numéro relié que Meta n'a pas encore activé le laisse vivre (l'activation reste à faire), et
 *    `ecrituresApresConnexion` nomme les routes qui jugent elles-mêmes (« Abandonner » le numéro fourni quand c'est un
 *    AUTRE numéro qui s'est connecté). Les lectures restent permises jusqu'à son échéance, pour que la page affiche
 *    « connecté ».
 *  - 🔴 sans chargeur d'état, aucun lien n'est accepté : jamais de lien sans relecture de son auteur.
 * Elle pose `req.auth` sur l'espace DU JETON : l'étape d'espace, posée après elle au montage, compare ensuite l'URL,
 * comme pour une session. ⚠️ Elle n'est posée que sur les modules de la page (`src/server.ts`) : c'est la liste
 * qu'éprouve `tests/scope-tenant.test.ts`, un jeton de lien présenté ailleurs étant refusé par `verifySession`.
 */
export function makeRequireAdminOuLien(o: {
  requireAdmin: PreHandler[];
  secret: string;
  loadState: UserStateLoader | undefined;
  limiteur?: RateLimiter;
  /** L'espace a-t-il un numéro connecté ET activé (`status = CONNECTED`) ? */
  numeroActif(tenantId: string): Promise<boolean>;
  /** Les adresses de route (`/tenants/:tenantId/...`) dont l'écriture reste permise au lien après la connexion. */
  ecrituresApresConnexion: ReadonlySet<string>;
}): PreHandler {
  return async function adminOuLien(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const lien = token ? await verifyLienNumero(token, o.secret) : null;
    if (!lien) {
      // Pas un lien : la garde admin, maillon par maillon, comme Fastify l'aurait déroulée.
      for (const maillon of o.requireAdmin) {
        await maillon(req, reply);
        if (reply.sent) return;
      }
      return;
    }
    if (o.limiteur && !(await consommerAvecEntetes(o.limiteur, lien.userId, reply))) return;
    if (!o.loadState) {
      await reply.code(401).send({ error: 'lien non vérifiable : redemandez-en un à Claude' });
      return;
    }
    const etat = await o.loadState(lien.userId, lien.tenantId);
    if (!etat || etat.disabled) {
      await reply.code(401).send({ error: 'lien révoqué : redemandez-en un à Claude' });
      return;
    }
    if (etat.tenantStatus === 'locked') {
      await reply.code(403).send({ error: 'espace suspendu', code: 'tenant_locked' });
      return;
    }
    // Le membre en trop (lot 6, B2a) : le lien ne vaut pas mieux que sa session, refusée de la même façon.
    if (etat.horsOffre) {
      const e = new LimiteOffreError(lien.tenantId, etat.horsOffre.limite, etat.horsOffre.max);
      await reply.code(STATUT_REFUS_OFFRE).send({ ...corpsRefusLimite(e), acces: 'suspendu' });
      return;
    }
    if (etat.role !== 'admin') {
      await reply.code(403).send({ error: 'réservé aux admins de l’espace' });
      return;
    }
    const methode = req.method.toUpperCase();
    const ecriture = methode !== 'GET' && methode !== 'HEAD';
    if (ecriture && !o.ecrituresApresConnexion.has(req.routeOptions.url ?? '') && (await o.numeroActif(lien.tenantId))) {
      await reply.code(409).send({ error: 'le numéro est connecté : ce lien ne sert plus', code: 'lien_termine' });
      return;
    }
    req.auth = { userId: lien.userId, tenantId: lien.tenantId, role: 'admin', viaLien: true };
  };
}

/**
 * preHandler des routes coûteuses (import CSV, action en masse, purge, export d'historique, lancement de
 * campagne), à composer après `makeRequireAuth`. La clé est le tenant, pas l'utilisateur : on borne la
 * charge qu'un espace envoie à Postgres, et un espace à dix comptes aurait sinon dix fois le plafond.
 * S'ajoute au plafond général sans le remplacer. Le plafond est PARTAGÉ par les copies de l'API (`PlafondPartage`) :
 * un espace a ses dix opérations lourdes par minute au total, pas dix par copie.
 */
export function makeLimiteParTenant(plafond: PlafondPartage, message?: string): PreHandler {
  return async function limiteParTenant(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // 401 défensif : sans `req.auth`, la clé serait vide et tous les espaces partageraient le même compteur.
    if (!req.auth) {
      await reply.code(401).send({ error: 'authentification requise' });
      return;
    }
    await consommerPartageAvecEntetes(plafond, req.auth.tenantId, reply, message);
  };
}

/**
 * Options de route `{ preHandler }` : la garde, suivie de `extra` s'il est fourni. Aplatit la chaîne :
 * `[garde, extra]` avec une garde déjà en tableau donnerait un tableau imbriqué, que Fastify n'exécute pas,
 * en silence. 🔴 La garde est requise et `preHandler` toujours posé : jamais d'options de route sans garde.
 */
export function gardeEtendue(garde: Guard, extra?: PreHandler): { preHandler: Guard } {
  const base = Array.isArray(garde) ? garde : [garde];
  return { preHandler: extra ? [...base, extra] : base };
}
