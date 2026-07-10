import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../auth/password';
import { DuplicateEmailError } from '../user/store.pg';
import type { UserRow, CreateUserInput } from '../user/store.pg';
import type { Guard } from '../auth/middleware';

export interface UsersRouteDeps {
  listUsers(tenantId: string): Promise<UserRow[]>;
  createUser(tenantId: string, input: CreateUserInput): Promise<UserRow>;
  /** 'updated' | 'last_admin' (refusé : dernier admin) | 'not_found' (inconnu/hors tenant). */
  setUserRole(tenantId: string, userId: string, role: string): Promise<'updated' | 'last_admin' | 'not_found'>;
}

const ROLES = new Set(['admin', 'agent']);
const MIN_PASSWORD = 8;
// Validation d'email minimale (un @, pas d'espace) : le vrai contrôle d'unicité est en base.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/**
 * Gestion des comptes (onglet Admin). Le GROUPE est réservé aux admins via `guard`
 * (`[requireAuth, makeRequireRole(['admin'])]`) : pas de garde de rôle en plus ici, la barrière
 * est au preHandler. On ne renvoie jamais le hash ; les mots de passe ne sont jamais journalisés.
 */
export function registerUsers(app: FastifyInstance, deps: UsersRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/users', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ users: await deps.listUsers(tenant) });
  });

  app.post('/tenants/:tenantId/users', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });

    const b = (req.body ?? {}) as Partial<{ email: unknown; password: unknown; role: unknown; name: unknown }>;
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'email invalide' });
    if (typeof b.password !== 'string' || b.password.length < MIN_PASSWORD) {
      return reply.code(400).send({ error: `mot de passe requis (min ${MIN_PASSWORD} caractères)` });
    }
    if (typeof b.role !== 'string' || !ROLES.has(b.role)) {
      return reply.code(400).send({ error: 'role invalide (admin|agent)' });
    }
    const name = typeof b.name === 'string' && b.name.trim() !== '' ? b.name.trim() : null;

    try {
      const user = await deps.createUser(tenant, {
        email,
        name,
        role: b.role,
        passwordHash: hashPassword(b.password),
      });
      return reply.code(201).send({ user });
    } catch (err) {
      if (err instanceof DuplicateEmailError) return reply.code(409).send({ error: 'email déjà utilisé' });
      throw err;
    }
  });

  app.patch('/tenants/:tenantId/users/:userId/role', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { userId } = req.params as { userId: string };

    const role = (req.body as { role?: unknown } | null)?.role;
    if (typeof role !== 'string' || !ROLES.has(role)) {
      return reply.code(400).send({ error: 'role invalide (admin|agent)' });
    }
    // Self-block : un admin ne peut pas changer son PROPRE rôle (évite l'auto-lockout de l'UI en
    // pleine session). L'invariant « ≥1 admin par tenant » est réellement garanti EN BASE par
    // setUserRole (refus 'last_admin'), pas par ce seul self-block.
    if (req.auth?.userId === userId) {
      return reply.code(400).send({ error: 'tu ne peux pas changer ton propre rôle' });
    }
    // NB : le rôle vit dans le JWT (TTL du token) ; une rétrogradation prend pleinement effet au
    // plus tard à l'expiration/reconnexion. L'invariant base ci-dessus empêche néanmoins le zéro-admin.
    const result = await deps.setUserRole(tenant, userId, role);
    if (result === 'not_found') return reply.code(404).send({ error: 'utilisateur inconnu' });
    if (result === 'last_admin') return reply.code(409).send({ error: 'au moins un administrateur est requis' });
    return reply.code(200).send({ id: userId, role });
  });
}
