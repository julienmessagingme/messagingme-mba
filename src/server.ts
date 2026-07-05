import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

/**
 * Construit l'instance Fastify (le "bouclier" du pattern async 3 étages).
 * Séparé du démarrage pour être injectable en test.
 *
 * Loop 1 (feature-loop) durcira /webhooks/meta : validation de signature
 * X-Hub-Signature-256, enqueue pg-boss durable, ACK < 50 ms, idempotence.
 */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({
    ok: true,
    service: 'messagingme-mba',
    ts: Date.now(),
  }));

  // Handshake de vérification du webhook Meta (GET hub.challenge).
  app.get('/webhooks/meta', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] !== undefined) {
      // TODO Loop 1: comparer q['hub.verify_token'] à config.META_VERIFY_TOKEN.
      return reply.code(200).send(q['hub.challenge'] ?? '');
    }
    return reply.code(400).send('bad request');
  });

  // Réception des webhooks Meta. Stub : ACK immédiat.
  // TODO Loop 1: valider la signature, enqueue le payload brut, dédup meta_message_id.
  app.post('/webhooks/meta', async (_req, reply) => {
    return reply.code(200).send({ received: true });
  });

  return app;
}
