import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auteurOps, type PreHandler } from '../auth/middleware';
import { estUuid } from './scope';
import { journaliser } from '../lib/journal';
import { MIN_NOTE } from './ops';
import { makeTraceOps, type AuditSink } from '../audit/journal';
import { CLE_360DIALOG, rattacher360dialog, type DepsRattachement360 } from '../account/rattacher-360dialog';

/**
 * RATTACHER UN NUMÉRO 360DIALOG À UN ESPACE, PAR L'EXPLOITATION (360dialog, lot 2). La logique est commune avec le
 * bouton de l'espace (`rattacher360dialog`, `src/account/rattacher-360dialog.ts`) ; ici, l'autorité est la session
 * d'exploitation, et la trace porte l'exploitant et sa note. 🔴 La clé n'est jamais renvoyée ni journalisée.
 */
export interface Ops360dialogDeps extends DepsRattachement360 {
  espaceExiste(tenantId: string): Promise<boolean>;
  audit: AuditSink;
}

const corpsSchema = z.object({
  cle: z.string().trim().regex(CLE_360DIALOG),
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

    const issue = await rattacher360dialog(deps, tenantId, lu.data.cle, lu.data.numeroAffiche || null);
    if (!issue.ok) {
      return reply.code(issue.statut).send(issue.rattache ? { error: issue.error, rattache: true, ...issue.rattache } : { error: issue.error });
    }
    const par = auteurOps(req);
    const { ok: _ok, ...numero } = issue;
    journaliser('warn', 'ops_360dialog_rattache', { tenantId, ...numero, par, note, at: new Date().toISOString() });
    await tracer(tenantId, par, 'ops.numero_rattache', numero);
    return reply.code(200).send({ tenantId, ...numero });
  });
}
