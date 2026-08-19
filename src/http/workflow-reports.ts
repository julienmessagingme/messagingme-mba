import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { forbidNonAdmin } from '../auth/middleware';
import { scopeTenant } from './scope';
import { NomDeTableauDejaPris } from '../workflow/reports.pg';
import type { WorkflowReport, MesureRetenue } from '../workflow/reports.pg';

/**
 * Les TABLEAUX enregistrés d'Analytics > Mes tableaux : lister, enregistrer, supprimer.
 *
 * Un tableau ne contient que la SÉLECTION (scénario + mesures retenues), jamais des chiffres : les compteurs
 * se recalculent à la lecture, sur la période qu'on regarde.
 */
export interface WorkflowReportsRouteDeps {
  listReports(tenantId: string): Promise<WorkflowReport[]>;
  saveReport(
    tenantId: string,
    input: { id?: string; workflowId: string; name: string; mesures: MesureRetenue[] },
  ): Promise<WorkflowReport | null>;
  removeReport(tenantId: string, id: string): Promise<boolean>;
}

/** Mesures reçues d'un client : bornées et nettoyées avant d'entrer en base (donnée non fiable). */
function normaliserMesures(v: unknown): MesureRetenue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      cle: String(m.cle ?? '').slice(0, 200),
      label: String(m.label ?? '').slice(0, 200),
      kind: String(m.kind ?? '').slice(0, 40),
      handle: typeof m.handle === 'string' && m.handle !== '' ? m.handle.slice(0, 200) : null,
    }))
    .filter((m) => m.cle !== '' && m.kind !== '')
    // Un tableau de dix mille mesures n'est pas un tableau : le plafond protège autant la base que la lisibilité.
    .slice(0, 100);
}

export function registerWorkflowReports(app: FastifyInstance, deps: WorkflowReportsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/workflow-reports', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ reports: await deps.listReports(tenant) });
  });

  /**
   * Enregistre un tableau. `id` fourni -> mise à jour, sinon création. Un seul verbe pour les deux : côté
   * écran c'est le MÊME bouton, et deux routes auraient fini par diverger sur la validation.
   */
  app.post('/tenants/:tenantId/workflow-reports', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const b = (req.body ?? {}) as { id?: unknown; workflowId?: unknown; name?: unknown; mesures?: unknown };

    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
    if (name === '') return reply.code(400).send({ error: 'nom requis' });
    const workflowId = typeof b.workflowId === 'string' ? b.workflowId : '';
    if (workflowId === '') return reply.code(400).send({ error: 'scénario requis' });
    const mesures = normaliserMesures(b.mesures);
    if (mesures.length === 0) return reply.code(400).send({ error: 'aucune mesure retenue' });

    try {
      const saved = await deps.saveReport(tenant, {
        ...(typeof b.id === 'string' && b.id !== '' ? { id: b.id } : {}),
        workflowId, name, mesures,
      });
      // `null` = l'identifiant fourni n'existe pas dans CET espace. 404 plutôt qu'une création sous un id
      // imposé par l'appelant, qui laisserait deviner l'existence d'un tableau d'un autre espace.
      if (!saved) return reply.code(404).send({ error: 'tableau inconnu' });
      return reply.code(200).send({ report: saved });
    } catch (err) {
      // Nom déjà pris : erreur de saisie, donc 4xx avec son motif. Un 5xx verrait son corps remplacé par la
      // page d'erreur de Cloudflare, et l'opérateur ne saurait pas ce qu'on lui reproche.
      if (err instanceof NomDeTableauDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/tenants/:tenantId/workflow-reports/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    return (await deps.removeReport(tenant, id))
      ? reply.code(200).send({ ok: true })
      : reply.code(404).send({ error: 'tableau inconnu' });
  });
}
