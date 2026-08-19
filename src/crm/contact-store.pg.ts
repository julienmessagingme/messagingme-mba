import type { Pool } from 'pg';
import type { ContactStore, ContactUpsert } from './import';
import { classifyWaId, waIdOf } from './identity';

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

/**
 * Résolution d'un contact à partir d'un `wa_id` : E.164 exact (`'+' || wa_id`), sinon chiffres nus, sinon
 * BSUID ; un seul contact, préférence à la correspondance exacte. Attend `$1` = tenant, `$2` = wa_id, et se
 * pose derrière un `where tenant_id = $1` (auquel l'appelant ajoute ses propres clauses avant, ex.
 * `deleted_at is null`).
 *
 * Fragment partagé parce que c'est la règle de routage des messages entrants : elle était recopiée dans
 * neuf requêtes de ce fichier, et les copies avaient commencé à diverger. Une seule écriture, sinon un
 * ajustement s'applique à huit sites sur neuf sans que rien ne le signale.
 */
export function matchWaIdPredicat(contact: string, waId: string): string {
  return `(${contact}phone_e164 = '+' || ${waId} or regexp_replace(${contact}phone_e164, '[^0-9]', '', 'g') = ${waId} or ${contact}bsuid = ${waId})`;
}

export const MATCH_BY_WAID_SQL = `and ${matchWaIdPredicat('', '$2')}
       order by (phone_e164 = '+' || $2) desc limit 1`;

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
export interface BulkEdits {
  addTags?: string[];
  removeTags?: string[];
  setField?: { key: string; value: string };
  /**
   * Bascule du consentement marketing depuis le mini-CRM. C'est le SEUL chemin capable d'écrire `opted_out` :
   * l'upsert d'import et d'API ne fait JAMAIS régresser un statut (unknown -> opted_in seulement, cf.
   * `upsertByPhone`), si bien qu'un client demandant à ne plus rien recevoir n'était enregistrable nulle part.
   * Le garde-fou de campagne, lui, lisait déjà `opted_out` pour exclure.
   */
  setOptIn?: 'opted_in' | 'opted_out';
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
      `insert into contacts (tenant_id, phone_e164, profile_name, fields, opt_in_status, opt_in_source, tags, bsuid)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7::text[], $8)
       on conflict (tenant_id, phone_e164) where phone_e164 is not null
       do update set
         fields = contacts.fields || excluded.fields,
         profile_name = coalesce(excluded.profile_name, contacts.profile_name),
         -- coalesce, et pas une affectation seche : un upsert SANS bsuid (import CSV, /v1/sends) ne doit pas
         -- effacer l'identifiant d'un contact arrivé par l'inbound sans numéro partagé.
         bsuid = coalesce(excluded.bsuid, contacts.bsuid),
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
        c.bsuid ?? null,
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
   * Matching `MATCH_BY_WAID_SQL`. V1 : NE crée PAS un contact inconnu (merge-only) — un flow rempli par un numéro hors
   * base n'invente pas de fiche. Renvoie le nombre de contacts touchés (0 = inconnu). `fields || values` :
   * les clés fournies écrasent, les autres sont préservées.
   */
  async mergeFieldsByPhone(tenantId: string, waId: string, values: Record<string, unknown>): Promise<number> {
    if (Object.keys(values).length === 0) return 0;
    const res = await this.pool.query(
      `update contacts set fields = fields || $3::jsonb, updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       )`,
      [tenantId, waId, JSON.stringify(values)],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Consentement marketing EXPLICITE capté par un WhatsApp Flow (composant OptIn coché) : passe le contact à
   * opt_in_status='opted_in'. GAGNE toujours, même sur un opted_out antérieur (décision produit Julien : une
   * action fraîche du contact lui-même dans WhatsApp est une preuve forte, cohérent avec l'opt-in de l'import
   * CSV). Matching `MATCH_BY_WAID_SQL`. Merge-only : ne crée pas de fiche pour un numéro inconnu.
   *
   * Renvoie l'IDENTIFIANT du contact touché, `null` si le numéro est inconnu. L'identifiant, et pas un
   * compteur : c'est la seule chose que le journal d'audit ait le droit d'écrire (y consigner le numéro
   * ruinerait la purge, qui existe pour l'effacer).
   */
  async markOptedIn(tenantId: string, waId: string, source: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `update contacts set opt_in_status = 'opted_in', opt_in_source = $3, updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       )
       returning id`,
      [tenantId, waId, source],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * Écrit le NOM (profile_name) du contact d'un numéro : sert au champ de BASE « Nom » d'un WhatsApp Flow, qui
   * est un attribut (pas une clé de `contacts.fields`) et ne peut donc pas passer par mergeFieldsByPhone.
   * Matching `MATCH_BY_WAID_SQL`. Merge-only : ne crée pas de fiche pour un numéro inconnu. Nom vide -> no-op (on n'écrase pas par du vide). Renvoie le nb touché.
   */
  async setProfileNameByPhone(tenantId: string, waId: string, name: string): Promise<number> {
    const n = name.trim();
    if (n === '') return 0;
    const res = await this.pool.query(
      `update contacts set profile_name = $3, updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       )`,
      [tenantId, waId, n],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Comme `addTagsByPhone`, mais dit AUSSI lesquels étaient réellement nouveaux.
   *
   * L'ajout est une union : reposer un tag déjà présent réécrit la ligne sans rien changer, donc le `rowCount`
   * vaut 1 dans les deux cas et ne prouve rien. Or « tag ajouté » déclenche un scénario, donc un envoi facturé :
   * annoncer un ajout qui n'a pas eu lieu enverrait un message pour un non-événement. `RETURNING` l'état d'avant
   * (via une sous-requête) donne le delta sans aller-retour supplémentaire.
   */
  async addTagsByPhoneReturningNew(tenantId: string, waId: string, tags: string[]): Promise<{ touched: number; added: string[] }> {
    const clean = [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ''))];
    if (clean.length === 0) return { touched: 0, added: [] };
    const res = await this.pool.query<{ avant: string[] | null }>(
      `update contacts c set tags = (select coalesce(array_agg(distinct t), '{}') from unnest(c.tags || $3::text[]) t), updated_at = now()
       from (
         select id, tags from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       ) src
       where c.id = src.id
       returning src.tags as avant`,
      [tenantId, waId, clean],
    );
    const avant = new Set(res.rows[0]?.avant ?? []);
    return { touched: res.rowCount ?? 0, added: (res.rowCount ?? 0) === 0 ? [] : clean.filter((t) => !avant.has(t)) };
  }

  /**
   * Retire des tags du contact d'un numéro (bloc Action « retirer un tag »). Matching `MATCH_BY_WAID_SQL`.
   * Merge-only : ne crée pas de fiche. Renvoie le nb touché.
   */
  async removeTagsByPhone(tenantId: string, waId: string, tags: string[]): Promise<number> {
    const clean = [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ''))];
    if (clean.length === 0) return 0;
    const res = await this.pool.query(
      `update contacts set tags = (select coalesce(array_agg(t), '{}') from unnest(tags) t where t <> all($3::text[])), updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       )`,
      [tenantId, waId, clean],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Vide des champs (retire les clés de `contacts.fields`) du contact d'un numéro (bloc Action « vider un champ »).
   * Matching `MATCH_BY_WAID_SQL`. Merge-only : ne crée pas de fiche. Renvoie le nb de contacts touchés.
   */
  async clearFieldsByPhone(tenantId: string, waId: string, keys: string[]): Promise<number> {
    const clean = [...new Set(keys.map((k) => k.trim()).filter((k) => k !== ''))];
    if (clean.length === 0) return 0;
    const res = await this.pool.query(
      `update contacts set fields = fields - $3::text[], updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
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
   * Matching `MATCH_BY_WAID_SQL`. Renvoie {phone_e164, bsuid, profile_name, fields} (forme ResolvableContact),
   * ou null si le numéro est hors base -> l'appelant retombe sur les exemples du template (jamais de throw).
   * `bsuid` est inclus : les sources de variable système `bsuid`/`wa_id` doivent se résoudre AUSSI sur la voie workflow.
   */
  async getResolvableByPhone(
    tenantId: string,
    waId: string,
  ): Promise<{ phone_e164: string | null; bsuid: string | null; profile_name: string | null; fields: Record<string, unknown> } | null> {
    const res = await this.pool.query<{ phone_e164: string | null; bsuid: string | null; profile_name: string | null; fields: Record<string, unknown> | null }>(
      `select phone_e164, bsuid, profile_name, fields from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r ? { phone_e164: r.phone_e164, bsuid: r.bsuid, profile_name: r.profile_name, fields: r.fields ?? {} } : null;
  }

  /**
   * État d'un contact par wa_id pour ÉVALUER une condition de scénario (node « Si ») : fields + tags + opt-in +
   * attributs name/phone/bsuid. Matching `MATCH_BY_WAID_SQL`. `null` si hors base -> l'appelant retombe sur la branche
   * 'false' (déterministe). Étend `getResolvableByPhone` (qui n'a ni tags ni opt-in), forme alignée sur `EvalContext`.
   */
  async getContactStateByWaId(
    tenantId: string,
    waId: string,
  ): Promise<{ fields: Record<string, unknown>; tags: string[]; optIn: string; name: string | null; phone: string | null; bsuid: string | null } | null> {
    const res = await this.pool.query<{ phone_e164: string | null; bsuid: string | null; profile_name: string | null; opt_in_status: string; fields: Record<string, unknown> | null; tags: string[] | null }>(
      `select phone_e164, bsuid, profile_name, opt_in_status, fields, tags from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r
      ? { fields: r.fields ?? {}, tags: r.tags ?? [], optIn: r.opt_in_status, name: r.profile_name, phone: r.phone_e164, bsuid: r.bsuid }
      : null;
  }

  /**
   * Id du contact par wa_id : matching `MATCH_BY_WAID_SQL`, restreint aux contacts NON supprimés. Sert à
   * RELIER un run de scénario déclenché par une automation à la fiche du contact : sans lui, le run partirait
   * avec `contactId: null` alors que la fiche existe (l'upsert d'inbound vient de tourner). null = aucune
   * fiche (rien à relier, pas une erreur).
   */
  async findIdByWaId(tenantId: string, waId: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `select id from contacts where tenant_id = $1 and deleted_at is null
         ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * `wa_id` d'un contact (numéro en chiffres nus, sinon BSUID). Réciproque de `findIdByWaId`, utilisée quand un
   * événement part d'une fiche (édition mini-CRM) alors que le moteur de scénario, lui, raisonne par wa_id.
   * null = contact absent du tenant, ou sans identité joignable (ni téléphone ni BSUID).
   */
  async waIdOfContact(tenantId: string, contactId: string): Promise<string | null> {
    const res = await this.pool.query<{ phone_e164: string | null; bsuid: string | null }>(
      `select phone_e164, bsuid from contacts where id = $1 and tenant_id = $2 and deleted_at is null`,
      [contactId, tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    // Règle de routage WhatsApp = `waIdOf` (crm/identity), DÉFINITION DE RÉFÉRENCE. Ne pas la réécrire ici :
    // deux copies divergeraient le jour où le format de stockage évolue, et l'événement partirait avec un
    // wa_id que le reste du moteur ne résout plus.
    return waIdOf(r.phone_e164, r.bsuid);
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
    edits: {
      fields: Record<string, string>; removeFields?: string[]; addTags: string[]; removeTags: string[];
      profileName?: string | null;
      /** Consentement posé À LA MAIN depuis la fiche. Voir le commentaire de l'écriture, plus bas. */
      optInStatus?: 'opted_in' | 'opted_out';
    },
  ): Promise<{ contact: ContactRow; addedTags: string[] } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // On lit les tags AVANT dans le verrou déjà pris : ça ne coûte rien de plus et c'est la seule façon de
      // savoir lesquels sont RÉELLEMENT nouveaux. L'ajout est une union, donc reposer un tag déjà présent ne
      // change rien en base : l'annoncer comme « tag ajouté » relancerait un scénario pour un non-événement.
      const exists = await client.query<{ tags: string[] | null }>('select tags from contacts where id = $1 and tenant_id = $2 for update', [contactId, tenantId]);
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
      if (edits.optInStatus !== undefined) {
        // Écriture DIRECTE du statut, y compris à la baisse : c'est une décision d'opérateur devant la fiche,
        // pas une donnée importée. L'upsert, lui, ne fait jamais régresser un statut. La source dit d'où vient
        // la décision, pour qu'un `opted_out` posé ici ne se confonde pas plus tard avec un statut jamais
        // renseigné. Aucun retour à « inconnu » : ce statut signifie « rien n'a jamais été enregistré », et
        // l'écrire après coup falsifierait le registre plutôt que de le corriger.
        await client.query(
          `update contacts set opt_in_status = $3, opt_in_source = 'crm', updated_at = now() where id = $1 and tenant_id = $2`,
          [contactId, tenantId, edits.optInStatus],
        );
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
      if (!r) return null;
      const avant = new Set(exists.rows[0]?.tags ?? []);
      // Le retrait s'applique APRÈS l'ajout dans cette transaction : un tag présent dans addTags ET removeTags
      // n'est pas sur le contact à la fin. L'annoncer « ajouté » enverrait un message pour un tag inexistant.
      // On se fie donc à l'état FINAL réellement écrit, pas seulement au snapshot d'avant.
      const apres = new Set(PgContactStore.rowToContact(r).tags);
      return {
        contact: PgContactStore.rowToContact(r),
        addedTags: edits.addTags.filter((t) => !avant.has(t) && apres.has(t)),
      };
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

  /**
   * Liste paginée des contacts d'un tenant (les plus récents d'abord), éventuellement filtrée sur UN tag.
   * Délègue à `query` : elle réécrivait le même WHERE (tenant, non supprimé, tag) et remappait les lignes à la
   * main, donc deux définitions de « lister des contacts » à garder alignées pour rien.
   */
  async list(tenantId: string, limit = 100, offset = 0, tag?: string): Promise<ContactRow[]> {
    const t = tag?.trim();
    return this.query(tenantId, t ? { tags: [t] } : {}, limit, offset);
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
    const optIn = edits.setOptIn === 'opted_in' || edits.setOptIn === 'opted_out' ? edits.setOptIn : undefined;
    if (addTags.length === 0 && removeTags.length === 0 && !hasSet && optIn === undefined) return 0;

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
    if (optIn !== undefined) {
      // Écriture DIRECTE du statut, y compris à la baisse : c'est une décision d'opérateur, pas une donnée
      // importée. La source dit d'où vient la décision, pour qu'un `opted_out` ne soit pas confondu plus tard
      // avec un statut jamais renseigné.
      sets.push(`opt_in_status = ${add(optIn)}`, `opt_in_source = ${add('crm')}`);
    }
    sets.push('updated_at = now()');
    const res = await this.pool.query(`update contacts set ${sets.join(', ')} where ${sel.where}`, params);
    return res.rowCount ?? 0;
  }

  /**
   * PURGE : efface réellement les données d'une personne, et garde les compteurs.
   *
   * Deux traitements distincts, et c'est tout le sujet.
   *
   * EFFACÉ, parce que c'est du contenu et qu'il identifie : le fil de conversation, tous ses messages, et son
   * ANALYSE qualitative (la table `conversation_analysis` porte un `topic` et une `justification` en texte libre
   * produits par un modèle à partir de la conversation, donc potentiellement tout ce que la personne a raconté).
   * Plus les traces techniques qui portent le numéro : parcours de scénario, déclenchements d'automation, cache
   * de joignabilité RCS.
   *
   * ANONYMISÉ, pour que le QUANTITATIF survive : la ligne de contact et ses lignes de campagne restent, mais
   * leurs colonnes identifiantes sont remplacées. Les totaux d'envoi, de livraison et d'échec restent donc
   * justes, et plus personne n'est reconnaissable.
   *
   * ⚠️ L'identifiant de remplacement est ALÉATOIRE, pas une empreinte du numéro. Une empreinte serait
   * réversible en pratique : un numéro français tient dans un espace de quelques milliards, qu'un attaquant
   * parcourt en quelques minutes pour retrouver qui se cache derrière un hachage. Le prix de l'aléatoire est
   * qu'on ne reconnaît plus la personne si elle revient, ce qui est précisément ce que « plus aucune trace » veut
   * dire.
   *
   * TRANSACTIONNEL : une purge à moitié faite laisserait des messages orphelins d'un contact déjà anonymisé,
   * c'est-à-dire le contenu sans le moyen de le retrouver pour finir le travail.
   */
  /** Résout une cible de masse (identifiants explicites OU filtres) en liste d'identifiants. */
  async contactIdsForTarget(tenantId: string, target: BulkTarget): Promise<string[]> {
    if ('ids' in target) {
      if (target.ids.length === 0) return [];
      const res = await this.pool.query<{ id: string }>(
        `select id from contacts where tenant_id = $1 and id = any($2::uuid[])`,
        [tenantId, target.ids],
      );
      return res.rows.map((r) => r.id);
    }
    const ids = await this.idsForFilters(tenantId, target.filters);
    const exclus = new Set(target.excludeIds ?? []);
    return ids.filter((id) => !exclus.has(id));
  }

  async purgeMany(tenantId: string, ids: readonly string[]): Promise<{ purges: number; conversations: number; messages: number; analyses: number }> {
    if (ids.length === 0) return { purges: 0, conversations: 0, messages: 0, analyses: 0 };
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // Numéros des contacts visés, lus AVANT l'anonymisation qui les remplace. Servent au cache RCS, indexé
      // en E.164 (`+33…`) et NON en wa_id : lui passer des chiffres nus ne supprimait rien.
      const cibles = await client.query<{ phone_e164: string | null }>(
        `select phone_e164 from contacts where tenant_id = $1 and id = any($2::uuid[])`,
        [tenantId, ids],
      );
      const e164 = cibles.rows.map((r) => r.phone_e164).filter((p): p is string => p !== null && !p.startsWith('anon:'));

      // Les fils visés, par la RÈGLE PARTAGÉE de correspondance contact <-> wa_id. Une simple égalité
      // `conversations.wa_id = contacts.phone_e164` ne peut jamais être vraie : le fil porte `33612345678`,
      // la fiche `+33612345678`. La purge anonymisait donc le contact en laissant la conversation intacte,
      // ce qui est l'inverse exact de ce qu'elle promet. Vu en production le 2026-08-18.
      const fils = await client.query<{ id: string; wa_id: string }>(
        `select v.id, v.wa_id from conversations v
          where v.tenant_id = $1 and exists (
            select 1 from contacts c
             where c.tenant_id = $1 and c.id = any($2::uuid[]) and ${matchWaIdPredicat('c.', 'v.wa_id')}
          )`,
        [tenantId, ids],
      );
      const convIds = fils.rows.map((r) => r.id);
      const waIds = fils.rows.map((r) => r.wa_id);

      let messages = 0;
      let analyses = 0;
      if (convIds.length > 0) {
        analyses = (await client.query(`delete from conversation_analysis where conversation_id = any($1::uuid[])`, [convIds])).rowCount ?? 0;
        messages = (await client.query(`delete from conversation_messages where conversation_id = any($1::uuid[])`, [convIds])).rowCount ?? 0;
        await client.query(`delete from conversations where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, convIds]);
      }
      if (waIds.length > 0) {
        // `workflow_runs` et `automation_fires` portent bien un wa_id (chiffres nus), eux.
        await client.query(`delete from workflow_runs where tenant_id = $1 and wa_id = any($2::text[])`, [tenantId, waIds]);
        // `automation_fires` a pour clé (automation_id, wa_id) et NE PORTE PAS de tenant_id : le cloisonnement
        // passe par l'automation. La version precedente filtrait sur une colonne inexistante, ce qui faisait
        // echouer et ROULER EN ARRIERE toute la purge des qu'un contact avait un fil. Invisible jusqu'ici :
        // aucun fil n'etait jamais trouve, donc cette branche n'etait jamais atteinte.
        await client.query(
          `delete from automation_fires f using automations a
            where a.id = f.automation_id and a.tenant_id = $1 and f.wa_id = any($2::text[])`,
          [tenantId, waIds],
        );
      }
      // Cache RCS : clé (agent_id, phone_e164), donc E.164. Effacé même si le contact n'a AUCUN fil, sinon un
      // contact purgé sans conversation laisserait son numéro dans une table de joignabilité.
      if (e164.length > 0) {
        await client.query(`delete from rcs_capabilities_cache where phone_e164 = any($1::text[])`, [e164]);
      }

      // Quantitatif préservé : la ligne de campagne reste (statut, horodatage, livraison), son numéro et ses
      // variables résolues partent. `resolved_params` porte les valeurs injectées dans le template, donc
      // typiquement le prénom.
      await client.query(
        `update campaign_recipients set to_e164 = 'anonyme', resolved_params = '{}'::jsonb
          where contact_id = any($1::uuid[])`,
        [ids],
      );

      const res = await client.query(
        `update contacts
            set phone_e164 = 'anon:' || gen_random_uuid(), bsuid = null, profile_name = null,
                fields = '{}'::jsonb, deleted_at = coalesce(deleted_at, now()), anonymized_at = now(),
                updated_at = now()
          where tenant_id = $1 and id = any($2::uuid[]) and anonymized_at is null`,
        [tenantId, ids],
      );
      await client.query('commit');
      return { purges: res.rowCount ?? 0, conversations: convIds.length, messages, analyses };
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
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
