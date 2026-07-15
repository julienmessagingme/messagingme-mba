import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { isUserFieldType, isSystemFieldKey, slugify } from '../crm/fields';
import type { UserFieldDef, UserFieldType } from '../crm/types';

export interface FieldsRouteDeps {
  listFields(tenantId: string): Promise<UserFieldDef[]>;
  createField(tenantId: string, def: UserFieldDef): Promise<'created' | 'exists'>;
  updateField(tenantId: string, key: string, patch: { label?: string; type?: UserFieldType }): Promise<boolean>;
  deleteField(tenantId: string, key: string): Promise<boolean>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Gestion des user fields (menu Contenu), admin-only. On édite libellé + type ; la CLÉ est immuable
 * (la renommer casserait les paramMapping de campagnes et les valeurs `contacts.fields` indexées par clé).
 */
export function registerFields(app: FastifyInstance, deps: FieldsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/user-fields', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ fields: await deps.listFields(tenant) });
  });

  // Créer un champ perso : la clé est dérivée du libellé (slug). 409 si la clé existe déjà.
  app.post('/tenants/:tenantId/user-fields', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const b = (req.body ?? {}) as { label?: unknown; type?: unknown };
    if (!nonEmpty(b.label)) return reply.code(400).send({ error: 'label requis' });
    if (typeof b.type !== 'string' || !isUserFieldType(b.type)) return reply.code(400).send({ error: 'type invalide (text|number|date|boolean|url)' });
    const def: UserFieldDef = { key: slugify(b.label.trim()), label: b.label.trim(), type: b.type };
    // La clé dérivée ne doit pas fantômiser un champ de base (ex. « BSUID » -> 'bsuid', « Prénom » -> 'prenom').
    if (isSystemFieldKey(def.key)) return reply.code(409).send({ error: `« ${def.label} » correspond à un champ de base déjà présent` });
    const res = await deps.createField(tenant, def);
    if (res === 'exists') return reply.code(409).send({ error: `un champ existe déjà pour cette clé (${def.key})` });
    return reply.code(201).send(def);
  });

  app.patch('/tenants/:tenantId/user-fields/:key', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { key } = req.params as { key: string };
    if (isSystemFieldKey(key)) return reply.code(403).send({ error: 'champ système (non modifiable)' });
    const b = (req.body ?? {}) as { label?: unknown; type?: unknown };
    const patch: { label?: string; type?: UserFieldType } = {};
    if (b.label !== undefined) {
      if (!nonEmpty(b.label)) return reply.code(400).send({ error: 'label vide' });
      patch.label = b.label.trim();
    }
    if (b.type !== undefined) {
      if (typeof b.type !== 'string' || !isUserFieldType(b.type)) return reply.code(400).send({ error: 'type invalide' });
      patch.type = b.type;
    }
    if (patch.label === undefined && patch.type === undefined) return reply.code(400).send({ error: 'rien à mettre à jour (label ou type)' });
    const ok = await deps.updateField(tenant, key, patch);
    if (!ok) return reply.code(404).send({ error: 'champ inconnu' });
    return reply.code(200).send({ key, ...patch });
  });

  app.delete('/tenants/:tenantId/user-fields/:key', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { key } = req.params as { key: string };
    if (isSystemFieldKey(key)) return reply.code(403).send({ error: 'champ système (non supprimable)' });
    const ok = await deps.deleteField(tenant, key);
    if (!ok) return reply.code(404).send({ error: 'champ inconnu' });
    return reply.code(200).send({ key, deleted: true });
  });
}
