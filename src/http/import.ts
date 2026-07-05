import type { FastifyInstance } from 'fastify';
import { parseCsv } from '../crm/csv';
import { recognizeColumns } from '../crm/recognize';
import { importContacts } from '../crm/import';
import type { ImportDeps } from '../crm/import';
import type { ColumnMapping } from '../crm/types';
import type { ContactRow } from '../crm/contact-store.pg';
import { forbidNonAdmin } from '../auth/middleware';
import type { PreHandler } from '../auth/middleware';

export interface ImportRouteDeps extends ImportDeps {
  listContacts(tenantId: string, limit?: number, offset?: number): Promise<ContactRow[]>;
}

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
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  /** Tenant effectif = celui du JWT ; l'URL doit correspondre. Renvoie null si interdit. */
  function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
    const { tenantId } = req.params as { tenantId: string };
    const authTenant = req.auth?.tenantId;
    if (authTenant !== undefined && authTenant !== tenantId) return null;
    return authTenant ?? tenantId;
  }

  app.get('/tenants/:tenantId/contacts', guard, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const q = req.query as { limit?: string; offset?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    const offset = q.offset ? Number(q.offset) : undefined;
    const contacts = await deps.listContacts(effectiveTenant, limit, offset);
    return reply.code(200).send({ contacts });
  });

  app.post('/tenants/:tenantId/contacts/import', guard, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
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
