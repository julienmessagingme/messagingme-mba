import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { verifyPassword, hashPassword } from './password';
import { signSession } from './token';
import { RateLimiter } from './rate-limit';
import type { UserAuthStore } from './store';

export interface AuthRouteDeps {
  users: UserAuthStore;
  secret: string;
  /** Rate-limit du login (par IP). Défaut : 10 tentatives / minute. */
  loginRateLimit?: { max: number; windowMs: number };
}

// Hash leurre (format scrypt valide) pour égaliser le temps CPU quand l'email est inconnu :
// verifyPassword est TOUJOURS exécuté, supprimant l'oracle temporel d'énumération de comptes.
const DUMMY_HASH = hashPassword(randomBytes(24).toString('hex'));

/** POST /auth/login {email, password} -> { token, user }. 401 si invalide, 429 si trop de tentatives. */
export function registerAuth(app: FastifyInstance, deps: AuthRouteDeps): void {
  const cfg = deps.loginRateLimit ?? { max: 10, windowMs: 60_000 };
  const limiter = new RateLimiter(cfg.max, cfg.windowMs);

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
}
