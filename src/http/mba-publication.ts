import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { corpsDuRefus } from '../lib/issue';
import type { PublicationMba } from '../mba/orchestration-publication';
import { espaceVerifie } from './scope';

/** La route ne reçoit que la façade métier ; le verrou, le plan et le contexte restent derrière elle. */
export function registerMbaPublication(app: FastifyInstance, publication: PublicationMba, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/mba-publication';

  app.get(base, opts, async (req, reply) => {
    const resultat = await publication.apercevoir(espaceVerifie(req));
    return resultat.ok
      ? reply.code(200).send(resultat.valeur)
      : reply.code(resultat.statut).send(corpsDuRefus(resultat));
  });

  app.post(base, opts, async (req, reply) => {
    const resultat = await publication.publier(espaceVerifie(req), req.auth?.userId ?? null);
    return resultat.ok
      ? reply.code(200).send(resultat.valeur)
      : reply.code(resultat.statut).send(corpsDuRefus(resultat));
  });
}
