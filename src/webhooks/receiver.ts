import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parse as secureJsonParse } from 'secure-json-parse';
import { verifyMetaSignature, timingSafeEqualStr } from '../lib/signature';
import type { Queue } from '../queue/queue';
import { nAQueDesAccuses } from './parse';

export interface ReceiverOptions {
  verifyToken: string;
  appSecret: string;
  queueName?: string;
  /** File des ACCUSÉS de livraison. Défaut `webhook-status`. Injectable pour les tests. */
  queueNameStatuts?: string;
}

type WithRawBody = FastifyRequest & { rawBody?: Buffer };

/**
 * Enregistre les routes du webhook Meta sur `app`.
 * Le bouclier : signature validée, ACK immédiat, enqueue du brut. Zéro métier ici.
 */
export function registerReceiver(app: FastifyInstance, queue: Queue, opts: ReceiverOptions): void {
  const queueName = opts.queueName ?? 'webhook';
  const queueNameStatuts = opts.queueNameStatuts ?? 'webhook-status';

  // Parser JSON en buffer : garde le corps brut pour la validation de signature.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      const buf = body as Buffer;
      (req as WithRawBody).rawBody = buf;
      try {
        // secure-json-parse : neutralise __proto__/constructor (anti prototype-poisoning),
        // garde comme le parser Fastify par défaut qu'on remplace pour capturer rawBody.
        done(
          null,
          buf.length
            ? secureJsonParse(buf.toString('utf8'), { protoAction: 'remove', constructorAction: 'remove' })
            : {},
        );
      } catch {
        // JSON invalide : ne PAS renvoyer 500 (Meta retenterait). On garde rawBody ;
        // la validation de signature (sur rawBody) rejette tout corps forgé en 403.
        // Un webhook Meta authentique est toujours du JSON valide.
        done(null, {});
      }
    },
  );

  // Handshake de vérification du webhook.
  app.get('/webhooks/meta', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const token = q['hub.verify_token'];
    if (
      q['hub.mode'] === 'subscribe' &&
      opts.verifyToken !== '' &&
      token !== undefined &&
      timingSafeEqualStr(token, opts.verifyToken)
    ) {
      return reply.code(200).send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send('forbidden');
  });

  // Réception : signature -> enqueue -> ACK. Aucun parse, aucune DB.
  app.post('/webhooks/meta', async (req, reply) => {
    const raw = (req as WithRawBody).rawBody;
    const sig = req.headers['x-hub-signature-256'];
    const sigHeader = Array.isArray(sig) ? sig[0] : sig;
    if (!raw || !verifyMetaSignature(raw, sigHeader, opts.appSecret)) {
      return reply.code(403).send({ error: 'invalid signature' });
    }
    // 🔴 AIGUILLAGE (lot 6) : un payload qui ne contient QUE des accusés de livraison part sur sa propre file.
    // Une campagne de 5 000 messages produit trois accusés par destinataire ; sur une file unique, cette
    // rafale passait DEVANT la réponse d'un vrai client, qui attendait derrière quinze mille jobs. Le test
    // est un parcours d'objet, quelques microsecondes : l'accusé de réception à Meta reste immédiat, ce qui
    // était la raison de ne rien parser ici.
    //
    // Tout ce qui n'est pas un accusé PUR (message, echo, handover, payload mixte) reste sur la file des
    // entrants, qui sait aussi traiter les accusés : on ne perd donc jamais un événement, au pire on renonce
    // à l'optimisation.
    await queue.enqueue(nAQueDesAccuses(req.body) ? queueNameStatuts : queueName, req.body);
    return reply.code(200).send({ received: true });
  });
}
