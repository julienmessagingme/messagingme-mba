import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { RateLimiter } from '../auth/rate-limit';
import { espaceVerifie, nonEmpty } from './scope';
import { texteDe } from '../lib/erreur';

export interface SupportRouteDeps {
  /** false si le support n'est pas configuré (clé Resend ou destinataire manquant) -> 503. */
  enabled: boolean;
  /** Envoie le message. Lève sur erreur réseau/Resend (mappée en 422 par la route, pas de 500 nu). */
  sendSupport(input: { tenantId: string; userId: string | null; email: string | null; subject: string; message: string }): Promise<void>;
  /**
   * Email du compte authentifié, résolu en base depuis `req.auth.userId`, qui sert de reply-to.
   * `null` -> pas de reply-to, jamais une adresse venue du client.
   */
  getUserEmail(userId: string): Promise<string | null>;
}

const SUBJECT_MAX = 200;
const MESSAGE_MAX = 5000;

/** Formulaire de support : POST le sujet + message, envoyé par email (Resend) à l'équipe. Auth requise ;
 *  le tenant + l'user (authentifiés) sont inclus, l'email du compte sert de reply-to. */
export function registerSupport(app: FastifyInstance, deps: SupportRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  // Limiteur propre à cet endpoint, cadence calquée sur /auth/forgot-password. Clé = userId, pas req.ip : sans
  // `trustProxy`, derrière NPM, `req.ip` est le même pour tous (un plafond global qu'un seul épuiserait).
  const limiter = new RateLimiter(5, 60_000);

  app.post('/tenants/:tenantId/support', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
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

    // Reply-to résolu en base depuis le compte authentifié, jamais lu dans le corps (sinon n'importe qui ferait
    // répondre l'équipe à l'adresse de son choix). Une panne de lookup prive seulement l'envoi de son reply-to.
    const email = userId ? await deps.getUserEmail(userId).catch(() => null) : null;

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
      // Journaliser avant de masquer : sinon une panne Resend et un bug rendent le même « réessaie plus tard ».
      // `console.error` et non `req.log` : Fastify est construit en `logger: false`.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        lvl: 'error',
        msg: 'support_send_failed',
        tenant,
        userId,
        err: texteDe(err),
        stack: err instanceof Error ? err.stack : undefined,
      }));
      // 422 et pas 502 : l'écran affiche ce message tel quel, et Cloudflare remplace le corps de toute 5xx.
      return reply.code(422).send({ error: 'envoi impossible pour le moment, réessaie plus tard' });
    }
  });
}
