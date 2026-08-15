import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyRequest } from '../lib/signature';
import { waIdOf } from '../crm/identity';
import { normalizePhone } from '../crm/phone';

/** Corps brut, capturé par le parser du receiver Meta (un seul parser JSON pour toute l'app). */
type WithRawBody = FastifyRequest & { rawBody?: Buffer };

/**
 * Événement poussé par le connecteur HubSpot. Payload EXTERNE, donc validé au `safeParse` : le connecteur est
 * authentifié par signature, mais une version décalée des deux côtés reste possible.
 */
const dealStageSchema = z.object({
  tenantId: z.string().min(1),
  /** Téléphone tel que HubSpot le porte : format libre, normalisé ici. */
  phone: z.string().min(1),
  stageId: z.string().min(1),
  /** Vide = le connecteur n'a pas pu relire le pipeline. Une automation sans pipeline configuré s'en moque. */
  pipelineId: z.string().default(''),
  dealId: z.string().default(''),
});

export interface HubspotEventRouteDeps {
  /** Secret partagé avec le connecteur (== SERVICE_SECRET de mm-hubspot). Vide -> route non montée. */
  secret: string;
  /** Le contact existe-t-il dans ce workspace ? Rend son wa_id, ou null. */
  findWaId(tenantId: string, waId: string): Promise<string | null>;
  /** Publie l'événement d'automation (file). C'est le worker qui décide ensuite quoi déclencher. */
  publish(tenantId: string, ev: { kind: 'hubspot_deal_stage'; waId: string; pipelineId: string; stageId: string }): Promise<void>;
  now?: () => number;
  windowMs?: number;
}

/**
 * Canal ENTRANT depuis le connecteur HubSpot. C'est le seul endroit où un système extérieur peut provoquer un
 * envoi WhatsApp, donc il est volontairement étroit : une seule route, un seul type d'événement, et aucune
 * décision prise ici. La route traduit « ce deal a changé d'étape » en événement d'automation ; ce sont les
 * automations du workspace qui décident s'il se passe quelque chose, avec leurs propres garde-fous.
 */
export function registerHubspotEvents(app: FastifyInstance, deps: HubspotEventRouteDeps): void {
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.windowMs ?? 5 * 60 * 1000;

  app.post('/hubspot/deal-stage', async (req, reply) => {
    const raw = (req as WithRawBody).rawBody;
    const sig = req.headers['x-mm-service-signature'];
    const header = Array.isArray(sig) ? sig[0] : sig;
    const path = req.url.split('?')[0] ?? req.url;
    if (!raw || !verifyRequest(raw, header, deps.secret, { method: req.method, path, now: now(), windowMs })) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const parsed = dealStageSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId, phone, stageId, pipelineId } = parsed.data;

    // Numéro normalisé avec la MÊME fonction que l'import CSV et l'import de liste : un contact doit être
    // reconnu à l'identique quel que soit le chemin par lequel son numéro nous arrive.
    const e164 = normalizePhone(phone, 'FR').e164;
    if (!e164) return reply.code(200).send({ ok: true, triggered: false, reason: 'numéro inexploitable' });

    // `waIdOf` est la règle PARTAGÉE (crm/identity.ts) : la redériver ici créerait un second contact pour la
    // même personne le jour où l'une des deux versions changerait.
    const waId = waIdOf(e164, null);
    if (!waId) return reply.code(200).send({ ok: true, triggered: false, reason: 'numéro inexploitable' });

    // Contact INCONNU de ce workspace : on ne le crée PAS. Un événement de CRM ne doit pas faire apparaître
    // des fiches en silence, et un contact sans fiche n'a ni consentement connu ni champ pour les variables
    // d'un template. L'opérateur importe sa liste HubSpot d'abord ; c'est explicite et déjà outillé.
    const connu = await deps.findWaId(tenantId, waId);
    if (!connu) {
      // eslint-disable-next-line no-console
      console.log(`hubspot deal-stage: ${waId} inconnu du workspace ${tenantId}, aucun déclenchement`);
      return reply.code(200).send({ ok: true, triggered: false, reason: 'contact inconnu' });
    }

    await deps.publish(tenantId, { kind: 'hubspot_deal_stage', waId, pipelineId, stageId });
    return reply.code(200).send({ ok: true, triggered: true });
  });
}
