import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { verifyPassword, hashPassword, hashPasswordSync } from './password';
import { signSession } from './token';
import { RateLimiter } from './rate-limit';
import type { UserAuthStore } from './store';
import type { UserStateLoader, Guard } from './middleware';
import type { GoogleIdentity } from './google';
import { DuplicateEmailError } from '../user/store.pg';

export interface AuthRouteDeps {
  users: UserAuthStore;
  secret: string;
  /** Rate-limit du login (par IP). Défaut : 10 tentatives / minute. */
  loginRateLimit?: { max: number; windowMs: number };
  /** Re-vérification par requête de l'état du compte (révoqué/supprimé/rôle frais). Optionnel :
   *  absent en test (JWT seul). Voir makeRequireAuth. */
  getUserState?: UserStateLoader;
  /** Inscription libre : crée un espace + admin. `passwordHash` null = compte Google-only. Absent -> 503. */
  createTenantWithAdmin?(workspaceName: string, admin: { email: string; name: string | null; passwordHash: string | null }): Promise<{ tenantId: string; userId: string }>;
  /** Pose (écrase) le hash de mot de passe d'un compte (reset / changement). */
  setPassword?(userId: string, hash: string): Promise<boolean>;
  /** Hash de mot de passe courant d'un compte (vérification au changement). null si absent/sans mdp. */
  getPasswordHash?(userId: string): Promise<string | null>;
  /** {tenantId, role, email} d'un compte par id : émettre une session après acceptation d'invitation. */
  sessionUser?(userId: string): Promise<{ tenantId: string; role: string; email: string } | null>;
  /** Client OAuth Google (public) : exposé via GET /auth/config, sert au front pour le bouton. */
  googleClientId?: string;
  /** Vérifie un jeton ID Google -> identité (email vérifié), ou null si invalide. */
  verifyGoogle?(idToken: string): Promise<GoogleIdentity | null>;
  /** Un compte par email, TOUT statut (login Google lié par email). */
  getUserByEmail?(email: string): Promise<{ id: string; tenantId: string; role: string; disabled: boolean } | null>;
  /** Tokens à usage unique (reset / invite). */
  tokens?: {
    create(purpose: 'reset' | 'invite', userId: string, ttlMs: number): Promise<string>;
    consume(purpose: 'reset' | 'invite', raw: string): Promise<string | null>;
  };
  /** Envoi d'email (Resend) pour les liens. Absent -> forgot-password répond 200 sans rien envoyer. */
  sendEmail?(input: { to: string; subject: string; text: string; html?: string }): Promise<void>;
  /** Base URL du front pour les liens d'email. */
  appUrl?: string;
  /** Durée de validité d'un lien de reset (ms). */
  resetTtlMs?: number;
  /**
   * Horodate la dernière connexion réussie (colonne « Dernière connexion » de la page Équipe). OPTIONNEL :
   * les tests construisent `auth` avec `{ users, secret }` seuls, le rendre requis casserait leur compilation.
   */
  touchLastLogin?(userId: string): Promise<void>;
}

/**
 * Marque une connexion réussie SANS jamais bloquer la réponse ni pouvoir la faire échouer : l'écriture part
 * en fire-and-forget, exactement comme l'envoi d'email de reset plus bas. Mettre une écriture Postgres sur le
 * chemin critique de l'authentification transformerait un pool saturé en « identifiants refusés ».
 *
 * ⚠️ `?.(userId)?.catch(...)` et non `?.(userId).catch(...)` : quand le dep est absent, l'appel optionnel rend
 * `undefined`, et appeler `.catch` dessus lève un TypeError à l'exécution. Le `?.` sur le retour est requis.
 */
function markLogin(deps: AuthRouteDeps, userId: string): void {
  void deps.touchLastLogin?.(userId)?.catch(() => {});
}

// Hash leurre (format scrypt valide) pour égaliser le temps CPU quand l'email est inconnu :
// verifyPassword est TOUJOURS exécuté, supprimant l'oracle temporel d'énumération de comptes.
const DUMMY_HASH = hashPasswordSync(randomBytes(24).toString('hex')); // une seule fois au chargement -> sync OK
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Routes d'authentification PUBLIQUES : login, inscription libre, mot de passe perdu/réinitialisé, plus le
 * changement de mot de passe (gardé par `requireAuth` si fourni). Chaque endpoint a son propre rate-limiter
 * (ne pas partager l'instance du login). Anti-énumération : login/forgot ne révèlent jamais l'existence d'un email.
 */
/**
 * Clé de rate-limit : `req.ip::discriminant`. `req.ip` seul est INSUFFISANT sur ce déploiement : le front proxifie
 * /api/backend/* vers mba-api, donc le pair TCP (req.ip) est TOUJOURS le conteneur mba-web, une constante. Un limiteur
 * clé sur req.ip seul est alors GLOBAL à toute la plateforme (un seul attaquant bloque les logins de tous). Le
 * discriminant (email normalisé, ou token pour reset/invite) rend la clé propre à la tentative -> plus de blocage
 * transverse. NB : borner trustProxy pour récupérer la vraie IP client est un chantier séparé (chaîne XFF à vérifier
 * en prod avant de risquer un spoofing) ; ce discriminant ferme le trou sans en dépendre.
 */
function rateKey(req: { ip: string }, discriminant: string): string {
  return `${req.ip}::${discriminant}`;
}

export function registerAuth(app: FastifyInstance, deps: AuthRouteDeps, requireAuth?: Guard): void {
  const cfg = deps.loginRateLimit ?? { max: 10, windowMs: 60_000 };
  const limiter = new RateLimiter(cfg.max, cfg.windowMs);
  const signupLimiter = new RateLimiter(10, 60_000);
  const forgotLimiter = new RateLimiter(5, 60_000);
  const resetLimiter = new RateLimiter(10, 60_000);
  const acceptLimiter = new RateLimiter(10, 60_000);
  const googleLimiter = new RateLimiter(20, 60_000);

  app.post('/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof b.email !== 'string' || typeof b.password !== 'string' || b.email === '' || b.password === '') {
      return reply.code(400).send({ error: 'email et password requis' });
    }
    const email = b.email.trim().toLowerCase();
    // Rate-limit APRÈS le parse (la clé porte l'email) et AVANT le scrypt (protège le coût CPU du brute-force).
    if (!limiter.take(rateKey(req, email))) {
      return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    }

    const user = await deps.users.findByEmail(email);
    // TOUJOURS vérifier un hash (leurre si user absent) : même temps CPU -> pas de fuite d'existence.
    const ok = await verifyPassword(b.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      return reply.code(401).send({ error: 'identifiants invalides' });
    }

    const token = await signSession({ userId: user.id, tenantId: user.tenantId, role: user.role }, deps.secret);
    markLogin(deps, user.id);
    return reply.code(200).send({ token, user: { email: user.email, role: user.role, tenantId: user.tenantId } });
  });

  // Config publique : le front en a besoin pour afficher (ou non) le bouton Google.
  app.get('/auth/config', async (_req, reply) => {
    return reply.code(200).send({ googleClientId: deps.googleClientId ?? '', googleEnabled: !!deps.googleClientId });
  });

  // Se connecter avec Google : vérifie le jeton ID, connecte un compte existant OU crée un espace (inconnu).
  app.post('/auth/google', async (req, reply) => {
    if (!deps.verifyGoogle || !deps.getUserByEmail || !deps.createTenantWithAdmin) return reply.code(503).send({ error: 'connexion Google indisponible' });
    const idToken = str((req.body as { idToken?: unknown } | undefined)?.idToken);
    if (idToken === '') return reply.code(400).send({ error: 'idToken requis' });
    // Clé sur l'idToken Google : borne les tentatives par jeton, plus de blocage transverse.
    if (!googleLimiter.take(rateKey(req, idToken))) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    const identity = await deps.verifyGoogle(idToken);
    if (!identity || !identity.emailVerified) return reply.code(401).send({ error: 'jeton Google invalide' });
    const existing = await deps.getUserByEmail(identity.email);
    if (existing) {
      // Compte existant (actif OU invitation en attente) : Google fait foi (liaison par email vérifié).
      if (existing.disabled) return reply.code(403).send({ error: 'compte révoqué' });
      const jwt = await signSession({ userId: existing.id, tenantId: existing.tenantId, role: existing.role }, deps.secret);
      // APRÈS le contrôle `disabled` : un compte révoqué qui présente un jeton Google valide reçoit un 403 et
      // ne doit surtout pas être crédité d'une « dernière connexion » qui n'a pas eu lieu.
      markLogin(deps, existing.id);
      return reply.code(200).send({ token: jwt, user: { email: identity.email, role: existing.role, tenantId: existing.tenantId }, isNew: false });
    }
    // Email inconnu -> inscription libre via Google : nouvel espace + admin, SANS mot de passe (Google-only).
    // `name` borné : évite qu'un nom Google délirant remplisse le champ workspace (défense de surface, la base tronque de toute façon).
    const gname = (identity.name ?? '').slice(0, 60).trim();
    const workspaceName = gname !== '' ? `Espace de ${gname}` : 'Mon espace';
    const { tenantId, userId } = await deps.createTenantWithAdmin(workspaceName, { email: identity.email, name: identity.name, passwordHash: null });
    const jwt = await signSession({ userId, tenantId, role: 'admin' }, deps.secret);
    // Une inscription EST une connexion : sans ça un compte tout neuf, en train d'utiliser l'app, s'afficherait
    // « jamais connecté » sur la page Équipe jusqu'à sa première reconnexion.
    markLogin(deps, userId);
    // isNew:true -> le front envoie vers /accueil (onboarding « connecter ton numéro »), comme le signup email.
    return reply.code(201).send({ token: jwt, user: { email: identity.email, role: 'admin', tenantId }, isNew: true });
  });

  // Inscription LIBRE : crée un nouvel espace + admin, connecte directement.
  app.post('/auth/signup', async (req, reply) => {
    if (!deps.createTenantWithAdmin) return reply.code(503).send({ error: 'inscription indisponible' });
    const b = (req.body ?? {}) as { workspaceName?: unknown; email?: unknown; password?: unknown; name?: unknown };
    const workspaceName = str(b.workspaceName).trim();
    const email = str(b.email).trim().toLowerCase();
    const password = str(b.password);
    const name = str(b.name).trim() || null;
    if (workspaceName === '') return reply.code(400).send({ error: 'nom de l\'espace requis' });
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'email invalide' });
    if (!signupLimiter.take(rateKey(req, email))) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    if (password.length < MIN_PASSWORD) return reply.code(400).send({ error: `mot de passe trop court (min ${MIN_PASSWORD})` });
    try {
      const { tenantId, userId } = await deps.createTenantWithAdmin(workspaceName, { email, name, passwordHash: await hashPassword(password) });
      const token = await signSession({ userId, tenantId, role: 'admin' }, deps.secret);
      markLogin(deps, userId);
      return reply.code(201).send({ token, user: { email, role: 'admin', tenantId } });
    } catch (err) {
      if (err instanceof DuplicateEmailError) return reply.code(409).send({ error: 'un compte existe déjà avec cet email' });
      throw err;
    }
  });

  // Mot de passe perdu : TOUJOURS 200 (anti-énumération), envoie un lien si le compte existe.
  app.post('/auth/forgot-password', async (req, reply) => {
    const email = str((req.body as { email?: unknown } | undefined)?.email).trim().toLowerCase();
    // Clé sur l'email : plus de blocage transverse. Le 429 renvoie une erreur distincte, mais SANS fuite d'existence :
    // le take() précède tout accès à findByEmail, donc le seuil est identique que le compte existe ou non.
    if (!forgotLimiter.take(rateKey(req, email))) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    const generic = { ok: true, message: 'Si un compte existe pour cet email, un lien de réinitialisation a été envoyé.' };
    if (EMAIL_RE.test(email) && deps.tokens && deps.sendEmail && deps.appUrl) {
      try {
        const user = await deps.users.findByEmail(email); // null si inconnu / sans mdp (compte Google-only)
        if (user) {
          const raw = await deps.tokens.create('reset', user.id, deps.resetTtlMs ?? 60 * 60 * 1000);
          // Envoi en FIRE-AND-FORGET : la réponse ne dépend pas de la latence réseau de Resend -> pas d'oracle
          // de timing (le gros écart entre « email connu » et « inconnu » venait de l'appel réseau attendu).
          void deps.sendEmail({
            to: email,
            subject: 'Réinitialiser ton mot de passe',
            text: `Tu as demandé à réinitialiser ton mot de passe.\n\nClique sur ce lien (valide 1 h) :\n${deps.appUrl}/reset/${raw}\n\nSi tu n'es pas à l'origine de cette demande, ignore ce message.`,
          }).catch(() => {});
        }
      } catch {
        // On ne révèle JAMAIS une erreur ici (anti-énumération).
      }
    }
    return reply.code(200).send(generic);
  });

  // Réinitialisation : consomme le token (usage unique) et pose le nouveau mot de passe.
  app.post('/auth/reset-password', async (req, reply) => {
    if (!deps.tokens || !deps.setPassword) return reply.code(503).send({ error: 'réinitialisation indisponible' });
    const b = (req.body ?? {}) as { token?: unknown; password?: unknown };
    const token = str(b.token);
    const password = str(b.password);
    if (token === '') return reply.code(400).send({ error: 'token requis' });
    // Clé sur le token (pas d'email ici) : borne le brute-force d'UN lien sans bloquer les autres.
    if (!resetLimiter.take(rateKey(req, token))) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    if (password.length < MIN_PASSWORD) return reply.code(400).send({ error: `mot de passe trop court (min ${MIN_PASSWORD})` });
    const userId = await deps.tokens.consume('reset', token);
    if (!userId) return reply.code(400).send({ error: 'lien invalide ou expiré' });
    await deps.setPassword(userId, await hashPassword(password));
    return reply.code(200).send({ ok: true });
  });

  // Acceptation d'invitation : consomme le token (usage unique), pose le mot de passe, connecte directement.
  app.post('/auth/invitations/accept', async (req, reply) => {
    if (!deps.tokens || !deps.setPassword || !deps.sessionUser) return reply.code(503).send({ error: 'invitations indisponibles' });
    const b = (req.body ?? {}) as { token?: unknown; password?: unknown };
    const token = str(b.token);
    const password = str(b.password);
    if (token === '') return reply.code(400).send({ error: 'token requis' });
    // Clé sur le token d'invitation : borne le brute-force d'UN lien sans bloquer les autres.
    if (!acceptLimiter.take(rateKey(req, token))) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    if (password.length < MIN_PASSWORD) return reply.code(400).send({ error: `mot de passe trop court (min ${MIN_PASSWORD})` });
    const userId = await deps.tokens.consume('invite', token);
    if (!userId) return reply.code(400).send({ error: 'invitation invalide ou expirée' });
    const su = await deps.sessionUser(userId);
    if (!su) return reply.code(400).send({ error: 'invitation invalide ou expirée' });
    await deps.setPassword(userId, await hashPassword(password));
    const jwt = await signSession({ userId, tenantId: su.tenantId, role: su.role }, deps.secret);
    markLogin(deps, userId); // accepter une invitation, c'est se connecter pour la première fois
    return reply.code(200).send({ token: jwt, user: { email: su.email, role: su.role, tenantId: su.tenantId } });
  });

  // Changement de mot de passe (compte connecté) : vérifie le mdp courant.
  if (requireAuth) {
    app.post('/auth/change-password', { preHandler: requireAuth }, async (req, reply) => {
      if (!deps.getPasswordHash || !deps.setPassword) return reply.code(503).send({ error: 'indisponible' });
      const userId = req.auth?.userId;
      if (!userId) return reply.code(401).send({ error: 'authentification requise' });
      const b = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
      const current = str(b.currentPassword);
      const next = str(b.newPassword);
      if (next.length < MIN_PASSWORD) return reply.code(400).send({ error: `mot de passe trop court (min ${MIN_PASSWORD})` });
      const hash = await deps.getPasswordHash(userId);
      const ok = await verifyPassword(current, hash ?? DUMMY_HASH);
      if (!hash || !ok) return reply.code(401).send({ error: 'mot de passe actuel incorrect' });
      await deps.setPassword(userId, await hashPassword(next));
      return reply.code(200).send({ ok: true });
    });
  }
}
