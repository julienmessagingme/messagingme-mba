import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import type { ContactRow, ContactFilters, ContactFieldFilter, BulkTarget, BulkEdits } from '../crm/contact-store.pg';
import { isContactFieldOp } from '../crm/contact-store.pg';
import type { UserFieldDef } from '../crm/types';
import type { ContactHistory, ContactSend } from '../crm/contact-history.pg';
import { validateFieldValue, canonicalizeFieldValue } from '../crm/fields';

export interface ContactsRouteDeps {
  /** Applique fields (MERGE) + suppression de fields + Nom + addTags/removeTags en une transaction. null si le
   *  contact n'existe pas (tenant). */
  applyEdits(
    tenantId: string,
    contactId: string,
    edits: { fields: Record<string, string>; removeFields?: string[]; addTags: string[]; removeTags: string[]; profileName?: string | null },
  ): Promise<{ contact: ContactRow; addedTags: string[] } | null>;
  /** Action en masse (tags +/- et/ou poser un champ) sur une cible (ids ou filtres). Renvoie le nb touché. */
  applyEditsMany(tenantId: string, target: BulkTarget, edits: BulkEdits): Promise<number>;
  /** Suppression DOUCE en masse sur une cible. Renvoie le nb supprimé. */
  softDeleteMany(tenantId: string, target: BulkTarget): Promise<number>;
  /** Définitions des user fields du tenant (pour valider clé + type d'une valeur saisie). */
  listUserFields(tenantId: string): Promise<UserFieldDef[]>;
  /** Envois reçus + conversations tenues par ce contact. null si le contact n'est pas dans le tenant. */
  getContactHistory(tenantId: string, contactId: string): Promise<ContactHistory | null>;
  /** Envois du contact pour l'export CSV (non capé). null si le contact n'est pas dans le tenant. */
  listSendsForExport(tenantId: string, contactId: string): Promise<ContactSend[] | null>;
  /**
   * Signale qu'un tag vient d'être posé sur UN contact, pour les automations « tag ajouté » (E.2). Best-effort :
   * l'édition de la fiche a déjà réussi, un échec ici ne doit pas la faire échouer.
   *
   * Volontairement absent de l'action EN MASSE et de l'import : poser un tag sur des milliers de contacts
   * déclencherait autant de scénarios, donc autant de messages facturés. Pour toucher une liste, c'est la
   * campagne. Absent -> aucune émission (rétro-compatible).
   */
  emitTagAdded?(tenantId: string, contactId: string, tags: string[]): Promise<void>;
}

/** Borne les listes d'ids d'une action en masse (dédup, non vides). Au-delà du plafond, on tronque
 *  (le front vise plutôt `{filters, excludeIds}` que d'envoyer 100k ids). */
const asIdArray = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(String).map((s) => s.trim()).filter((s) => s !== ''))].slice(0, 100_000) : [];

/** Normalise un ContactFilters depuis un corps JSON (défensif : donnée cliente). Mêmes règles que `parseFilters`
 *  (query params) côté import.ts, opérateurs via la whitelist partagée `isContactFieldOp`. */
function normalizeContactFilters(raw: unknown): ContactFilters {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const tagArr = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.map(String).map((s) => s.trim()).filter((s) => s !== ''))].slice(0, 50) : [];
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const tags = tagArr(r.tags);
  const tagsExclude = tagArr(r.tagsExclude);
  let fieldFilters: ContactFieldFilter[] = [];
  if (Array.isArray(r.fieldFilters)) {
    fieldFilters = r.fieldFilters
      // Garde-fou : un élément null / non-objet (corps JSON hostile, ex. `fieldFilters: [null]`) ne doit PAS
      // planter en 500 sur `f.key`. Miroir de la robustesse try/catch de parseFilters côté import.ts.
      .filter((f): f is { key?: unknown; op?: unknown; value?: unknown } => f !== null && typeof f === 'object' && !Array.isArray(f))
      .filter((f) => typeof f.key === 'string')
      .map((f): ContactFieldFilter => ({
        key: String(f.key).slice(0, 120),
        op: isContactFieldOp(f.op) ? f.op : 'eq',
        value: typeof f.value === 'string' ? String(f.value).slice(0, 500) : '',
      }))
      .slice(0, 20);
  }
  const optIn = str(r.optIn);
  return {
    ...(tags.length > 0 ? { tags } : {}),
    ...(r.tagMode === 'or' ? { tagMode: 'or' as const } : {}),
    ...(tagsExclude.length > 0 ? { tagsExclude } : {}),
    ...(optIn === 'opted_in' || optIn === 'opted_out' || optIn === 'unknown' ? { optIn } : {}),
    ...(str(r.phonePrefix) ? { phonePrefix: str(r.phonePrefix) } : {}),
    ...(str(r.phoneContains) ? { phoneContains: str(r.phoneContains) } : {}),
    ...(str(r.nameSearch) ? { nameSearch: str(r.nameSearch) } : {}),
    ...(fieldFilters.length > 0 ? { fieldFilters } : {}),
  };
}

/** Cible d'une action en masse depuis le corps : `ids` non vides -> par ids ; sinon `filters` (+ `excludeIds`).
 *  null si aucune cible exploitable (-> 400, jamais un UPDATE global par erreur). */
function parseBulkTarget(raw: unknown): BulkTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as { ids?: unknown; filters?: unknown; excludeIds?: unknown };
  if (Array.isArray(t.ids) && t.ids.length > 0) {
    const ids = asIdArray(t.ids);
    return ids.length > 0 ? { ids } : null;
  }
  if (t.filters !== undefined) {
    return { filters: normalizeContactFilters(t.filters), excludeIds: asIdArray(t.excludeIds) };
  }
  return null;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
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

    const b = (req.body ?? {}) as { fields?: unknown; removeFields?: unknown; addTags?: unknown; removeTags?: unknown; profileName?: unknown };
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
      values[key] = canonicalizeFieldValue(def.type, val);
    }

    // Suppression de valeurs de champs : n'importe quelle clé présente sur le contact (l'opérateur jsonb `- text[]`
    // est inoffensif et scopé). On accepte donc les clés SANS définition (champ « orphelin » dont le def a été
    // supprimé mais dont la valeur traîne encore sur le contact) : sinon elles seraient impossibles à retirer.
    const removeFields = Array.isArray(b.removeFields)
      ? [...new Set(b.removeFields.map(String).map((k) => k.trim()).filter((k) => k !== ''))].slice(0, 50)
      : [];

    // Nom (profile_name) éditable : chaîne bornée ; vide -> null (on vide). undefined -> on ne touche pas.
    let profileName: string | null | undefined;
    if (b.profileName !== undefined) {
      if (b.profileName !== null && typeof b.profileName !== 'string') return reply.code(400).send({ error: 'profileName invalide' });
      const trimmed = typeof b.profileName === 'string' ? b.profileName.trim().slice(0, 200) : '';
      profileName = trimmed === '' ? null : trimmed;
    }

    if (Object.keys(values).length === 0 && removeFields.length === 0 && addTags.length === 0 && removeTags.length === 0 && profileName === undefined) {
      return reply.code(400).send({ error: 'rien à modifier (fields / removeFields / addTags / removeTags / profileName)' });
    }

    // Une transaction : MERGE/suppression fields + Nom + tags, ou 404 si le contact n'est pas dans le tenant.
    const updated = await deps.applyEdits(tenant, contactId, { fields: values, removeFields, addTags, removeTags, ...(profileName !== undefined ? { profileName } : {}) });
    if (!updated) return reply.code(404).send({ error: 'contact inconnu' });
    // Automations « tag ajouté » (E.2), sur les tags RÉELLEMENT nouveaux : reposer un tag déjà présent ne
    // change rien en base, le déclencheur ne doit donc pas partir. APRÈS l'écriture réussie et en best-effort
    // (un incident de file ne transforme pas une édition de fiche réussie en erreur pour l'opérateur), mais
    // l'échec est JOURNALISÉ : sans trace, une automation muette serait indébogable.
    if (updated.addedTags.length > 0 && deps.emitTagAdded) {
      await deps.emitTagAdded(tenant, contactId, updated.addedTags).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('emitTagAdded ignoré (best-effort):', err instanceof Error ? err.message : err);
      });
    }
    return reply.code(200).send({ contact: updated.contact });
  });

  /**
   * Historique d'un contact : campagnes reçues et conversations tenues. Lecture seule.
   *
   * Le segment `/history` n'est pas décoratif : un `GET /tenants/:t/contacts/:contactId` nu entrerait en
   * concurrence de routage avec les GET statiques `/contacts/count` et `/contacts/ids` de src/http/import.ts.
   * Fastify tranche en faveur du statique, mais c'est une ambiguïté gratuite.
   *
   * Admin-only, comme tout ce fichier (`registerContacts` est monté avec `requireAdmin`). Un agent voit déjà
   * les mêmes conversations dans l'inbox, mais pas l'historique de campagnes, qui est une vue de pilotage.
   */
  app.get('/tenants/:tenantId/contacts/:contactId/history', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { contactId } = req.params as { contactId: string };
    const history = await deps.getContactHistory(tenant, contactId);
    if (!history) return reply.code(404).send({ error: 'contact inconnu' });
    return reply.code(200).send(history);
  });

  /**
   * Envois du contact pour l'EXPORT CSV (F5), non capé. Renvoie du JSON `{ sends: [...] }` (le front construit et
   * télécharge le CSV : le wrapper `request()` fait toujours res.json(), donc pas de CSV brut côté serveur). Admin-only.
   */
  app.get('/tenants/:tenantId/contacts/:contactId/history/export', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { contactId } = req.params as { contactId: string };
    const sends = await deps.listSendsForExport(tenant, contactId);
    if (!sends) return reply.code(404).send({ error: 'contact inconnu' });
    return reply.code(200).send({ sends });
  });

  /**
   * Action en masse (mini-CRM, admin-only) : ajouter/retirer un tag OU poser la valeur d'un champ sur une
   * cible (ids cochés OU filtres + exclusions). Une seule action par appel. Le champ est validé contre les
   * définitions user_fields du tenant (clé inconnue -> 400 ; valeur invalide pour le type -> 400, comme la
   * fiche). La cible est toujours re-scopée `tenant_id` + `deleted_at is null` côté store. Renvoie `{ affected }`.
   */
  app.post('/tenants/:tenantId/contacts/bulk', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;

    const b = (req.body ?? {}) as { target?: unknown; action?: unknown };
    const target = parseBulkTarget(b.target);
    if (target === null) return reply.code(400).send({ error: 'cible invalide (target: { ids } ou { filters, excludeIds })' });
    const action = (b.action ?? {}) as { type?: unknown; tags?: unknown; key?: unknown; value?: unknown };

    if (action.type === 'add_tag' || action.type === 'remove_tag') {
      const tags = asStringArray(action.tags);
      if (tags.length === 0) return reply.code(400).send({ error: 'tag(s) requis' });
      const edits: BulkEdits = action.type === 'add_tag' ? { addTags: tags } : { removeTags: tags };
      const affected = await deps.applyEditsMany(tenant, target, edits);
      return reply.code(200).send({ affected });
    }

    if (action.type === 'set_field') {
      const key = typeof action.key === 'string' ? action.key.trim() : '';
      if (key === '') return reply.code(400).send({ error: 'champ requis (key)' });
      const def = new Map((await deps.listUserFields(tenant)).map((d) => [d.key, d])).get(key);
      if (!def) return reply.code(400).send({ error: `champ inconnu : ${key}` });
      const val = String(action.value ?? '');
      if (!validateFieldValue(def.type, val)) return reply.code(400).send({ error: `valeur invalide pour « ${def.label} » (${def.type})` });
      const affected = await deps.applyEditsMany(tenant, target, { setField: { key, value: canonicalizeFieldValue(def.type, val) } });
      return reply.code(200).send({ affected });
    }

    return reply.code(400).send({ error: 'action inconnue (add_tag | remove_tag | set_field)' });
  });

  /**
   * Suppression DOUCE en masse (mini-CRM, admin-only). Route SÉPARÉE de /bulk (action destructive isolée).
   * Réversible en base, préserve l'historique de campagnes. Renvoie `{ affected }`.
   */
  app.post('/tenants/:tenantId/contacts/bulk-delete', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const target = parseBulkTarget((req.body as { target?: unknown } | undefined)?.target);
    if (target === null) return reply.code(400).send({ error: 'cible invalide (target: { ids } ou { filters, excludeIds })' });
    const affected = await deps.softDeleteMany(tenant, target);
    return reply.code(200).send({ affected });
  });
}
