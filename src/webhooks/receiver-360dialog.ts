import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqualStr } from '../lib/signature';
import { journaliser } from '../lib/journal';
import type { Queue } from '../queue/queue';
import { numeroBusinessDuChange, valeurEffective } from './change';
import { nAQueDesAccuses, cleDeContact } from './parse';

/**
 * La réception des webhooks d'un numéro porté par 360dialog (BSP). 360dialog relaie le format de Meta, mais ne le
 * signe pas : `/webhooks/meta`, qui exige `X-Hub-Signature-256`, refuserait tout. L'autorité est ici un Basic auth
 * que 360dialog renvoie à chaque appel (`headers` de `POST /v1/configs/webhook`), propre à CHAQUE numéro : son mot de
 * passe est `secretDuNumero(D360_WEBHOOK_SECRET, phoneNumberId)`. Aucune table : un secret qui fuit n'ouvre qu'un
 * numéro, et changer `D360_WEBHOOK_SECRET` les révoque tous (à reposer chez 360dialog, `scripts/webhook-360dialog.mts`).
 *
 * Ensuite, le même versement que le récepteur de Meta (mêmes files, même groupe par contact) : le worker ne voit pas
 * la différence. Monté seulement quand `D360_WEBHOOK_SECRET` est posé (absent : 404).
 */
export interface Receiver360Deps {
  queue: Queue;
  /** `D360_WEBHOOK_SECRET`. Jamais vide : le câblage ne monte pas le module sans lui. */
  secret: string;
}

/** Le mot de passe du Basic d'un numéro. Le script qui pose le webhook chez 360dialog l'importe. */
export function secretDuNumero(secret: string, phoneNumberId: string): string {
  return createHmac('sha256', secret).update(phoneNumberId, 'utf8').digest('hex');
}

/** L'en-tête `Authorization` attendu pour un numéro. L'utilisateur est fixe, seul le mot de passe porte l'autorité. */
export function enteteDuNumero(secret: string, phoneNumberId: string): string {
  return `Basic ${Buffer.from(`360dialog:${secretDuNumero(secret, phoneNumberId)}`, 'utf8').toString('base64')}`;
}

// La forme minimale lue ici ; le reste voyage tel quel jusqu'au worker, qui a ses propres lecteurs.
const corpsSchema = z.object({
  entry: z.array(z.object({ changes: z.array(z.object({ value: z.unknown() }).passthrough()) }).passthrough()),
}).passthrough();

export function registerReceiver360(app: FastifyInstance, deps: Receiver360Deps): void {
  app.post('/webhooks/360dialog/:phoneNumberId', async (req, reply) => {
    const { phoneNumberId } = req.params as { phoneNumberId: string };

    // 1. 🔴 L'autorité, avant de lire le corps.
    const entete = req.headers['authorization'];
    const recu = Array.isArray(entete) ? entete[0] : entete;
    if (recu === undefined || !timingSafeEqualStr(recu, enteteDuNumero(deps.secret, phoneNumberId))) {
      return reply.code(401).send({ error: 'non autorisé' });
    }

    const corps = corpsSchema.safeParse(req.body);
    if (!corps.success) return reply.code(400).send({ error: 'corps illisible' });

    // 2. 🔴 Chaque changement parle de CE numéro. Sans cette garde, le secret d'un numéro injecterait des messages au
    // nom de n'importe quel autre, numéros de Meta compris. Un changement sans numéro (événement de niveau WABA,
    // comme le statut d'un modèle) n'est pas versé : rien ne dit qu'il concerne ce numéro.
    let etranger = false;
    let sansNumero = 0;
    const entry = corps.data.entry
      .map((e) => ({
        ...e,
        changes: e.changes.filter((c) => {
          const numero = numeroBusinessDuChange(valeurEffective(c.value));
          if (numero === undefined) { sansNumero += 1; return false; }
          if (numero !== phoneNumberId) etranger = true;
          return true;
        }),
      }))
      .filter((e) => e.changes.length > 0);
    if (etranger) {
      journaliser('warn', 'webhook_360dialog_numero_etranger', { phoneNumberId });
      return reply.code(403).send({ error: 'numéro étranger à cette adresse' });
    }
    if (sansNumero > 0) journaliser('info', 'webhook_360dialog_sans_numero', { phoneNumberId, ignores: sansNumero });
    if (entry.length === 0) return reply.code(200).send({ received: true });

    // 3. Le versement du récepteur de Meta (`./receiver.ts`).
    const payload = { ...corps.data, entry };
    const groupId = cleDeContact(payload);
    await deps.queue.enqueue(
      nAQueDesAccuses(payload) ? 'webhook-status' : 'webhook',
      payload,
      groupId === undefined ? undefined : { groupId },
    );
    return reply.code(200).send({ received: true });
  });
}
