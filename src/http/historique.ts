import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidNonAdmin, type Guard } from '../auth/middleware';
import { scopeTenant, estUuid } from './scope';
import { MAX_LIGNES_HISTORIQUE, type HistoriqueStore } from '../reglages/historique';

/**
 * L'HISTORIQUE DES RÉGLAGES, EN LECTURE.
 *
 * 🔴 IL EXISTE PARCE QUE META N'A PAS DE CORBEILLE : une FAQ ou une compétence supprimée est perdue, et ces
 * lignes en sont le seul exemplaire. C'est aussi le seul endroit qui réponde à « qui a changé ça ? » sur des
 * réglages qui décident de ce qu'un robot dit aux clients.
 *
 * 🔴 ADMINS SEULEMENT, comme les écritures qu'il journalise. Un journal plus lisible que ce qu'il décrit
 * serait une fuite : il porte le CONTENU des éléments supprimés.
 */

export interface HistoriqueRouteDeps {
  historique: HistoriqueStore;
}

const requete = z.object({
  surface: z.enum(['mba', 'agent']),
  /** L'agent visé. Requis pour la surface `agent`, refusé pour `mba` (il est unique par espace). */
  agentId: z.string().optional(),
  limite: z.coerce.number().int().min(1).max(MAX_LIGNES_HISTORIQUE).optional(),
});

export function registerHistorique(app: FastifyInstance, deps: HistoriqueRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/historique', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;

    const parse = requete.safeParse(req.query ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'surface invalide (mba|agent)' });
    const { surface, agentId, limite } = parse.data;

    /**
     * ⚠️ LA FORME EST VÉRIFIÉE ICI, pas seulement en base. Le CHECK `reglages_historique_surface_id_chk`
     * refuserait aussi, mais en violation de contrainte, donc en 500, donc derrière une page Cloudflare qui
     * n'expliquerait rien. Et sur une LECTURE, il ne refuserait rien du tout : il rendrait simplement zéro
     * ligne, ce qui se lit comme « il ne s'est rien passé ».
     */
    if (surface === 'agent' && !estUuid(agentId ?? '')) {
      return reply.code(400).send({ error: 'agentId requis pour la surface agent' });
    }
    if (surface === 'mba' && agentId) {
      return reply.code(400).send({ error: 'le Meta Business Agent est unique par espace' });
    }

    const lignes = await deps.historique.lister(tenant, {
      surface,
      ...(surface === 'agent' ? { surfaceId: agentId ?? null } : {}),
      ...(limite ? { limite } : {}),
    });
    return reply.code(200).send({ lignes });
  });
}
