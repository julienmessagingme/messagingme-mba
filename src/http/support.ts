import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';

export interface SupportRouteDeps {
  /** false si le support n'est pas configuré (clé Resend ou destinataire manquant) -> 503. */
  enabled: boolean;
  /** Envoie le message. Lève sur erreur réseau/Resend (mappée en 502 par la route, pas de 500 nu). */
  sendSupport(input: { tenantId: string; userId: string | null; email: string | null; subject: string; message: string }): Promise<void>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmail = (v: unknown): v is string => typeof v === 'string' && EMAIL_RE.test(v.trim());

const SUBJECT_MAX = 200;
const MESSAGE_MAX = 5000;

/** Formulaire de support : POST le sujet + message, envoyé par email (Resend) à l'équipe. Auth requise ;
 *  le tenant + l'user (authentifiés) sont inclus, l'email de l'expéditeur sert de reply-to. */
export function registerSupport(app: FastifyInstance, deps: SupportRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.post('/tenants/:tenantId/support', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.enabled) return reply.code(503).send({ error: 'support indisponible (non configuré)' });

    const b = (req.body ?? {}) as { subject?: unknown; message?: unknown; email?: unknown };
    if (!nonEmpty(b.subject)) return reply.code(400).send({ error: 'sujet requis' });
    if (!nonEmpty(b.message)) return reply.code(400).send({ error: 'message requis' });
    const email = isEmail(b.email) ? b.email.trim() : null;

    try {
      await deps.sendSupport({
        tenantId: tenant,
        userId: req.auth?.userId ?? null,
        email,
        subject: b.subject.trim().slice(0, SUBJECT_MAX),
        message: b.message.trim().slice(0, MESSAGE_MAX),
      });
      return reply.code(200).send({ ok: true });
    } catch {
      // Erreur reseau/Resend -> 502 propre : l'UI affiche un message clair, jamais un 500 nu.
      return reply.code(502).send({ error: 'envoi impossible pour le moment, réessaie plus tard' });
    }
  });
}
