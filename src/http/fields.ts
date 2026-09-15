import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { isUserFieldType, isSystemFieldKey, isReservedFieldLabel, slugify } from '../crm/fields';
import type { UserFieldDef, UserFieldType } from '../crm/types';
import { scopeTenant, nonEmpty } from './scope';

export interface FieldsRouteDeps {
  listFields(tenantId: string): Promise<UserFieldDef[]>;
  /** Code client racine (optionnel) : renvoyé au GET pour que le front calcule les codes des champs SYSTÈME
   *  (`fld_<client>_sys_<key>`, déterministes, pas de ligne DB). Absent -> réponse sans tenantCode (rétro-compatible). */
  tenantCode?(tenantId: string): Promise<string>;
  createField(tenantId: string, def: UserFieldDef): Promise<'created' | 'exists'>;
  updateField(tenantId: string, key: string, patch: { label?: string; type?: UserFieldType }): Promise<boolean>;
  deleteField(tenantId: string, key: string): Promise<boolean>;
  /** Combien de fiches ont chaque champ rempli. Optionnelle : absente, la route répond un relevé vide
   *  plutôt qu'une erreur, et le sélecteur se contente de ne rien afficher. */
  fieldUsage?(tenantId: string): Promise<{ total: number; parChamp: Record<string, number> }>;
}

/**
 * Gestion des user fields (menu Contenu), admin-only. On édite libellé + type ; la CLÉ est immuable
 * (la renommer casserait les paramMapping de campagnes et les valeurs `contacts.fields` indexées par clé).
 */
export function registerFields(app: FastifyInstance, deps: FieldsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /**
   * Combien de fiches ont chaque champ rempli. Sert au sélecteur de destinataire du bloc « Envoi de mail » :
   * choisir un champ vide sur toutes les fiches, c'est n'envoyer aucun mail, et rien ne le disait.
   *
   * DÉCLARÉE AVANT `/user-fields/:key` : « usage » n'est pas une clé de champ.
   */
  app.get('/tenants/:tenantId/user-fields/usage', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.fieldUsage) return reply.code(200).send({ total: 0, parChamp: {} });
    return reply.code(200).send(await deps.fieldUsage(tenant));
  });

  app.get('/tenants/:tenantId/user-fields', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const fields = await deps.listFields(tenant);
    const tenantCode = deps.tenantCode ? await deps.tenantCode(tenant) : undefined;
    return reply.code(200).send({ fields, ...(tenantCode ? { tenantCode } : {}) });
  });

  // Créer un champ perso : la clé est dérivée du libellé (slug). 409 si la clé existe déjà.
  app.post('/tenants/:tenantId/user-fields', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const b = (req.body ?? {}) as { label?: unknown; type?: unknown };
    if (!nonEmpty(b.label)) return reply.code(400).send({ error: 'label requis' });
    if (typeof b.type !== 'string' || !isUserFieldType(b.type)) return reply.code(400).send({ error: 'type invalide (text|number|date|datetime|boolean|url)' });
    const def: UserFieldDef = { key: slugify(b.label.trim()), label: b.label.trim(), type: b.type };
    // Le libellé ne doit pas fantômiser un champ de base, ni par sa CLÉ dérivée (« BSUID » -> 'bsuid') ni
    // par le libellé lui-même (« Nom », « Téléphone »), qui sont français là où les clés sont anglaises.
    if (isReservedFieldLabel(def.label)) return reply.code(409).send({ error: `« ${def.label} » correspond à un champ de base déjà présent` });
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
      // Même garde qu'à la création : renommer un champ perso en « Nom » fabriquerait le doublon par l'autre
      // porte. La clé, elle, reste immuable, donc le renommage ne peut pas créer de collision de clé.
      if (isReservedFieldLabel(b.label)) return reply.code(409).send({ error: `« ${b.label.trim()} » correspond à un champ de base déjà présent` });
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
