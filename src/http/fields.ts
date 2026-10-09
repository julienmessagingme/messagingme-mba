import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { isUserFieldType, isSystemFieldKey, isReservedFieldLabel, slugify } from '../crm/fields';
import type { UserFieldDef, UserFieldType } from '../crm/types';
import { champsDeLaFiche } from '../crm/champs-fiche';
import { operateursDuChamp } from '../crm/filtre-fiche';
import { espaceVerifie, nonEmpty } from './scope';

/** Ce que les routes lisent et écrivent du référentiel des champs. */
export interface ChampsDep {
  list(tenantId: string): Promise<UserFieldDef[]>;
  create(tenantId: string, def: UserFieldDef): Promise<'created' | 'exists'>;
  updateField(tenantId: string, key: string, patch: { label?: string; type?: UserFieldType }): Promise<boolean>;
  deleteField(tenantId: string, key: string): Promise<boolean>;
}

export interface FieldsRouteDeps {
  fields: ChampsDep;
  /** Code client racine : renvoyé au GET pour que le front calcule les codes des champs système
  *  (`fld_<client>_sys_<key>`, déterministes, pas de ligne DB). Vide -> réponse sans tenantCode. */
  tenantCode(tenantId: string): Promise<string>;
  contacts: {
    /** Combien de fiches ont chaque champ rempli. Un relevé vide : le sélecteur se contente de ne rien afficher. */
    fieldUsage(tenantId: string): Promise<{ total: number; parChamp: Record<string, number> }>;
  };
}

/** L'issue d'une création de champ : le champ, ou un refus avec son statut et sa phrase. */
export type IssueChamp = { ok: true; champ: UserFieldDef } | { ok: false; statut: 400 | 409; erreur: string };

/**
 * 🔴 LA création d'un champ personnalisé, partagée par l'écran Contenu et `POST /v1/fields` (lot 13, domaine 5) : la clé
 * dérivée du libellé (slug), immuable ensuite ; un libellé qui fantômiserait un champ de base est refusé, par sa clé
 * dérivée (« BSUID » -> 'bsuid') comme par le libellé lui-même (« Nom », « Téléphone ») ; 409 si la clé existe déjà.
 */
export async function creerChamp(champs: Pick<ChampsDep, 'create'>, tenantId: string, label: string, type: string): Promise<IssueChamp> {
  const libelle = label.trim();
  if (libelle === '') return { ok: false, statut: 400, erreur: 'label requis' };
  if (!isUserFieldType(type)) return { ok: false, statut: 400, erreur: 'type invalide (text|number|date|datetime|boolean|url)' };
  const def: UserFieldDef = { key: slugify(libelle), label: libelle, type };
  if (isReservedFieldLabel(def.label)) return { ok: false, statut: 409, erreur: `« ${def.label} » correspond à un champ de base déjà présent` };
  const res = await champs.create(tenantId, def);
  if (res === 'exists') return { ok: false, statut: 409, erreur: `un champ existe déjà pour cette clé (${def.key})` };
  return { ok: true, champ: def };
}

/**
 * Gestion des user fields (menu Contenu), admin. On édite libellé et type ; la clé est immuable (la renommer
 * casserait les paramMapping de campagnes et les valeurs `contacts.fields` indexées par clé).
 */
export function registerFields(app: FastifyInstance, deps: FieldsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /**
   * Combien de fiches ont chaque champ rempli, pour le sélecteur de destinataire du bloc « Envoi de mail » (un champ
   * vide partout n'enverrait aucun mail). Déclarée avant `/user-fields/:key` : « usage » n'est pas une clé.
   */
  app.get('/tenants/:tenantId/user-fields/usage', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send(await deps.contacts.fieldUsage(tenant));
  });

  /**
   * LA LISTE UNIQUE DES CHAMPS DE LA FICHE (`src/crm/champs-fiche.ts`), avec les opérateurs de filtre de chacun
   * (vides pour un champ qui ne se filtre pas ainsi). Route à part, délibérément : `/user-fields` alimente dix
   * écrans, dont les variables de message, qui ne doivent pas recevoir l'analyse (décisions 9 et 10 de la spec). La
   * carte des colonnes n'en sort jamais.
   */
  app.get('/tenants/:tenantId/champs-fiche', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const champs = champsDeLaFiche(await deps.fields.list(tenant)).map((c) => ({
      cle: c.cle, libelle: c.libelle, provenance: c.provenance, type: c.type, operateurs: operateursDuChamp(c),
    }));
    return reply.code(200).send({ champs });
  });

  app.get('/tenants/:tenantId/user-fields', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const fields = await deps.fields.list(tenant);
    const tenantCode = await deps.tenantCode(tenant);
    return reply.code(200).send({ fields, ...(tenantCode ? { tenantCode } : {}) });
  });

  // Créer un champ perso : la clé est dérivée du libellé (slug). 409 si la clé existe déjà.
  app.post('/tenants/:tenantId/user-fields', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const b = (req.body ?? {}) as { label?: unknown; type?: unknown };
    if (!nonEmpty(b.label)) return reply.code(400).send({ error: 'label requis' });
    if (typeof b.type !== 'string') return reply.code(400).send({ error: 'type invalide (text|number|date|datetime|boolean|url)' });
    const r = await creerChamp(deps.fields, tenant, b.label, b.type);
    if (!r.ok) return reply.code(r.statut).send({ error: r.erreur });
    return reply.code(201).send(r.champ);
  });

  app.patch('/tenants/:tenantId/user-fields/:key', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
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
    const ok = await deps.fields.updateField(tenant, key, patch);
    if (!ok) return reply.code(404).send({ error: 'champ inconnu' });
    return reply.code(200).send({ key, ...patch });
  });

  app.delete('/tenants/:tenantId/user-fields/:key', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { key } = req.params as { key: string };
    if (isSystemFieldKey(key)) return reply.code(403).send({ error: 'champ système (non supprimable)' });
    const ok = await deps.fields.deleteField(tenant, key);
    if (!ok) return reply.code(404).send({ error: 'champ inconnu' });
    return reply.code(200).send({ key, deleted: true });
  });
}
