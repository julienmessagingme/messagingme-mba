import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import {
  creerWidget, listerEnVue, miseEnVue, modifierWidget, supprimerWidget, type DepsWidgets,
} from '../widgets/gestion';
import { espaceVerifie } from './scope';

/**
 * Les widgets WhatsApp d'un espace, côté console (lot 4 de docs/superpowers/plans/2026-10-02-widget-whatsapp.md).
 *
 * Une route MINCE : les contrôles vivent dans `src/widgets/gestion.ts`, que les outils MCP du lot 5 appellent
 * aussi, mise en vue comprise. Elle n'ajoute que ce qui est propre au HTTP : la garde (le module est monté sous
 * `g.admin`, lecture comprise, comme l'écran qui n'est ouvert qu'aux administrateurs) et la traduction des refus
 * en statuts.
 */
export type WidgetsRouteDeps = DepsWidgets;

export function registerWidgets(app: FastifyInstance, deps: WidgetsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/widgets';

  app.get(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send(await listerEnVue(deps, tenant));
  });

  app.post(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const vue = await miseEnVue(deps, tenant);
    const r = await creerWidget(deps.gestion, tenant, req.body);
    if (!r.ok) return reply.code(r.statut).send({ error: r.erreur });
    return reply.code(201).send({ widget: vue(r.valeur) });
  });

  app.patch<{ Params: { id: string } }>(`${base}/:id`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const vue = await miseEnVue(deps, tenant);
    const r = await modifierWidget(deps.gestion, tenant, req.params.id, req.body);
    if (!r.ok) return reply.code(r.statut).send({ error: r.erreur });
    return reply.code(200).send({ widget: vue(r.valeur) });
  });

  /**
   * Supprimer ne casse pas le site du client : sa balise rend désormais le script inerte, la bulle disparaît. Les
   * conversations déjà arrivées gardent leur étiquette `widget-<code>`.
   */
  app.delete<{ Params: { id: string } }>(`${base}/:id`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await supprimerWidget(deps.gestion, tenant, req.params.id);
    if (!r.ok) return reply.code(r.statut).send({ error: r.erreur });
    return reply.code(200).send({ ok: true });
  });
}
