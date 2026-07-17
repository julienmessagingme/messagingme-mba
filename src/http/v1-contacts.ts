import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { ApiContactInput, ApiUpsertOutcome } from '../api/contacts-upsert';

export interface V1ContactsRouteDeps {
  /** Upsert d'un lot de contacts (tenant issu de la clé d'API). Renvoie un outcome par item. */
  upsertContacts(tenantId: string, items: ApiContactInput[]): Promise<ApiUpsertOutcome[]>;
}

const MAX_BATCH = 500;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasPhone = (v: unknown): v is { phone: string } => isObj(v) && typeof v.phone === 'string' && v.phone.trim() !== '';

/**
 * Routes publiques /v1 des contacts. Le tenant vient à 100% de `req.auth` (posé par makeRequireApiKey via le
 * guard) — pas d'`:tenantId` dans l'URL. Guard attendu : [makeRequireApiKey, requireScope('contacts:write')].
 */
export function registerV1Contacts(app: FastifyInstance, deps: V1ContactsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.post('/v1/contacts', opts, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'clé d’API requise' });
    const body = req.body;
    if (!hasPhone(body)) return reply.code(400).send({ error: 'phone requis' });
    const [outcome] = await deps.upsertContacts(req.auth.tenantId, [body as ApiContactInput]);
    if (!outcome || outcome.status === 'error') return reply.code(400).send({ error: outcome?.reason ?? 'échec' });
    return reply.code(200).send({ contactId: outcome.contactId, status: outcome.status });
  });

  app.post('/v1/contacts/batch', opts, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'clé d’API requise' });
    const body = req.body as { contacts?: unknown };
    if (!Array.isArray(body?.contacts) || body.contacts.length === 0) return reply.code(400).send({ error: 'contacts (tableau non vide) requis' });
    if (body.contacts.length > MAX_BATCH) return reply.code(400).send({ error: `maximum ${MAX_BATCH} contacts par lot` });
    const results = await deps.upsertContacts(req.auth.tenantId, body.contacts as ApiContactInput[]);
    const created = results.filter((r) => r.status === 'created').length;
    const updated = results.filter((r) => r.status === 'updated').length;
    const errors = results.filter((r) => r.status === 'error').length;
    return reply.code(200).send({ results, created, updated, errors });
  });
}
