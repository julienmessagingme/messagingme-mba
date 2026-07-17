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

/** Un filtre sur la valeur d'un champ perso (jsonb, valeur STRING) : égalité exacte ou sous-chaîne. */
export interface ContactFieldFilter { key: string; op: 'eq' | 'contains'; value: string }

/** Critères de requête composables de la « Liste de contacts » (source de campagne). Tous optionnels ;
 *  vides -> aucun filtre (tous les contacts du tenant). */
export interface ContactFilters {
  tags?: string[];
  /** 'and' (défaut) = contient TOUS les tags ; 'or' = en partage au moins un. */
  tagMode?: 'and' | 'or';
  optIn?: 'opted_in' | 'opted_out' | 'unknown';
  /** Préfixe E.164 ancré (ex. « +336 »). */
  phonePrefix?: string;
  /** Sous-chaîne de chiffres du numéro (ex. « 42 42 »). */
  phoneContains?: string;
  /** Recherche sur le nom de profil (insensible à la casse). */
  nameSearch?: string;
  fieldFilters?: ContactFieldFilter[];
}

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

  /** Contact par téléphone E.164 exact (tenant scopé). null si absent. Pour l'API : décider create vs update. */
  async findByPhone(tenantId: string, phoneE164: string): Promise<ContactRow | null> {
    const res = await this.pool.query(
      `select id, phone_e164, bsuid, profile_name, opt_in_status, fields, tags, created_at
       from contacts where tenant_id = $1 and phone_e164 = $2 limit 1`,
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
   * Construit un WHERE dynamique PARAMÉTRÉ pour requêter les contacts (source « Liste de contacts » d'une
   * campagne). `tenant_id = $1` TOUJOURS présent (anti-fuite cross-tenant). Chaque filtre ajoute un paramètre.
   * Les valeurs de champ perso sont stockées en STRING dans le jsonb -> comparaison textuelle (eq/contains).
   */
  private static buildWhere(tenantId: string, f: ContactFilters): { where: string; params: unknown[] } {
    const clauses: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };

    const tags = (f.tags ?? []).map((t) => t.trim()).filter((t) => t !== '');
    if (tags.length > 0) {
      // AND = contient TOUS les tags (@>) ; OR = en partage AU MOINS un (&&).
      const op = f.tagMode === 'or' ? '&&' : '@>';
      clauses.push(`tags ${op} ${add(tags)}::text[]`);
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
      const val = String(ff.value ?? '');
      if (key === '' || val === '') continue;
      // `fields ->> $key` : la clé jsonb est PARAMÉTRÉE (pas d'interpolation). eq exact ou contains (ilike).
      const keyRef = add(key);
      if (ff.op === 'contains') clauses.push(`coalesce(fields ->> ${keyRef}, '') ilike '%' || ${add(val)} || '%'`);
      else clauses.push(`fields ->> ${keyRef} = ${add(val)}`);
    }
    return { where: clauses.join(' and '), params };
  }

  /**
   * Requête filtrée + paginée (source « Liste de contacts » de campagne). Filtres composables (tags AND/OR,
   * opt-in, préfixe/contenu de téléphone, recherche nom, valeur de champ perso). Toujours scopé tenant.
   */
  async query(tenantId: string, filters: ContactFilters, limit = 100, offset = 0): Promise<ContactRow[]> {
    const capped = Math.min(Math.max(limit, 1), 500);
    const { where, params } = PgContactStore.buildWhere(tenantId, filters);
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
    const { where, params } = PgContactStore.buildWhere(tenantId, filters);
    const res = await this.pool.query<{ n: string }>(`select count(*)::text as n from contacts where ${where}`, params);
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Ids des contacts correspondant aux filtres (résolution serveur de la source « Liste de contacts »
   *  d'une campagne, sans charger tout le CRM côté front). Scopé tenant. Cap dur anti-abus. */
  async idsForFilters(tenantId: string, filters: ContactFilters, cap = 100_000): Promise<string[]> {
    const { where, params } = PgContactStore.buildWhere(tenantId, filters);
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
       from contacts where tenant_id = $1${hasTag ? ' and tags @> array[$4]::text[]' : ''}
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
}
