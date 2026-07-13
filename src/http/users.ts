import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../auth/password';
import { DuplicateEmailError } from '../user/store.pg';
import type { UserRow, CreateUserInput, UserMutation } from '../user/store.pg';
import type { Guard } from '../auth/middleware';

export interface UsersRouteDeps {
  listUsers(tenantId: string): Promise<UserRow[]>;
  createUser(tenantId: string, input: CreateUserInput): Promise<UserRow>;
  /** 'ok' | 'last_admin' (refusé : dernier admin actif) | 'not_found' (inconnu/hors tenant). */
  setUserRole(tenantId: string, userId: string, role: string): Promise<UserMutation>;
  /** Révoque (true) ou réactive (false) un compte. Mêmes garde-fous que le rôle. */
  setUserDisabled(tenantId: string, userId: string, disabled: boolean): Promise<UserMutation>;
  /** Supprime définitivement un compte. Refusé si dernier admin actif. */
  deleteUser(tenantId: string, userId: string): Promise<UserMutation>;
  /** Invitation : crée un compte EN ATTENTE (sans mdp). Absent -> invitations indisponibles (503). */
  createPendingUser?(tenantId: string, email: string, role: string): Promise<UserRow>;
  /** Génère un token d'invitation à usage unique pour ce compte, renvoie le token en clair. */
  createInviteToken?(userId: string): Promise<string>;
  /** Envoi de l'email d'invitation (Resend). Absent -> l'invitation est créée mais aucun email n'est envoyé. */
  sendEmail?(input: { to: string; subject: string; text: string }): Promise<void>;
  /** Base URL du front pour le lien d'invitation. */
  appUrl?: string;
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
        passwordHash: await hashPassword(b.password),
      });
      return reply.code(201).send({ user });
    } catch (err) {
      if (err instanceof DuplicateEmailError) return reply.code(409).send({ error: 'email déjà utilisé' });
      throw err;
    }
  });

  // Inviter un membre : crée un compte EN ATTENTE (sans mot de passe) + envoie un lien pour qu'il choisisse le sien.
  app.post('/tenants/:tenantId/invitations', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.createPendingUser || !deps.createInviteToken) return reply.code(503).send({ error: 'invitations indisponibles' });

    const b = (req.body ?? {}) as Partial<{ email: unknown; role: unknown }>;
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'email invalide' });
    if (typeof b.role !== 'string' || !ROLES.has(b.role)) return reply.code(400).send({ error: 'role invalide (admin|agent)' });

    try {
      const user = await deps.createPendingUser(tenant, email, b.role);
      const raw = await deps.createInviteToken(user.id);
      let emailSent = false;
      if (deps.sendEmail && deps.appUrl) {
        try {
          await deps.sendEmail({
            to: email,
            subject: 'Tu es invité sur MessagingMe',
            text: `Tu as été invité à rejoindre un espace sur MessagingMe.\n\nClique sur ce lien pour choisir ton mot de passe et activer ton compte (valide 7 jours) :\n${deps.appUrl}/invite/${raw}`,
          });
          emailSent = true;
        } catch {
          // L'invitation (compte + lien) est déjà créée ; l'admin pourra ré-inviter si l'email a échoué.
        }
      }
      return reply.code(201).send({ user, emailSent });
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

  // Révoquer (disabled=true) ou réactiver (false) un compte : login bloqué sans supprimer la ligne.
  app.patch('/tenants/:tenantId/users/:userId/disabled', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { userId } = req.params as { userId: string };
    const disabled = (req.body as { disabled?: unknown } | null)?.disabled;
    if (typeof disabled !== 'boolean') return reply.code(400).send({ error: 'disabled (booléen) requis' });
    // Self-block : ne pas se révoquer soi-même (auto-lockout).
    if (req.auth?.userId === userId) return reply.code(400).send({ error: 'tu ne peux pas révoquer ton propre compte' });
    const result = await deps.setUserDisabled(tenant, userId, disabled);
    if (result === 'not_found') return reply.code(404).send({ error: 'utilisateur inconnu' });
    if (result === 'last_admin') return reply.code(409).send({ error: 'au moins un administrateur actif est requis' });
    return reply.code(200).send({ id: userId, disabled });
  });

  // Supprimer définitivement un compte (irréversible). Mêmes garde-fous que la révocation.
  app.delete('/tenants/:tenantId/users/:userId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { userId } = req.params as { userId: string };
    // Self-block : ne pas supprimer son propre compte.
    if (req.auth?.userId === userId) return reply.code(400).send({ error: 'tu ne peux pas supprimer ton propre compte' });
    const result = await deps.deleteUser(tenant, userId);
    if (result === 'not_found') return reply.code(404).send({ error: 'utilisateur inconnu' });
    if (result === 'last_admin') return reply.code(409).send({ error: 'au moins un administrateur actif est requis' });
    return reply.code(200).send({ id: userId, deleted: true });
  });
}
