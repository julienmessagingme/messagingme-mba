import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { RateLimiter } from '../auth/rate-limit';

export interface SupportRouteDeps {
  /** false si le support n'est pas configuré (clé Resend ou destinataire manquant) -> 503. */
  enabled: boolean;
  /** Envoie le message. Lève sur erreur réseau/Resend (mappée en 502 par la route, pas de 500 nu). */
  sendSupport(input: { tenantId: string; userId: string | null; email: string | null; subject: string; message: string }): Promise<void>;
  /**
   * Email du compte AUTHENTIFIÉ, résolu en base depuis `req.auth.userId`. C'est lui qui sert de reply-to.
   * Optionnel pour ne pas casser les suites qui construisent des deps minimales ; absent -> pas de reply-to,
   * jamais une adresse venue du client.
   */
  getUserEmail?(userId: string): Promise<string | null>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const SUBJECT_MAX = 200;
const MESSAGE_MAX = 5000;

/** Formulaire de support : POST le sujet + message, envoyé par email (Resend) à l'équipe. Auth requise ;
 *  le tenant + l'user (authentifiés) sont inclus, l'email du compte sert de reply-to. */
export function registerSupport(app: FastifyInstance, deps: SupportRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  // Un limiteur PROPRE à cet endpoint (jamais l'instance d'un autre : c'est la règle déjà posée dans
  // src/auth/routes.ts). Cadence calquée sur /auth/forgot-password, l'autre endpoint qui déclenche un email.
  //
  // Clé = userId, PAS req.ip. La route est authentifiée, donc l'identité est connue et c'est la bonne maille.
  // Surtout, Fastify n'est pas construit en `trustProxy` : derrière NPM, `req.ip` est l'IP du conteneur
  // mba-web, identique pour TOUT LE MONDE. Un limiteur par IP serait ici un plafond global à la plateforme,
  // qu'un seul utilisateur suffirait à épuiser pour tous les autres.
  const limiter = new RateLimiter(5, 60_000);

  app.post('/tenants/:tenantId/support', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const userId = req.auth?.userId ?? null;
    // Le 403 tenant reste prioritaire (il ne coûte rien et ne doit pas consommer de quota). Sans identité,
    // on retombe sur l'IP : moins bon, mais mieux que pas de plafond du tout.
    if (!limiter.take(userId ?? req.ip)) {
      return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    }
    if (!deps.enabled) return reply.code(503).send({ error: 'support indisponible (non configuré)' });

    const b = (req.body ?? {}) as { subject?: unknown; message?: unknown };
    if (!nonEmpty(b.subject)) return reply.code(400).send({ error: 'sujet requis' });
    if (!nonEmpty(b.message)) return reply.code(400).send({ error: 'message requis' });

    // Reply-to résolu EN BASE depuis le compte authentifié, jamais lu dans le corps de la requête : sinon
    // n'importe quel compte pouvait faire répondre l'équipe à l'adresse de son choix. Une panne de lookup ne
    // bloque pas l'envoi, elle le prive seulement de son reply-to.
    const email = userId ? await deps.getUserEmail?.(userId).catch(() => null) ?? null : null;

    try {
      await deps.sendSupport({
        tenantId: tenant,
        userId,
        email,
        subject: b.subject.trim().slice(0, SUBJECT_MAX),
        message: b.message.trim().slice(0, MESSAGE_MAX),
      });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      // JOURNALISER AVANT DE MASQUER (même règle que le handler d'erreur global de src/server.ts). Le `catch`
      // nu d'avant avalait aussi bien une panne Resend qu'une TypeError dans sendSupport : les deux rendaient
      // « réessaie plus tard », et l'utilisateur réessayait indéfiniment sur un bug qui ne passerait jamais.
      // `console.error` et non `req.log` : Fastify est construit en `logger: false`.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        lvl: 'error',
        msg: 'support_send_failed',
        tenant,
        userId,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }));
      return reply.code(502).send({ error: 'envoi impossible pour le moment, réessaie plus tard' });
    }
  });
}
