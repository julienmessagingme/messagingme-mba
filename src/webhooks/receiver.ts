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

/** Pourquoi un POST a été rejeté. La distinction est TOUT l'intérêt du journal, cf. `journalDeRejets`. */
type CauseDeRejet = 'signature_invalide' | 'signature_absente' | 'corps_absent';

/** Au plus une ligne par cause et par minute : un scanner ne doit pas noyer le journal. */
const REJET_THROTTLE_MS = 60_000;

/**
 * Le journal des POST refusés du webhook Meta.
 *
 * 🔴 POURQUOI IL EXISTE (lot 2 du programme II). Le rejet renvoyait 403 sans écrire une ligne. Or ces trois
 * causes ne disent pas du tout la même chose :
 *  - `signature_absente` : quelqu'un qui n'est pas Meta frappe à la porte. Du bruit, sauf en rafale.
 *  - `signature_invalide` : Meta nous appelle et notre `META_APP_SECRET` ne correspond pas. **100 % des
 *    entrants sont jetés**, et rien ne le dit : c'est exactement la panne indiagnosticable du 2026-08-17.
 *  - `corps_absent` : un POST vide, donc un problème de transport ou de proxy.
 *
 * Le compteur accompagne chaque ligne : « 1 rejet » et « 4 000 rejets » demandent deux réactions différentes,
 * et sans lui le throttle cacherait l'ampleur qu'il est censé rendre lisible.
 *
 * ⚠️ N'écrit JAMAIS le corps ni la signature reçue : un journal ne doit pas devenir la copie du secret qu'il
 * observe, ni du message d'un client.
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
    // `depuis` compte CE rejet-ci compris : il est incrémenté avant le test de throttle, donc il vaut
    // exactement le nombre de rejets survenus depuis la dernière ligne. Un `+ 1` de plus recompterait
    // celui-ci deux fois (le test de rafale l'a attrapé : il annonçait 51 pour 50 rejets).
    etat.depuis += 1;
    if (maintenant - etat.a < REJET_THROTTLE_MS) return;
    // eslint-disable-next-line no-console
    console.warn(`webhook Meta REFUSÉ (${cause}) : ${etat.depuis} rejets depuis la dernière ligne`);
    dernier.set(cause, { a: maintenant, depuis: 0 });
  };
}

/**
 * Enregistre les routes du webhook Meta sur `app`.
 * Le bouclier : signature validée, ACK immédiat, enqueue du brut. Zéro métier ici.
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
      // La CAUSE est déterminée ici, où on l'a encore : `signature_invalide` est la seule des trois qui
      // signifie « Meta nous parle et on jette tout ». La réponse au client, elle, ne change pas (403 nu) :
      // on ne renseigne pas un appelant non authentifié sur la raison de son échec.
      signalerRejet(!raw ? 'corps_absent' : sigHeader === undefined ? 'signature_absente' : 'signature_invalide');
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
