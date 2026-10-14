import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { journaliser } from '../lib/journal';
import { EVENEMENTS_RESEND, type EvenementResend } from '../emails-produit/store.pg';

/**
 * LE WEBHOOK DE RESEND (lot 7), classe `signature-service` : ce que deviennent les e-mails du produit (livré, ouvert,
 * cliqué, rebond, plainte), noté sur la ligne du journal par l'identifiant que Resend a rendu à l'envoi. Ce sont les
 * chiffres du mois de `/ops`.
 *
 * 🔴 LA SIGNATURE, SUR LE CORPS BRUT, AVANT DE LIRE QUOI QUE CE SOIT. Resend signe par Svix : en-têtes `svix-id`,
 * `svix-timestamp`, `svix-signature` (`v1,<base64>` séparés par des espaces pendant une rotation), HMAC SHA-256 de
 * `<id>.<timestamp>.<corps>` avec le secret `whsec_<base64>` de la destination. Comparaison à temps constant ; la
 * fraîcheur (cinq minutes) après la signature, comme pour Stripe. Secret vide : tout est refusé.
 *
 * Une plainte (« indésirable ») désinscrit la personne des e-mails commerciaux : lui en envoyer d'autres nuirait à la
 * délivrabilité de tous nos e-mails, alertes comprises.
 */

export const TOLERANCE_SIGNATURE_RESEND_S = 300;

/** Corps brut, capturé par le parser JSON global (celui du receveur Meta). */
type AvecCorpsBrut = FastifyRequest & { rawBody?: Buffer };

export function verifierSignatureResend(
  brut: Buffer,
  entetes: { id?: string; timestamp?: string; signature?: string },
  secret: string,
  maintenantMs: number,
): boolean {
  if (!secret || !entetes.id || !entetes.timestamp || !entetes.signature) return false;
  if (!/^\d{1,15}$/.test(entetes.timestamp)) return false;
  const cle = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  if (cle.length === 0) return false;
  const attendue = createHmac('sha256', cle)
    .update(`${entetes.id}.${entetes.timestamp}.`, 'utf8').update(brut).digest();
  const valide = entetes.signature.split(' ').some((morceau) => {
    const [version, sig] = morceau.split(',');
    if (version !== 'v1' || !sig) return false;
    const recue = Buffer.from(sig, 'base64');
    return recue.length === attendue.length && timingSafeEqual(recue, attendue);
  });
  if (!valide) return false;
  return Math.abs(maintenantMs / 1000 - Number(entetes.timestamp)) <= TOLERANCE_SIGNATURE_RESEND_S;
}

const evenementSchema = z.object({
  type: z.string().max(80),
  created_at: z.string().max(60),
  data: z.object({ email_id: z.string().min(1).max(100) }),
});

export interface ResendWebhookRouteDeps {
  /** Le secret de signature de la destination déclarée chez Resend (`whsec_...`). Vide : tout est refusé. */
  secret: string;
  noterEvenement(resendId: string, evenement: EvenementResend, le: Date): Promise<{ identityId: string } | null>;
  desinscrireDesCommerciaux(identityId: string): Promise<void>;
  now?: () => number;
}

const entete = (req: FastifyRequest, nom: string): string | undefined => {
  const v = req.headers[nom];
  return Array.isArray(v) ? v[0] : v;
};

export function registerResendWebhook(app: FastifyInstance, deps: ResendWebhookRouteDeps): void {
  const maintenant = deps.now ?? (() => Date.now());

  app.post('/webhooks/resend', async (req, reply) => {
    const brut = (req as AvecCorpsBrut).rawBody;
    const signe = brut && verifierSignatureResend(brut, {
      id: entete(req, 'svix-id'), timestamp: entete(req, 'svix-timestamp'), signature: entete(req, 'svix-signature'),
    }, deps.secret, maintenant());
    if (!signe) return reply.code(401).send({ error: 'signature invalide' });

    const ev = evenementSchema.safeParse(req.body);
    // Signé mais illisible, ou un type qu'on ne note pas (envoyé, retardé...) : 200, rien à rejouer.
    if (!ev.success || !Object.hasOwn(EVENEMENTS_RESEND, ev.data.type)) return reply.code(200).send({ recu: true });
    const type = ev.data.type as EvenementResend;
    const le = new Date(ev.data.created_at);
    const issue = await deps.noterEvenement(ev.data.data.email_id, type, Number.isNaN(le.getTime()) ? new Date(maintenant()) : le);
    if (issue !== null && type === 'email.complained') {
      await deps.desinscrireDesCommerciaux(issue.identityId);
      journaliser('warn', 'email_produit_plainte', { identityId: issue.identityId });
    }
    return reply.code(200).send({ recu: true });
  });
}
