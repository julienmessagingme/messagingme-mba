import type { FastifyInstance } from 'fastify';
import { parseCsv } from '../crm/csv';
import { recognizeColumns } from '../crm/recognize';
import { importContacts } from '../crm/import';
import type { ImportDeps } from '../crm/import';
import type { ColumnMapping } from '../crm/types';
import type { PreHandler } from '../auth/middleware';

export type ImportRouteDeps = ImportDeps;

/** Construit un mapping par défaut depuis la reconnaissance de colonnes. */
export function mappingFromHeaders(headers: string[]): ColumnMapping {
  const columns: ColumnMapping['columns'] = {};
  for (const s of recognizeColumns(headers)) {
    columns[s.header] =
      s.target === 'custom' ? { target: 'custom', key: s.suggestedKey } : { target: s.target };
  }
  return { columns };
}

/**
 * POST /tenants/:tenantId/contacts/import — importe un CSV brut : parse, reconnaît les
 * colonnes (si pas de mapping fourni), upsert les contacts. Retourne un ImportReport.
 */
export function registerImport(app: FastifyInstance, deps: ImportRouteDeps, requireAuth?: PreHandler): void {
  app.post('/tenants/:tenantId/contacts/import', requireAuth ? { preHandler: requireAuth } : {}, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    // Tenant EFFECTIF = celui du JWT ; l'URL doit correspondre (sinon accès à un autre tenant).
    const authTenant = req.auth?.tenantId;
    if (authTenant !== undefined && authTenant !== tenantId) {
      return reply.code(403).send({ error: 'tenant interdit' });
    }
    const effectiveTenant = authTenant ?? tenantId;
    const body = (req.body ?? {}) as { csv?: unknown; optIn?: unknown; mapping?: ColumnMapping };

    if (typeof body.csv !== 'string' || body.csv.trim() === '') {
      return reply.code(400).send({ error: 'csv requis (texte brut)' });
    }
    // mapping fourni mais malformé (sans `columns` objet) -> 400, sinon Object.entries throw en 500.
    if (body.mapping !== undefined) {
      const cols = (body.mapping as { columns?: unknown }).columns;
      if (typeof cols !== 'object' || cols === null || Array.isArray(cols)) {
        return reply.code(400).send({ error: 'mapping invalide (columns requis)' });
      }
    }

    const parsed = parseCsv(body.csv);
    const mapping = body.mapping ?? mappingFromHeaders(parsed.headers);
    const report = await importContacts(
      { rows: parsed.rows, mapping, tenantId: effectiveTenant, optIn: body.optIn === true },
      deps,
    );
    return reply.code(200).send(report);
  });
}
