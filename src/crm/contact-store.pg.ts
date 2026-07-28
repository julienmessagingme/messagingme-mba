import type { Pool } from 'pg';
import type { ContactStore, ContactUpsert } from './import';
import { classifyWaId } from './identity';

export interface ContactRow {
  id: string;
  phoneE164: string | null;
  /** Identité BSUID (business-scoped user id) quand le contact n'a pas de numéro. */
  bsuid: string | null;
  profileName: string | null;
  optInStatus: string;
  fields: Record<string, unknown>;
  tags: string[];
  createdAt: string;
}

/** Opérateurs de filtre sur un champ perso (jsonb, valeur STRING).
 *  `eq`/`contains`/`not_contains` exigent une valeur ; `empty`/`not_empty` n'en prennent pas. */
export type ContactFieldOp = 'eq' | 'contains' | 'not_contains' | 'empty' | 'not_empty';

/** Whitelist des opérateurs de champ. Source UNIQUE partagée par le parsing des query params (GET) ET du
 *  corps JSON (POST bulk) -> pas de divergence entre les deux points d'entrée. */
export const CONTACT_FIELD_OPS: readonly ContactFieldOp[] = ['eq', 'contains', 'not_contains', 'empty', 'not_empty'];
export function isContactFieldOp(v: unknown): v is ContactFieldOp {
  return typeof v === 'string' && (CONTACT_FIELD_OPS as readonly string[]).includes(v);
}

/** Un filtre sur la valeur d'un champ perso. `value` ignorée pour `empty`/`not_empty`. */
export interface ContactFieldFilter { key: string; op: ContactFieldOp; value: string }

/** Critères de requête composables de la « Liste de contacts » (source de campagne) et du mini-CRM. Tous
 *  optionnels ; vides -> aucun filtre (tous les contacts ACTIFS du tenant, `deleted_at is null` toujours posé). */
export interface ContactFilters {
  tags?: string[];
  /** 'and' (défaut) = contient TOUS les tags ; 'or' = en partage au moins un. */
  tagMode?: 'and' | 'or';
  /** Exclut tout contact portant AU MOINS un de ces tags (« ne possède pas »). */
  tagsExclude?: string[];
  optIn?: 'opted_in' | 'opted_out' | 'unknown';
  /** Préfixe E.164 ancré (ex. « +336 »). */
  phonePrefix?: string;
  /** Sous-chaîne de chiffres du numéro (ex. « 42 42 »). */
  phoneContains?: string;
  /** Recherche sur le nom de profil (insensible à la casse). */
  nameSearch?: string;
  fieldFilters?: ContactFieldFilter[];
}

/** Cible d'une action en masse : soit une liste d'ids explicites, soit un jeu de filtres re-résolu côté
 *  serveur (avec exclusions pour les lignes décochées d'un « tout sélectionner »). Jamais un payload de 100k UUID. */
export type BulkTarget = { ids: string[] } | { filters: ContactFilters; excludeIds?: string[] };

/** Mutation d'une action en masse (une seule à la fois côté menu, mais cumulable). Valeur de champ déjà
 *  VALIDÉE + canonicalisée en amont (route). */
export interface BulkEdits { addTags?: string[]; removeTags?: string[]; setField?: { key: string; value: string } }

/**
 * Store Postgres des contacts. Upsert par (tenant, téléphone) avec MERGE jsonb des
 * champs perso (jamais d'écrasement des clés absentes du CSV courant) et opt-in qui
 * ne régresse jamais (unknown -> opted_in seulement).
 */
export class PgContactStore implements ContactStore {
  constructor(private readonly pool: Pool) {}

  /** Comme upsertByPhone mais renvoie AUSSI l'id du contact (pour l'API : upsert-then-send adresse par id). */
  async upsertByPhoneReturningId(c: ContactUpsert): Promise<{ id: string; created: boolean }> {
    // Index unique PARTIEL contacts_tenant_phone_uidx (where phone_e164 is not null) :
    // le ON CONFLICT doit répéter le prédicat pour cibler cet index.
    const res = await this.pool.query<{ id: string; created: boolean }>(
      `insert into contacts (tenant_id, phone_e164, profile_name, fields, opt_in_status, opt_in_source, tags)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7::text[])
       on conflict (tenant_id, phone_e164) where phone_e164 is not null
       do update set
         fields = contacts.fields || excluded.fields,
         profile_name = coalesce(excluded.profile_name, contacts.profile_name),
         opt_in_status = case
           when excluded.opt_in_status = 'opted_in' then 'opted_in'
           else contacts.opt_in_status
         end,
         opt_in_source = coalesce(excluded.opt_in_source, contacts.opt_in_source),
         -- Union dédupliquée : les nouveaux tags s'ajoutent, jamais d'écrasement.
         tags = (select coalesce(array_agg(distinct t), '{}') from unnest(contacts.tags || excluded.tags) t),
         -- Ré-ajouter un contact (import CSV, /v1/sends createMissing) le RESSUSCITE : re-poser le numéro
         -- efface la suppression douce. Sur un contact déjà actif, no-op (deleted_at était déjà null).
         deleted_at = null,
         updated_at = now()
       returning id, (xmax = 0) as created`,
      [
        c.tenantId,
        c.phoneE164,
        c.profileName,
        JSON.stringify(c.fields),
        c.optInStatus,
        c.optInSource ?? null,
        c.tags ?? [],
      ],
    );
    const row = res.rows[0]!;
    return { id: row.id, created: row.created };
  }

  async upsertByPhone(c: ContactUpsert): Promise<'created' | 'updated'> {
    return (await this.upsertByPhoneReturningId(c)).created ? 'created' : 'updated';
  }

  /** Contact ACTIF par téléphone E.164 exact (tenant scopé). null si absent OU supprimé (soft-delete) : un
   *  contact supprimé est « introuvable » pour l'API d'envoi (/v1/sends) -> il est skippé (unknown_contact) ou,
   *  si createMissing, ré-upserté donc ressuscité. Jamais destinataire d'un envoi. */
  async findByPhone(tenantId: string, phoneE164: string): Promise<ContactRow | null> {
    const res = await this.pool.query(
      `select id, phone_e164, bsuid, profile_name, opt_in_status, fields, tags, created_at
       from contacts where tenant_id = $1 and phone_e164 = $2 and deleted_at is null limit 1`,
      [tenantId, phoneE164],
    );
    const r = res.rows[0];
    return r ? PgContactStore.rowToContact(r) : null;
  }

  /**
   * MERGE jsonb des valeurs saisies dans un WhatsApp Flow sur le contact correspondant (par tenant + wa_id).
   * Même matching téléphone que l'inbox (E.164 exact `'+' || wa_id` PUIS chiffres nus, préférence à l'exact,
   * un seul contact). V1 : NE crée PAS un contact inconnu (merge-only) — un flow rempli par un numéro hors
   * base n'invente pas de fiche. Renvoie le nombre de contacts touchés (0 = inconnu). `fields || values` :
   * les clés fournies écrasent, les autres sont préservées.
   */
  async mergeFieldsByPhone(tenantId: string, waId: string, values: Record<string, unknown>): Promise<number> {
    if (Object.keys(values).length === 0) return 0;
    const res = await this.pool.query(
      `update contacts set fields = fields || $3::jsonb, updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
           and (phone_e164 = '+' || $2 or regexp_replace(phone_e164, '[^0-9]', '', 'g') = $2 or bsuid = $2)
         order by (phone_e164 = '+' || $2) desc limit 1
       )`,
      [tenantId, waId, JSON.stringify(values)],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Consentement marketing EXPLICITE capté par un WhatsApp Flow (composant OptIn coché) : passe le contact à
   * opt_in_status='opted_in'. GAGNE toujours, même sur un opted_out antérieur (décision produit Julien : une
   * action fraîche du contact lui-même dans WhatsApp est une preuve forte, cohérent avec l'opt-in de l'import
   * CSV). Même matching que mergeFieldsByPhone (E.164 exact PUIS chiffres nus PUIS bsuid, 1 contact). Merge-only :
   * ne crée pas de fiche pour un numéro inconnu. Renvoie le nb de contacts touchés (0 = inconnu).
   */
  async markOptedIn(tenantId: string, waId: string, source: string): Promise<number> {
    const res = await this.pool.query(
      `update contacts set opt_in_status = 'opted_in', opt_in_source = $3, updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
           and (phone_e164 = '+' || $2 or regexp_replace(phone_e164, '[^0-9]', '', 'g') = $2 or bsuid = $2)
         order by (phone_e164 = '+' || $2) desc limit 1
       )`,
      [tenantId, waId, source],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Ajoute des tags (union dédupliquée) au contact d'un numéro (bloc « ajout de tag » d'un workflow). Même
   * matching que mergeFieldsByPhone (E.164 exact PUIS chiffres nus, 1 contact). Merge-only : ne crée pas de
   * fiche pour un numéro inconnu. Renvoie le nb de contacts touchés (0 = inconnu).
   */
  async addTagsByPhone(tenantId: string, waId: string, tags: string[]): Promise<number> {
    const clean = [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ''))];
    if (clean.length === 0) return 0;
    const res = await this.pool.query(
      `update contacts set tags = (select coalesce(array_agg(distinct t), '{}') from unnest(tags || $3::text[]) t), updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
           and (phone_e164 = '+' || $2 or regexp_replace(phone_e164, '[^0-9]', '', 'g') = $2 or bsuid = $2)
         order by (phone_e164 = '+' || $2) desc limit 1
       )`,
      [tenantId, waId, clean],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Auto-crée (ou rafraîchit) une fiche contact depuis un message ENTRANT. Le `wa_id` est classé en numéro
   * OU BSUID (règle `classifyWaId`). Upsert par l'index unique correspondant : ne régresse JAMAIS l'opt-in
   * (posé à 'unknown' seulement à la création, source 'inbound'), et ne met à jour que le nom de profil
   * (coalesce, jamais écrasé par null). Best-effort : à appeler en isolation (ne doit pas casser l'inbox).
   * Renvoie 'created' | 'updated' | 'skipped' (wa_id vide).
   */
  async upsertFromInbound(tenantId: string, waId: string, profileName: string | null): Promise<'created' | 'updated' | 'skipped'> {
    const { phoneE164, bsuid } = classifyWaId(waId);
    if (!phoneE164 && !bsuid) return 'skipped';
    // Deux index uniques partiels distincts (phone / bsuid) -> le ON CONFLICT doit cibler le bon.
    const conflict = phoneE164
      ? 'on conflict (tenant_id, phone_e164) where phone_e164 is not null'
      : 'on conflict (tenant_id, bsuid) where bsuid is not null';
    const res = await this.pool.query<{ created: boolean }>(
      `insert into contacts (tenant_id, phone_e164, bsuid, profile_name, opt_in_status, opt_in_source)
       values ($1, $2, $3, $4, 'unknown', 'inbound')
       ${conflict}
       do update set profile_name = coalesce(excluded.profile_name, contacts.profile_name), updated_at = now()
       returning (xmax = 0) as created`,
      [tenantId, phoneE164 ?? null, bsuid ?? null, profileName],
    );
    return res.rows[0]?.created ? 'created' : 'updated';
  }

  /**
   * Résout un contact par wa_id pour COLLER ses attributs dans les variables d'un template (envoi via workflow).
   * Même matching que mergeFieldsByPhone/addTagsByPhone (E.164 exact `'+' || wa_id` PUIS chiffres nus PUIS bsuid,
   * 1 contact, préférence à l'exact). Renvoie {phone_e164, bsuid, profile_name, fields} (forme ResolvableContact),
   * ou null si le numéro est hors base -> l'appelant retombe sur les exemples du template (jamais de throw).
   * `bsuid` est inclus : les sources de variable système `bsuid`/`wa_id` doivent se résoudre AUSSI sur la voie workflow.
   */
  async getResolvableByPhone(
    tenantId: string,
    waId: string,
  ): Promise<{ phone_e164: string | null; bsuid: string | null; profile_name: string | null; fields: Record<string, unknown> } | null> {
    const res = await this.pool.query<{ phone_e164: string | null; bsuid: string | null; profile_name: string | null; fields: Record<string, unknown> | null }>(
      `select phone_e164, bsuid, profile_name, fields from contacts where tenant_id = $1
         and (phone_e164 = '+' || $2 or regexp_replace(phone_e164, '[^0-9]', '', 'g') = $2 or bsuid = $2)
       order by (phone_e164 = '+' || $2) desc limit 1`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r ? { phone_e164: r.phone_e164, bsuid: r.bsuid, profile_name: r.profile_name, fields: r.fields ?? {} } : null;
  }

  private static rowToContact(r: {
    id: string; phone_e164: string | null; bsuid: string | null; profile_name: string | null; opt_in_status: string;
    fields: Record<string, unknown>; tags: string[] | null; created_at: Date;
  }): ContactRow {
    return {
      id: r.id, phoneE164: r.phone_e164, bsuid: r.bsuid, profileName: r.profile_name, optInStatus: r.opt_in_status,
      fields: r.fields, tags: r.tags ?? [], createdAt: r.created_at.toISOString(),
    };
  }
  private static readonly SELECT_ONE =
    'select id, phone_e164, bsuid, profile_name, opt_in_status, fields, tags, created_at from contacts where id = $1 and tenant_id = $2';

  /** Un contact par id, scopé tenant. null si absent/autre tenant. */
  async getById(tenantId: string, contactId: string): Promise<ContactRow | null> {
    const res = await this.pool.query(PgContactStore.SELECT_ONE, [contactId, tenantId]);
    const r = res.rows[0];
    return r ? PgContactStore.rowToContact(r) : null;
  }

  /**
   * Édite UN contact (fiche) en une TRANSACTION : MERGE des valeurs de fields (n'écrase que les clés
   * fournies, invariant import/flow) + ajout/retrait de tags (dédupliqués). Verrouille la ligne (FOR UPDATE),
   * renvoie le contact à jour, ou null s'il n'existe pas dans le tenant (=> 404). Atomique : un échec en
   * cours de route ne laisse pas une modif partielle (calqué sur createWithRecipients).
   */
  async applyEdits(
    tenantId: string,
    contactId: string,
    edits: { fields: Record<string, string>; removeFields?: string[]; addTags: string[]; removeTags: string[]; profileName?: string | null },
  ): Promise<ContactRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const exists = await client.query('select 1 from contacts where id = $1 and tenant_id = $2 for update', [contactId, tenantId]);
      if ((exists.rowCount ?? 0) === 0) {
        await client.query('rollback');
        return null;
      }
      if (Object.keys(edits.fields).length > 0) {
        // MERGE : n'écrase que les clés fournies (mise à jour en place d'une valeur = fournir la clé).
        await client.query('update contacts set fields = fields || $3::jsonb, updated_at = now() where id = $1 and tenant_id = $2', [contactId, tenantId, JSON.stringify(edits.fields)]);
      }
      if (edits.removeFields && edits.removeFields.length > 0) {
        // Retire les clés jsonb (opérateur `- text[]`, PG 10+) : purge la valeur du champ SUR CE contact (pas la définition).
        await client.query('update contacts set fields = fields - $3::text[], updated_at = now() where id = $1 and tenant_id = $2', [contactId, tenantId, edits.removeFields]);
      }
      if (edits.profileName !== undefined) {
        // Nom (profile_name) éditable ; null = vider. Le téléphone et le BSUID (clés d'identité/routage) restent hors édition.
        await client.query('update contacts set profile_name = $3, updated_at = now() where id = $1 and tenant_id = $2', [contactId, tenantId, edits.profileName]);
      }
      if (edits.addTags.length > 0) {
        await client.query(`update contacts set tags = (select coalesce(array_agg(distinct t), '{}') from unnest(tags || $3::text[]) t), updated_at = now() where id = $1 and tenant_id = $2`, [contactId, tenantId, edits.addTags]);
      }
      if (edits.removeTags.length > 0) {
        await client.query(`update contacts set tags = (select coalesce(array_agg(t), '{}') from unnest(tags) t where t <> all($3::text[])), updated_at = now() where id = $1 and tenant_id = $2`, [contactId, tenantId, edits.removeTags]);
      }
      const res = await client.query(PgContactStore.SELECT_ONE, [contactId, tenantId]);
      await client.query('commit');
      const r = res.rows[0];
      return r ? PgContactStore.rowToContact(r) : null;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Requête filtrée + paginée (source « Liste de contacts » de campagne + mini-CRM). Filtres composables (tags
   * AND/OR + exclusion, opt-in, préfixe/contenu de téléphone, recherche nom, valeur de champ perso). Scopé tenant,
   * `deleted_at is null` toujours posé (un contact supprimé disparaît).
   */
  async query(tenantId: string, filters: ContactFilters, limit = 100, offset = 0): Promise<ContactRow[]> {
    const capped = Math.min(Math.max(limit, 1), 500);
    const { where, params } = buildContactWhere(tenantId, filters);
    const limitRef = `$${params.length + 1}`;
    const offsetRef = `$${params.length + 2}`;
    const res = await this.pool.query<{
      id: string; phone_e164: string | null; bsuid: string | null; profile_name: string | null;
      opt_in_status: string; fields: Record<string, unknown>; tags: string[] | null; created_at: Date;
    }>(
      `select id, phone_e164, bsuid, profile_name, opt_in_status, fields, tags, created_at
       from contacts where ${where}
       order by created_at desc limit ${limitRef} offset ${offsetRef}`,
      [...params, capped, Math.max(offset, 0)],
    );
    return res.rows.map(PgContactStore.rowToContact);
  }

  /** Nombre de contacts correspondant aux filtres (pour afficher « N contacts » AVANT de fixer le débit). */
  async count(tenantId: string, filters: ContactFilters): Promise<number> {
    const { where, params } = buildContactWhere(tenantId, filters);
    const res = await this.pool.query<{ n: string }>(`select count(*)::text as n from contacts where ${where}`, params);
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Ids des contacts correspondant aux filtres (résolution serveur de la source « Liste de contacts »
   *  d'une campagne, sans charger tout le CRM côté front). Scopé tenant. Cap dur anti-abus. */
  async idsForFilters(tenantId: string, filters: ContactFilters, cap = 100_000): Promise<string[]> {
    const { where, params } = buildContactWhere(tenantId, filters);
    const capRef = `$${params.length + 1}`;
    const res = await this.pool.query<{ id: string }>(
      `select id from contacts where ${where} order by created_at desc limit ${capRef}`,
      [...params, Math.max(1, cap)],
    );
    return res.rows.map((r) => r.id);
  }

  /** Liste paginée des contacts d'un tenant (les plus récents d'abord). */
  async list(tenantId: string, limit = 100, offset = 0, tag?: string): Promise<ContactRow[]> {
    const capped = Math.min(Math.max(limit, 1), 500);
    const hasTag = typeof tag === 'string' && tag.trim() !== '';
    const params: unknown[] = [tenantId, capped, Math.max(offset, 0)];
    if (hasTag) params.push(tag!.trim());
    const res = await this.pool.query<{
      id: string;
      phone_e164: string | null;
      bsuid: string | null;
      profile_name: string | null;
      opt_in_status: string;
      fields: Record<string, unknown>;
      tags: string[] | null;
      created_at: Date;
    }>(
      `select id, phone_e164, bsuid, profile_name, opt_in_status, fields, tags, created_at
       from contacts where tenant_id = $1 and deleted_at is null${hasTag ? ' and tags @> array[$4]::text[]' : ''}
       order by created_at desc
       limit $2 offset $3`,
      params,
    );
    return res.rows.map((r) => ({
      id: r.id,
      phoneE164: r.phone_e164,
      bsuid: r.bsuid,
      profileName: r.profile_name,
      optInStatus: r.opt_in_status,
      fields: r.fields,
      tags: r.tags ?? [],
      createdAt: r.created_at.toISOString(),
    }));
  }

  /**
   * Action en masse (mini-CRM) : ajoute/retire des tags et/ou pose la valeur d'UN champ perso sur la cible
   * (ids explicites OU filtres re-résolus côté serveur, avec exclusions). UNE seule requête UPDATE ensembliste
   * (pas de boucle par contact), atomique par nature. La valeur de champ est déjà VALIDÉE + canonicalisée par
   * la route (invariant : jamais de valeur non validée en base). Toujours scopé `tenant_id` + `deleted_at is null`.
   * Renvoie le nombre de contacts touchés. Aucune mutation demandée -> 0 (no-op).
   */
  async applyEditsMany(tenantId: string, target: BulkTarget, edits: BulkEdits): Promise<number> {
    const addTags = [...new Set((edits.addTags ?? []).map((t) => t.trim()).filter((t) => t !== ''))];
    const removeTags = [...new Set((edits.removeTags ?? []).map((t) => t.trim()).filter((t) => t !== ''))];
    const hasSet = edits.setField !== undefined && edits.setField.key.trim() !== '';
    if (addTags.length === 0 && removeTags.length === 0 && !hasSet) return 0;

    const sel = buildBulkSelector(tenantId, target);
    const params = [...sel.params];
    const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };
    const sets: string[] = [];
    if (addTags.length > 0 || removeTags.length > 0) {
      // UNE SEULE assignation `tags =` : Postgres refuse deux assignations de la même colonne dans un même
      // UPDATE. On ajoute (union dédupliquée) PUIS on retire, en un sous-select. add vide -> rien ajouté ;
      // remove vide -> `t <> all('{}')` vaut TRUE partout -> rien retiré. Gère add seul, remove seul, ou les deux.
      const addRef = add(addTags);
      const remRef = add(removeTags);
      sets.push(`tags = (select coalesce(array_agg(distinct t), '{}') from unnest(tags || ${addRef}::text[]) t where t <> all(${remRef}::text[]))`);
    }
    if (hasSet) {
      // MERGE jsonb : n'écrase que la clé posée, préserve les autres champs (invariant import/flow).
      sets.push(`fields = fields || ${add(JSON.stringify({ [edits.setField!.key]: edits.setField!.value }))}::jsonb`);
    }
    sets.push('updated_at = now()');
    const res = await this.pool.query(`update contacts set ${sets.join(', ')} where ${sel.where}`, params);
    return res.rowCount ?? 0;
  }

  /**
   * Suppression DOUCE en masse (mini-CRM) : pose `deleted_at = now()` sur la cible (ids OU filtres + exclusions).
   * Réversible en base, préserve l'historique de campagnes (pas de cascade). Idempotent : ne re-touche pas un
   * contact déjà supprimé (`deleted_at is null` dans le sélecteur). Renvoie le nombre de contacts supprimés.
   */
  async softDeleteMany(tenantId: string, target: BulkTarget): Promise<number> {
    const sel = buildBulkSelector(tenantId, target);
    const res = await this.pool.query(
      `update contacts set deleted_at = now(), updated_at = now() where ${sel.where}`,
      sel.params,
    );
    return res.rowCount ?? 0;
  }
}

/**
 * Construit un WHERE dynamique PARAMÉTRÉ pour requêter les contacts (source « Liste de contacts » d'une campagne
 * + mini-CRM). `tenant_id = $1` ET `deleted_at is null` TOUJOURS présents (anti-fuite cross-tenant + soft-delete).
 * Chaque filtre ajoute un paramètre. Les valeurs de champ perso sont stockées en STRING dans le jsonb ->
 * comparaison textuelle. Fonction PURE (aucun accès DB) -> testable en unitaire sans Postgres.
 */
export function buildContactWhere(tenantId: string, f: ContactFilters): { where: string; params: unknown[] } {
  const clauses: string[] = ['tenant_id = $1', 'deleted_at is null'];
  const params: unknown[] = [tenantId];
  const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };

  const tags = (f.tags ?? []).map((t) => t.trim()).filter((t) => t !== '');
  if (tags.length > 0) {
    // AND = contient TOUS les tags (@>) ; OR = en partage AU MOINS un (&&).
    const op = f.tagMode === 'or' ? '&&' : '@>';
    clauses.push(`tags ${op} ${add(tags)}::text[]`);
  }
  const tagsExclude = (f.tagsExclude ?? []).map((t) => t.trim()).filter((t) => t !== '');
  if (tagsExclude.length > 0) {
    // « Ne possède pas » : exclut tout contact partageant au moins un de ces tags. `tags` est non-null (default '{}'),
    // donc un contact sans tag -> `not ('{}' && [...])` = not false = INCLUS. Correct.
    clauses.push(`not (tags && ${add(tagsExclude)}::text[])`);
  }
  if (f.optIn === 'opted_in' || f.optIn === 'opted_out' || f.optIn === 'unknown') {
    clauses.push(`opt_in_status = ${add(f.optIn)}`);
  }
  if (f.phonePrefix && f.phonePrefix.trim() !== '') {
    // Préfixe ANCRÉ (utilise l'index unique sur phone_e164). On garde `+` et chiffres saisis tels quels.
    clauses.push(`phone_e164 like ${add(f.phonePrefix.trim() + '%')}`);
  }
  if (f.phoneContains && f.phoneContains.replace(/\D/g, '') !== '') {
    // Contenu : on compare sur les CHIFFRES nus des deux côtés (le stocké est +E.164).
    clauses.push(`regexp_replace(coalesce(phone_e164,''), '[^0-9]', '', 'g') like '%' || ${add(f.phoneContains.replace(/\D/g, ''))} || '%'`);
  }
  if (f.nameSearch && f.nameSearch.trim() !== '') {
    clauses.push(`profile_name ilike '%' || ${add(f.nameSearch.trim())} || '%'`);
  }
  for (const ff of f.fieldFilters ?? []) {
    const key = String(ff.key ?? '').trim();
    if (key === '') continue;
    // `fields ->> $key` : la clé jsonb est PARAMÉTRÉE (pas d'interpolation SQL). Le placeholder est réutilisé
    // (Postgres autorise un même $N plusieurs fois) -> un seul param par clé. IMPORTANT : ne pousser le param
    // clé (add(key)) QU'UNE FOIS la clause décidée, sinon un filtre sauté laisserait un param orphelin non
    // référencé (numérotation $N décalée). D'où le contrôle de valeur AVANT `add` pour eq/contains/not_contains.
    if (ff.op === 'empty') { const kr = add(key); clauses.push(`(fields ->> ${kr} is null or fields ->> ${kr} = '')`); continue; }
    if (ff.op === 'not_empty') { const kr = add(key); clauses.push(`(fields ->> ${kr} is not null and fields ->> ${kr} <> '')`); continue; }
    // eq / contains / not_contains : exigent une valeur non vide (sans quoi le filtre n'est PAS posé).
    const val = String(ff.value ?? '');
    if (val === '') continue;
    const kr = add(key);
    if (ff.op === 'contains') clauses.push(`coalesce(fields ->> ${kr}, '') ilike '%' || ${add(val)} || '%'`);
    else if (ff.op === 'not_contains') clauses.push(`coalesce(fields ->> ${kr}, '') not ilike '%' || ${add(val)} || '%'`);
    else clauses.push(`fields ->> ${kr} = ${add(val)}`);
  }
  return { where: clauses.join(' and '), params };
}

/**
 * Construit le WHERE d'une action en masse depuis une BulkTarget. Ids explicites -> `id = any($ids)` (toujours
 * scopé tenant + actif). Filtres -> réutilise `buildContactWhere` (donc tenant + `deleted_at is null` inclus)
 * puis exclut les ids décochés. Fonction PURE (testable sans DB).
 */
export function buildBulkSelector(tenantId: string, target: BulkTarget): { where: string; params: unknown[] } {
  if ('ids' in target) {
    const ids = [...new Set(target.ids.filter((id) => typeof id === 'string' && id.trim() !== ''))];
    // Cible vide -> WHERE impossible (`false`) : aucune ligne touchée (jamais un UPDATE global par erreur).
    if (ids.length === 0) return { where: 'false', params: [] };
    return { where: 'tenant_id = $1 and deleted_at is null and id = any($2::uuid[])', params: [tenantId, ids] };
  }
  const { where, params } = buildContactWhere(tenantId, target.filters);
  const excludeIds = [...new Set((target.excludeIds ?? []).filter((id) => typeof id === 'string' && id.trim() !== ''))];
  if (excludeIds.length === 0) return { where, params };
  const p = [...params];
  p.push(excludeIds);
  return { where: `${where} and not (id = any($${p.length}::uuid[]))`, params: p };
}
