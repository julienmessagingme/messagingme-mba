import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { refuser } from '../api/erreurs';
import { formaterSuiviEnvoi } from '../api/suivi-envoi';
import { compteurEnvoiRefuse, lancerEnvoiPublic, type DepsEnvoiPublic } from '../api/envoi-public';

export type V1SendsRouteDeps = DepsEnvoiPublic & { usage: ApiUsageGuard };

const FORME_ID_ENVOI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const schemaIdEnvoi = z.object({ sendId: z.string().regex(FORME_ID_ENVOI) });

/**
 * Adaptateur HTTP de l'envoi public. L'espace vient de la clé (`req.auth`), jamais du corps. Le module
 * `api/envoi-public` possède le cycle de création ; cette route garde l'authentification, le comptage HTTP et la
 * traduction du résultat vers Fastify.
 */
export function registerV1Sends(app: FastifyInstance, deps: V1SendsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/sends', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const r = await lancerEnvoiPublic(
      deps, req.auth.tenantId, req.body, req.headers['idempotency-key'],
      (unites) => compterOuRefuser(deps.usage, req, reply, 'sends.create', unites),
    );
    if (compteurEnvoiRefuse(r)) return reply;
    return reply.code(r.statut).send(r.corps);
  });

  app.get('/v1/sends/:sendId', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    // Une lecture compte aussi, pour une unité, et avant le contrôle de forme : un intégrateur qui sonde
    // l'avancement toutes les secondes est exactement l'usage qu'on veut voir.
    if (!await compterOuRefuser(deps.usage, req, reply, 'sends.read')) return reply;
    // Un identifiant qui n'est pas un uuid ferait lever Postgres (22P02), donc un 500 : il est inconnu, 404.
    const p = schemaIdEnvoi.safeParse(req.params);
    if (!p.success) return refuser(reply, 404, 'send_not_found', 'envoi inconnu');
    const brut = await deps.repo.lireEnvoiApi(p.data.sendId, req.auth.tenantId);
    if (!brut) return refuser(reply, 404, 'send_not_found', 'envoi inconnu');
    return reply.code(200).send(formaterSuiviEnvoi(brut));
  });
}
