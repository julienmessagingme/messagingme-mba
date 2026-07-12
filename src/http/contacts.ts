import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import type { ContactRow } from '../crm/contact-store.pg';
import type { UserFieldDef, UserFieldType } from '../crm/types';

export interface ContactsRouteDeps {
  /** Applique fields (MERGE) + addTags/removeTags en une transaction. null si le contact n'existe pas (tenant). */
  applyEdits(
    tenantId: string,
    contactId: string,
    edits: { fields: Record<string, string>; addTags: string[]; removeTags: string[] },
  ): Promise<ContactRow | null>;
  /** Définitions des user fields du tenant (pour valider clé + type d'une valeur saisie). */
  listUserFields(tenantId: string): Promise<UserFieldDef[]>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/** Valide une valeur (string) selon le type du user field. Les valeurs sont stockées en STRING
 *  (cohérent avec String(v) de la substitution campagne). Vide -> invalide (utiliser un retrait). */
function validateFieldValue(type: UserFieldType, value: string): boolean {
  const v = value.trim();
  if (v === '') return false;
  if (v.length > 1000) return false;
  if (type === 'number') return Number.isFinite(Number(v));
  if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  if (type === 'boolean') return ['true', 'false', 'oui', 'non', '1', '0'].includes(v.toLowerCase());
  if (type === 'url') return /^https?:\/\/\S+$/i.test(v);
  return true; // text
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(String).map((t) => t.trim().slice(0, 64)).filter((t) => t !== ''))].slice(0, 50) : [];

/**
 * Édition d'UN contact (admin-only) : ajouter/mettre à jour des valeurs de user fields + affecter/retirer
 * des tags, depuis la fiche. Le tenant vient du JWT. MERGE (n'écrase jamais les autres clés). Renvoie le
 * contact à jour. Valide chaque valeur selon le type déclaré du user field (clé inconnue / valeur invalide -> 400).
 */
export function registerContacts(app: FastifyInstance, deps: ContactsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.patch('/tenants/:tenantId/contacts/:contactId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { contactId } = req.params as { contactId: string };

    const b = (req.body ?? {}) as { fields?: unknown; addTags?: unknown; removeTags?: unknown };
    const rawFields = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? (b.fields as Record<string, unknown>) : {};
    const addTags = asStringArray(b.addTags);
    const removeTags = asStringArray(b.removeTags);

    // Valide les champs contre les définitions user_fields du tenant.
    const defs = new Map((await deps.listUserFields(tenant)).map((d) => [d.key, d]));
    const values: Record<string, string> = {};
    for (const [key, raw] of Object.entries(rawFields)) {
      const def = defs.get(key);
      if (!def) return reply.code(400).send({ error: `champ inconnu : ${key}` });
      const val = String(raw);
      if (!validateFieldValue(def.type, val)) return reply.code(400).send({ error: `valeur invalide pour « ${def.label} » (${def.type})` });
      values[key] = val.trim();
    }

    if (Object.keys(values).length === 0 && addTags.length === 0 && removeTags.length === 0) {
      return reply.code(400).send({ error: 'rien à modifier (fields / addTags / removeTags)' });
    }

    // Une transaction : MERGE fields + tags, ou 404 si le contact n'est pas dans le tenant.
    const updated = await deps.applyEdits(tenant, contactId, { fields: values, addTags, removeTags });
    if (!updated) return reply.code(404).send({ error: 'contact inconnu' });
    return reply.code(200).send({ contact: updated });
  });
}
