import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { refuser } from '../api/erreurs';
import { messageDeForme } from '../api/forme';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { schemaModeleMeta } from '../api/modele-meta';
import { creerModeleDepuisMeta, statutsDuModele, type DepsCreationModele, type RefusModele } from '../api/creer-modele';
import type { FastifyReply } from 'fastify';

/**
 * LES MODÈLES PAR L'API (lot 13, domaine 3, spec § 5) : `POST /v1/templates`, le corps de Meta traduit vers la création
 * de l'écran Modèles (`creerUnModele`), et `GET /v1/templates/{name}`, le statut de chaque langue. Le catalogue
 * `GET /v1/templates` (les modèles envoyables) vit dans `v1-catalogues.ts`, sous `sends:create`.
 *
 * Garde attendue : `[makeRequireApiKey, requireScope('templates:write')]`, un droit NEUF sans reprise des clés
 * existantes (décision de Julien du 2026-10-08). L'espace vient de `req.auth`, jamais de l'URL.
 */
export interface V1TemplatesRouteDeps extends DepsCreationModele {
  /** Le garde d'usage, injecté au bootstrap. Requis, comme sur les autres modules /v1. */
  usage: ApiUsageGuard;
}

const parametres = z.object({ name: z.string().max(600) });

/** Un refus du cœur, avec son `Retry-After` quand il est passager : sans lui, un client réessaie aussitôt. */
function refuserModele(reply: FastifyReply, r: RefusModele): FastifyReply {
  if (r.reessayerDansS !== undefined) reply.header('retry-after', String(r.reessayerDansS));
  return refuser(reply, r.statut, r.code, r.message);
}
const requete = z.object({ language: z.string().max(20).optional() });

export function registerV1Templates(app: FastifyInstance, deps: V1TemplatesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/templates', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;
    // Compté avant la validation, comme les autres routes : un appel refusé a quand même été fait.
    if (!await compterOuRefuser(deps.usage, req, reply, 'templates.create')) return reply;
    const lu = schemaModeleMeta.safeParse(req.body);
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error));
    const issue = await creerModeleDepuisMeta(deps, tenantId, lu.data);
    if ('refus' in issue) return refuserModele(reply, issue.refus);
    return reply.code(201).send(issue.modele);
  });

  app.get('/v1/templates/:name', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await compterOuRefuser(deps.usage, req, reply, 'templates.read')) return reply;
    const p = parametres.safeParse(req.params);
    const q = requete.safeParse(req.query);
    if (!p.success) return refuser(reply, 404, 'template_not_found', 'modèle inconnu');
    if (!q.success) return refuser(reply, 400, 'invalid_body', messageDeForme(q.error));
    const issue = await statutsDuModele(deps, req.auth.tenantId, p.data.name, q.data.language);
    if ('refus' in issue) return refuserModele(reply, issue.refus);
    return reply.code(200).send(issue);
  });
}
