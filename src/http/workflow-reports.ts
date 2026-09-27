import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { NomDeTableauDejaPris } from '../workflow/reports.pg';
import type { WorkflowReport, MesureRetenue } from '../workflow/reports.pg';

/**
 * Les tableaux enregistrés d'Analytics > Mes tableaux. Un tableau ne contient que la sélection (scénario et
 * mesures retenues), jamais des chiffres : les compteurs se recalculent à la lecture.
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
    // Plafond : il protège la base autant que la lisibilité.
    .slice(0, 100);
}

export function registerWorkflowReports(app: FastifyInstance, deps: WorkflowReportsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/workflow-reports', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ reports: await deps.listReports(tenant) });
  });

  /** Enregistre un tableau : `id` fourni -> mise à jour, sinon création (un seul bouton, une seule validation). */
  app.post('/tenants/:tenantId/workflow-reports', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
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
      // `null` = identifiant inconnu dans cet espace. 404 plutôt qu'une création sous un id imposé, qui laisserait
      // deviner l'existence d'un tableau d'un autre espace.
      if (!saved) return reply.code(404).send({ error: 'tableau inconnu' });
      return reply.code(200).send({ report: saved });
    } catch (err) {
      if (err instanceof NomDeTableauDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/tenants/:tenantId/workflow-reports/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    return (await deps.removeReport(tenant, id))
      ? reply.code(200).send({ ok: true })
      : reply.code(404).send({ error: 'tableau inconnu' });
  });
}
