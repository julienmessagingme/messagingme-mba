import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { scopeTenant, nonEmpty } from './scope';
import type { RcsChannelInfo, RcsChannelCheck } from '../rcs/channel-info';

export interface RcsChannelRouteDeps {
  /** État courant du canal pour ce workspace. null = pas activé. */
  etat(tenantId: string): Promise<{ agentId: string; brandName: string; displayName: string | null; status: string; checkedAt: string | null } | null>;
  /** Vérifie une clé chez le fournisseur SANS rien enregistrer. */
  verifier(apiKey: string): Promise<RcsChannelCheck>;
  /** Enregistre une clé DÉJÀ vérifiée (chiffrement fait par l'appelant). */
  activer(tenantId: string, canal: RcsChannelInfo, apiKey: string): Promise<void>;
  desactiver(tenantId: string): Promise<boolean>;
}

/**
 * Activation du canal RCS d'un workspace, depuis la page d'accueil, sous le numéro WhatsApp.
 *
 * La clé n'est JAMAIS relue par l'API : on ne la renvoie pas, même masquée. L'écran affiche ce qu'elle
 * OUVRE (agent, flux, quotas), ce qui est l'information utile, et jamais le secret lui-même.
 *
 * La vérification est faite AVANT l'enregistrement, et son échec est explicite. C'est important : chez
 * smsmode une clé est rattachée à un canal, et une clé de canal SMS passe l'authentification tout en étant
 * inutilisable en RCS. Sans ce contrôle, l'opérateur croirait avoir activé le canal et ne le découvrirait
 * qu'au premier envoi raté.
 */
export function registerRcsChannel(app: FastifyInstance, deps: RcsChannelRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/rcs/channel', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const etat = await deps.etat(tenant);
    return reply.code(200).send({ active: etat !== null, ...(etat ? { channel: etat } : {}) });
  });

  app.post('/tenants/:tenantId/rcs/channel', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;

    const apiKey = (req.body as { apiKey?: unknown } | null)?.apiKey;
    if (!nonEmpty(apiKey)) return reply.code(400).send({ error: 'apiKey requise' });

    const check = await deps.verifier((apiKey as string).trim());
    if (!check.ok) {
      // 422 et non 500 : c'est une saisie à corriger, pas une panne. Et un 5xx serait remplacé par la page
      // d'erreur de Cloudflare, donc le message n'atteindrait jamais l'opérateur.
      return reply.code(422).send({ error: check.detail, reason: check.reason });
    }

    await deps.activer(tenant, check.channel, (apiKey as string).trim());
    return reply.code(200).send({ active: true, channel: check.channel });
  });

  app.delete('/tenants/:tenantId/rcs/channel', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const fait = await deps.desactiver(tenant);
    if (!fait) return reply.code(404).send({ error: 'canal RCS non activé' });
    return reply.code(200).send({ active: false });
  });
}
