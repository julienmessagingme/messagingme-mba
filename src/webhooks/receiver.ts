import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parse as secureJsonParse } from 'secure-json-parse';
import { verifyMetaSignature, timingSafeEqualStr } from '../lib/signature';
import type { Queue } from '../queue/queue';
import { nAQueDesAccuses, cleDeContact } from './parse';

export interface ReceiverOptions {
  verifyToken: string;
  appSecret: string;
  queueName?: string;
  /** File des accusés de livraison. Défaut `webhook-status`. Injectable pour les tests. */
  queueNameStatuts?: string;
}

type WithRawBody = FastifyRequest & { rawBody?: Buffer };

/** Pourquoi un POST a été rejeté : la distinction fait tout l'intérêt du journal (`journalDeRejets`). */
type CauseDeRejet = 'signature_invalide' | 'signature_absente' | 'corps_absent';

/** Au plus une ligne par cause et par minute : un scanner ne doit pas noyer le journal. */
const REJET_THROTTLE_MS = 60_000;

/**
 * Le journal des POST refusés du webhook Meta, par cause :
 *  - `signature_absente` : quelqu'un qui n'est pas Meta frappe à la porte, du bruit sauf en rafale ;
 *  - `signature_invalide` : Meta nous appelle et `META_APP_SECRET` ne correspond pas, donc 100 % des entrants
 *    sont jetés ;
 *  - `corps_absent` : un POST vide, problème de transport ou de proxy.
 * Le compteur accompagne chaque ligne (« 1 rejet » et « 4 000 rejets » n'appellent pas la même réaction).
 * N'écrit jamais le corps ni la signature reçue.
 */
function journalDeRejets(): (cause: CauseDeRejet) => void {
  const dernier = new Map<CauseDeRejet, { a: number; depuis: number }>();
  return (cause) => {
    const maintenant = Date.now();
    const etat = dernier.get(cause);
    if (etat === undefined) {
      dernier.set(cause, { a: maintenant, depuis: 0 });
      // eslint-disable-next-line no-console
      console.warn(`webhook Meta REFUSÉ (${cause}) : 1 rejet`);
      return;
    }
    // `depuis` compte ce rejet-ci compris (incrémenté avant le test de throttle) : c'est exactement le nombre de
    // rejets depuis la dernière ligne, sans `+ 1`.
    etat.depuis += 1;
    if (maintenant - etat.a < REJET_THROTTLE_MS) return;
    // eslint-disable-next-line no-console
    console.warn(`webhook Meta REFUSÉ (${cause}) : ${etat.depuis} rejets depuis la dernière ligne`);
    dernier.set(cause, { a: maintenant, depuis: 0 });
  };
}

/**
 * Enregistre les routes du webhook Meta : signature validée, ACK immédiat, mise en file du brut. Aucun métier ici.
 */
export function registerReceiver(app: FastifyInstance, queue: Queue, opts: ReceiverOptions): void {
  const queueName = opts.queueName ?? 'webhook';
  const queueNameStatuts = opts.queueNameStatuts ?? 'webhook-status';
  const signalerRejet = journalDeRejets();

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
        // JSON invalide : pas de 500 (Meta retenterait). On garde rawBody, et la validation de signature rejette tout
        // corps forgé en 403 ; un webhook Meta authentique est toujours du JSON valide.
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
      // La cause se détermine ici : `signature_invalide` est la seule qui veut dire « Meta nous parle et on jette
      // tout ». La réponse reste un 403 nu : on ne renseigne pas un appelant non authentifié.
      signalerRejet(!raw ? 'corps_absent' : sigHeader === undefined ? 'signature_absente' : 'signature_invalide');
      return reply.code(403).send({ error: 'invalid signature' });
    }
    // Aiguillage : un payload qui ne contient que des accusés de livraison part sur sa propre file, pour qu'une
    // rafale de campagne ne passe pas devant la réponse d'un vrai client. Le test est un parcours d'objet, l'ACK à
    // Meta reste immédiat. Tout le reste (message, echo, handover, mixte) va sur la file des entrants, qui sait
    // aussi traiter les accusés : aucun événement perdu.
    // Clé de groupe = le contact : pg-boss plafonne à un job en vol par groupe, ce qui garde l'ordre des messages
    // d'un même contact sans sérialiser les contacts entre eux. `undefined` -> aucun groupe (cf. `cleDeContact`).
    const groupId = cleDeContact(req.body);
    await queue.enqueue(
      nAQueDesAccuses(req.body) ? queueNameStatuts : queueName,
      req.body,
      groupId === undefined ? undefined : { groupId },
    );
    return reply.code(200).send({ received: true });
  });
}
