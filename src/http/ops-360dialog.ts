import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auteurOps, type PreHandler } from '../auth/middleware';
import { estUuid } from './scope';
import { journaliser } from '../lib/journal';
import { MIN_NOTE } from './ops';
import { makeTraceOps, type AuditSink } from '../audit/journal';
import { SecondNumeroRefuseError, TenantConflictError } from '../account/es-store.pg';
import { Cle360dialogRefusee, Erreur360dialog, type Destination360 } from '../meta/config-360dialog';
import type { Fournisseur } from '../meta/credentials';

/**
 * RATTACHER UN NUMÉRO 360DIALOG À UN ESPACE, PAR L'EXPLOITATION (360dialog, lot 2, livraison A ; plan
 * `docs/superpowers/plans/2026-10-15-360dialog-lot2-envoi.md`). Le bouton du client est le lot 3 : d'ici là, c'est
 * nous qui collons la clé. Le numéro et le compte sont LUS chez 360dialog avec la clé, jamais saisis ; la clé est
 * chiffrée comme un jeton (`waba_credentials`, fournisseur `360dialog`) ; puis notre webhook est posé en GARDANT les
 * destinations existantes. 🔴 La clé n'est jamais renvoyée ni journalisée.
 *
 * Rejouer est sûr : le rattachement est idempotent pour le même espace, et la pose du webhook met à jour notre
 * destination au lieu d'en ajouter une. C'est la reprise quand la pose du webhook a échoué après le rattachement.
 */
export interface Ops360dialogDeps {
  /** Le client de configuration pour une clé (`Config360dialogClient`). */
  config(cle: string): {
    lireNumero(): Promise<{ phoneNumberId: string; wabaId: string }>;
    poserWebhook(notre: Destination360): Promise<'allume' | 'ajoute' | 'mis_a_jour'>;
  };
  espaceExiste(tenantId: string): Promise<boolean>;
  /** Les gardes de l'Embedded Signup : un seul numéro par espace, jamais le compte d'un autre espace. */
  lierNumero(input: { tenantId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null; verifiedName: string | null }): Promise<void>;
  saveCredentials(wabaId: string, tenantId: string, businessTokenEnc: string, pinEnc: string | null, fournisseur: Fournisseur): Promise<void>;
  chiffrer(cle: string): string;
  /** Notre destination pour ce numéro (`enteteDuNumero`), `null` sans `D360_WEBHOOK_SECRET` : rien n'est rattaché. */
  destination(phoneNumberId: string): Destination360 | null;
  audit: AuditSink;
}

const corpsSchema = z.object({
  // Caractères visibles seuls : un retour à la ligne collé avec la clé ferait lever `fetch` (500) au lieu d'un refus.
  cle: z.string().trim().min(10).max(200).regex(/^[!-~]+$/),
  numeroAffiche: z.string().trim().max(32).optional(),
  note: z.string(),
}).strict();

export function registerOps360dialog(app: FastifyInstance, deps: Ops360dialogDeps, garde: PreHandler): void {
  const tracer = makeTraceOps(deps.audit);

  app.post('/ops/360dialog/:tenantId', { preHandler: garde }, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const lu = corpsSchema.safeParse(req.body ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'cle (la clé d’API 360dialog du numéro) et note requises ; numeroAffiche facultatif' });
    const note = lu.data.note.trim().slice(0, 500);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi ce rattachement' });
    if (!(await deps.espaceExiste(tenantId))) return reply.code(404).send({ error: 'espace inconnu' });

    const config = deps.config(lu.data.cle);
    let numero: { phoneNumberId: string; wabaId: string };
    try {
      numero = await config.lireNumero();
    } catch (err) {
      if (err instanceof Cle360dialogRefusee) return reply.code(400).send({ error: 'clé refusée par 360dialog' });
      if (err instanceof Erreur360dialog) return reply.code(502).send({ error: err.message });
      throw err;
    }
    const destination = deps.destination(numero.phoneNumberId);
    if (destination === null) return reply.code(503).send({ error: 'D360_WEBHOOK_SECRET absent : la réception 360dialog n’est pas montée' });

    try {
      await deps.lierNumero({
        tenantId, wabaId: numero.wabaId, phoneNumberId: numero.phoneNumberId,
        displayPhoneNumber: lu.data.numeroAffiche || null, verifiedName: null,
      });
      await deps.saveCredentials(numero.wabaId, tenantId, deps.chiffrer(lu.data.cle), null, '360dialog');
    } catch (err) {
      if (err instanceof TenantConflictError || err instanceof SecondNumeroRefuseError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }

    const par = auteurOps(req);
    let webhook: 'allume' | 'ajoute' | 'mis_a_jour';
    try {
      webhook = await config.poserWebhook(destination);
    } catch (err) {
      if (!(err instanceof Erreur360dialog) && !(err instanceof Cle360dialogRefusee)) throw err;
      journaliser('error', 'ops_360dialog_webhook', { tenantId, ...numero, par, erreur: err.message });
      return reply.code(502).send({ error: `numéro rattaché, mais ${err.message} : rejouer le rattachement`, rattache: true, ...numero });
    }
    journaliser('warn', 'ops_360dialog_rattache', { tenantId, ...numero, webhook, par, note, at: new Date().toISOString() });
    await tracer(tenantId, par, 'ops.numero_rattache', { ...numero, webhook });
    return reply.code(200).send({ tenantId, ...numero, webhook });
  });
}
