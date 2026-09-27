import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { espaceVerifie, estUuid } from './scope';
import { MAX_LIGNES_HISTORIQUE, type HistoriqueStore } from '../reglages/historique';

/**
 * L'historique des réglages, en lecture. Meta n'a pas de corbeille : une FAQ ou une compétence supprimée n'existe
 * plus qu'ici, et c'est le seul endroit qui dise qui a changé ce qu'un robot dit aux clients.
 * 🔴 Admins seulement, comme les écritures qu'il journalise : il porte le contenu des éléments supprimés.
 */

export interface HistoriqueRouteDeps {
  historique: HistoriqueStore;
}

/**
 * Ce que l'écran reçoit sans le demander. Plus petit que le plafond de lecture : l'écart permet d'annoncer
 * `tronquee` plutôt qu'une liste coupée qui se lirait comme complète.
 */
export const LIGNES_HISTORIQUE_PAR_DEFAUT = 200;

const requete = z.object({
  surface: z.enum(['mba', 'agent']),
  /** L'agent visé. Requis pour la surface `agent`, refusé pour `mba` (il est unique par espace). */
  agentId: z.string().optional(),
  limite: z.coerce.number().int().min(1).max(MAX_LIGNES_HISTORIQUE).optional(),
});

export function registerHistorique(app: FastifyInstance, deps: HistoriqueRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/historique', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);

    const parse = requete.safeParse(req.query ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'surface invalide (mba|agent)' });
    const { surface, agentId, limite } = parse.data;

    /**
     * La forme est vérifiée ici : le CHECK en base refuserait en 500 sur une écriture, et sur une lecture il ne
     * refuserait rien, il rendrait zéro ligne (« il ne s'est rien passé »).
     */
    if (surface === 'agent' && !estUuid(agentId ?? '')) {
      return reply.code(400).send({ error: 'agentId requis pour la surface agent' });
    }
    if (surface === 'mba' && agentId) {
      return reply.code(400).send({ error: 'le Meta Business Agent est unique par espace' });
    }

    const plafond = limite ?? LIGNES_HISTORIQUE_PAR_DEFAUT;
    const lignes = await deps.historique.lister(tenant, {
      surface,
      ...(surface === 'agent' ? { surfaceId: agentId ?? null } : {}),
      limite: plafond,
    });
    return reply.code(200).send({ lignes, tronquee: lignes.length >= plafond });
  });
}
