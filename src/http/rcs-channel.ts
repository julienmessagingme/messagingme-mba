import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { espaceVerifie, nonEmpty } from './scope';
import type { RcsChannelInfo, RcsChannelCheck } from '../rcs/channel-info';

export interface RcsChannelRouteDeps {
  /** État courant du canal pour ce workspace. null = pas activé. */
  etat(tenantId: string): Promise<{ agentId: string; brandName: string; displayName: string | null; status: string; checkedAt: string | null } | null>;
  /** Vérifie une clé chez le fournisseur sans rien enregistrer. */
  verifier(apiKey: string): Promise<RcsChannelCheck>;
  /** Enregistre une clé déjà vérifiée (chiffrement fait par l'appelant). */
  activer(tenantId: string, canal: RcsChannelInfo, apiKey: string): Promise<void>;
  desactiver(tenantId: string): Promise<boolean>;
}

/**
 * Activation du canal RCS d'un espace, depuis la page d'accueil. La clé n'est jamais relue par l'API (pas même
 * masquée) : l'écran montre ce qu'elle ouvre (agent, flux, quotas). Elle est vérifiée avant l'enregistrement,
 * car chez smsmode une clé de canal SMS passe l'authentification mais ne sert à rien en RCS.
 */
export function registerRcsChannel(app: FastifyInstance, deps: RcsChannelRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/rcs/channel', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const etat = await deps.etat(tenant);
    return reply.code(200).send({ active: etat !== null, ...(etat ? { channel: etat } : {}) });
  });

  app.post('/tenants/:tenantId/rcs/channel', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;

    const apiKey = (req.body as { apiKey?: unknown } | null)?.apiKey;
    if (!nonEmpty(apiKey)) return reply.code(400).send({ error: 'apiKey requise' });

    const check = await deps.verifier((apiKey as string).trim());
    if (!check.ok) {
      // 422 : une clé à corriger, pas une panne (un 5xx serait remplacé par la page d'erreur de Cloudflare).
      return reply.code(422).send({ error: check.detail, reason: check.reason });
    }

    await deps.activer(tenant, check.channel, (apiKey as string).trim());
    return reply.code(200).send({ active: true, channel: check.channel });
  });

  app.delete('/tenants/:tenantId/rcs/channel', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const fait = await deps.desactiver(tenant);
    if (!fait) return reply.code(404).send({ error: 'canal RCS non activé' });
    return reply.code(200).send({ active: false });
  });
}
