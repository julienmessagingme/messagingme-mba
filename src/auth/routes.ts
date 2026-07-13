import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { verifyPassword, hashPassword, hashPasswordSync } from './password';
import { signSession } from './token';
import { RateLimiter } from './rate-limit';
import type { UserAuthStore } from './store';
import type { UserStateLoader, Guard } from './middleware';
import { DuplicateEmailError } from '../user/store.pg';

export interface AuthRouteDeps {
  users: UserAuthStore;
  secret: string;
  /** Rate-limit du login (par IP). Défaut : 10 tentatives / minute. */
  loginRateLimit?: { max: number; windowMs: number };
  /** Re-vérification par requête de l'état du compte (révoqué/supprimé/rôle frais). Optionnel :
   *  absent en test (JWT seul). Voir makeRequireAuth. */
  getUserState?: UserStateLoader;
  /** Inscription libre : crée un espace + admin. Absent -> signup indisponible (503). */
  createTenantWithAdmin?(workspaceName: string, admin: { email: string; name: string | null; passwordHash: string }): Promise<{ tenantId: string; userId: string }>;
  /** Pose (écrase) le hash de mot de passe d'un compte (reset / changement). */
  setPassword?(userId: string, hash: string): Promise<boolean>;
  /** Hash de mot de passe courant d'un compte (vérification au changement). null si absent/sans mdp. */
  getPasswordHash?(userId: string): Promise<string | null>;
  /** Tokens à usage unique (reset / invite). */
  tokens?: {
    create(purpose: 'reset' | 'invite', userId: string, ttlMs: number): Promise<string>;
    consume(purpose: 'reset' | 'invite', raw: string): Promise<string | null>;
  };
  /** Envoi d'email (Resend) pour les liens. Absent -> forgot-password répond 200 sans rien envoyer. */
  sendEmail?(input: { to: string; subject: string; text: string }): Promise<void>;
  /** Base URL du front pour les liens d'email. */
  appUrl?: string;
  /** Durée de validité d'un lien de reset (ms). */
  resetTtlMs?: number;
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
export function registerAuth(app: FastifyInstance, deps: AuthRouteDeps, requireAuth?: Guard): void {
  const cfg = deps.loginRateLimit ?? { max: 10, windowMs: 60_000 };
  const limiter = new RateLimiter(cfg.max, cfg.windowMs);
  const signupLimiter = new RateLimiter(10, 60_000);
  const forgotLimiter = new RateLimiter(5, 60_000);
  const resetLimiter = new RateLimiter(10, 60_000);

  app.post('/auth/login', async (req, reply) => {
    if (!limiter.take(req.ip)) {
      return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    }

    const b = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof b.email !== 'string' || typeof b.password !== 'string' || b.email === '' || b.password === '') {
      return reply.code(400).send({ error: 'email et password requis' });
    }

    const user = await deps.users.findByEmail(b.email.trim().toLowerCase());
    // TOUJOURS vérifier un hash (leurre si user absent) : même temps CPU -> pas de fuite d'existence.
    const ok = await verifyPassword(b.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      return reply.code(401).send({ error: 'identifiants invalides' });
    }

    const token = await signSession({ userId: user.id, tenantId: user.tenantId, role: user.role }, deps.secret);
    return reply.code(200).send({ token, user: { email: user.email, role: user.role, tenantId: user.tenantId } });
  });

  // Inscription LIBRE : crée un nouvel espace + admin, connecte directement.
  app.post('/auth/signup', async (req, reply) => {
    if (!deps.createTenantWithAdmin) return reply.code(503).send({ error: 'inscription indisponible' });
    if (!signupLimiter.take(req.ip)) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    const b = (req.body ?? {}) as { workspaceName?: unknown; email?: unknown; password?: unknown; name?: unknown };
    const workspaceName = str(b.workspaceName).trim();
    const email = str(b.email).trim().toLowerCase();
    const password = str(b.password);
    const name = str(b.name).trim() || null;
    if (workspaceName === '') return reply.code(400).send({ error: 'nom de l\'espace requis' });
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'email invalide' });
    if (password.length < MIN_PASSWORD) return reply.code(400).send({ error: `mot de passe trop court (min ${MIN_PASSWORD})` });
    try {
      const { tenantId, userId } = await deps.createTenantWithAdmin(workspaceName, { email, name, passwordHash: await hashPassword(password) });
      const token = await signSession({ userId, tenantId, role: 'admin' }, deps.secret);
      return reply.code(201).send({ token, user: { email, role: 'admin', tenantId } });
    } catch (err) {
      if (err instanceof DuplicateEmailError) return reply.code(409).send({ error: 'un compte existe déjà avec cet email' });
      throw err;
    }
  });

  // Mot de passe perdu : TOUJOURS 200 (anti-énumération), envoie un lien si le compte existe.
  app.post('/auth/forgot-password', async (req, reply) => {
    if (!forgotLimiter.take(req.ip)) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    const email = str((req.body as { email?: unknown } | undefined)?.email).trim().toLowerCase();
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
    if (!resetLimiter.take(req.ip)) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    const b = (req.body ?? {}) as { token?: unknown; password?: unknown };
    const token = str(b.token);
    const password = str(b.password);
    if (token === '') return reply.code(400).send({ error: 'token requis' });
    if (password.length < MIN_PASSWORD) return reply.code(400).send({ error: `mot de passe trop court (min ${MIN_PASSWORD})` });
    const userId = await deps.tokens.consume('reset', token);
    if (!userId) return reply.code(400).send({ error: 'lien invalide ou expiré' });
    await deps.setPassword(userId, await hashPassword(password));
    return reply.code(200).send({ ok: true });
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
