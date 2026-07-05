import type { FastifyInstance } from 'fastify';
import { verifyPassword } from './password';
import { signSession } from './token';
import type { UserAuthStore } from './store';

export interface AuthRouteDeps {
  users: UserAuthStore;
  secret: string;
}

/** POST /auth/login {email, password} -> { token, user }. 401 si identifiants invalides. */
export function registerAuth(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post('/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof b.email !== 'string' || typeof b.password !== 'string' || b.email === '' || b.password === '') {
      return reply.code(400).send({ error: 'email et password requis' });
    }
    const user = await deps.users.findByEmail(b.email.trim().toLowerCase());
    // Toujours vérifier un hash (même si user absent) pour ne pas révéler l'existence du compte.
    const ok = user ? verifyPassword(b.password, user.passwordHash) : false;
    if (!user || !ok) {
      return reply.code(401).send({ error: 'identifiants invalides' });
    }
    const token = await signSession({ userId: user.id, tenantId: user.tenantId, role: user.role }, deps.secret);
    return reply.code(200).send({ token, user: { email: user.email, role: user.role, tenantId: user.tenantId } });
  });
}
