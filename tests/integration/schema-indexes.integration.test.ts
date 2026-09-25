import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { matchWaIdPredicat } from '../../src/crm/contact-store.pg';

const url = process.env.DATABASE_URL ?? '';

// Vérifie que la migration 0042 a bien créé les 6 index de montée en charge. C'est un test de
// SCHÉMA (pas de données) : il lit pg_indexes sur la base migrée. Si un index disparaît d'une
// migration ou n'est jamais appliqué, ce test le voit avant la production.
describe.skipIf(!url)('index de montée en charge (migration 0042)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('les 6 index nommés existent sur les bonnes tables', async () => {
    const attendus: Array<{ table: string; index: string }> = [
      { table: 'contacts', index: 'contacts_tenant_created_idx' },
      { table: 'conversation_messages', index: 'conversation_messages_created_idx' },
      { table: 'phone_numbers', index: 'phone_numbers_tenant_created_idx' },
      { table: 'waba', index: 'waba_tenant_created_idx' },
      { table: 'conversation_messages', index: 'conversation_messages_sender_idx' },
      { table: 'workflow_runs', index: 'workflow_runs_workflow_idx' },
    ];
    const res = await pool.query<{ tablename: string; indexname: string }>(
      `select tablename, indexname from pg_indexes
       where schemaname = 'public' and indexname = any($1::text[])`,
      [attendus.map((a) => a.index)],
    );
    const trouves = new Set(res.rows.map((r) => `${r.tablename}.${r.indexname}`));
    for (const a of attendus) {
      expect(trouves.has(`${a.table}.${a.index}`), `${a.index} sur ${a.table} manquant`).toBe(true);
    }
  });
});

/**
 * Les index des chemins chauds (migration 0096, programme II lot 1).
 *
 * 🔴 CE QUE CE BLOC VÉRIFIE ET QU'AUCUN AUTRE NE PEUT VÉRIFIER : qu'ils sont réellement UTILISABLES. Un index
 * d'expression n'est choisi que si la requête écrit EXACTEMENT la même expression que l'index ; sinon il est
 * payé à chaque écriture et jamais lu, en silence. Le test construit donc son prédicat avec le fragment
 * partagé du code de production (`matchWaIdPredicat`), pas avec une copie : le jour où l'un des deux dérive,
 * c'est ici que ça se voit.
 *
 * Les tables de CI sont vides, donc le planificateur préfèrerait un seq scan : on le lui interdit le temps
 * d'un `explain` (`set local`, dans une transaction annulée), ce qui montre ce qu'il ferait s'il avait le
 * choix. C'est la question posée ici, pas la vitesse.
 */
describe.skipIf(!url)('index des chemins chauds (migration 0096)', () => {
  let pool: Pool;
  let tenantId = '';

  /**
   * ⚠️ CE BLOC ÉCRIT DES DONNÉES, contrairement au reste de ce fichier. Il le faut : sur une table VIDE le
   * planificateur n'a aucune raison de préférer un index précis (tous les chemins coûtent zéro), et il
   * choisissait effectivement l'index de tenant en appliquant le reste en Filter. Constaté en CI le
   * 2026-09-01 : les deux assertions de plan échouaient pour cette seule raison, index parfaitement bons.
   *
   * 2 000 fiches dans un espace DÉDIÉ, `analyze` pour que les statistiques existent, et l'espace est supprimé
   * en fin de bloc (la cascade emporte les fiches). Comme tout ce dossier, ça ne tourne qu'en CI, sur un
   * Postgres jetable : le `DATABASE_URL` local pointe la PRODUCTION.
   */
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-index-chemins-chauds') returning id`,
    )).rows[0]!.id;
    await pool.query(
      `insert into contacts (tenant_id, phone_e164, opt_in_status)
       select $1, '+336' || lpad(i::text, 8, '0'), 'opted_in' from generate_series(1, 2000) i`,
      [tenantId],
    );
    await pool.query('analyze contacts');
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const INDEX_0096 = [
    'contacts_tenant_waid_digits_idx',
    'contacts_tenant_phone_prefix_idx',
    'campaign_recipients_stale_idx',
  ];

  it('les trois index existent et sont VALIDES', async () => {
    // `indisvalid` : un `CREATE INDEX CONCURRENTLY` interrompu laisse un index INVALIDE, que Postgres
    // n'utilise jamais et que le `if not exists` de la migration considère pourtant comme présent. Sans ce
    // contrôle, on croirait l'index posé alors qu'il est mort.
    const res = await pool.query<{ nom: string; valide: boolean }>(
      `select i.indexrelid::regclass::text as nom, i.indisvalid as valide
         from pg_index i where i.indexrelid::regclass::text = any($1::text[])`,
      [INDEX_0096],
    );
    const parNom = new Map(res.rows.map((r) => [r.nom, r.valide]));
    for (const nom of INDEX_0096) {
      expect(parNom.has(nom), `${nom} manquant`).toBe(true);
      expect(parNom.get(nom), `${nom} présent mais INVALIDE (CONCURRENTLY interrompu)`).toBe(true);
    }
  });

  it('🔴 le planificateur CHOISIT l’index d’expression pour la résolution wa_id -> contact', async () => {
    const plan = await planDe(
      pool,
      `select id from contacts where tenant_id = $1 and deleted_at is null and ${matchWaIdPredicat('', '$2')}`,
      [tenantId, '33600000042'],
    );
    expect(plan).toContain('contacts_tenant_waid_digits_idx');
  });

  it('🔴 le planificateur CHOISIT l’index text_pattern_ops pour le préfixe téléphone', async () => {
    // Le `like` ancré ne peut PAS se servir d'un btree ordinaire hors collation C : c'est tout l'objet de
    // l'opclass. Si quelqu'un recrée cet index sans `text_pattern_ops`, ce test le dit.
    const plan = await planDe(
      pool,
      `select id from contacts where tenant_id = $1 and deleted_at is null and phone_e164 like $2`,
      [tenantId, '+33600000042%'],
    );
    expect(plan).toContain('contacts_tenant_phone_prefix_idx');
  });

  it('le planificateur CHOISIT l’index partiel des destinataires bloqués', async () => {
    const plan = await planDe(
      pool,
      `select id from campaign_recipients where status = 'sending' and claimed_at < now() - interval '10 minutes' limit 100`,
      [],
    );
    expect(plan).toContain('campaign_recipients_stale_idx');
  });
});

/** Plan d'une requête, seq scan INTERDIT le temps d'une transaction annulée (`set local`, jamais global :
 *  la connexion retourne au pool telle qu'elle en est sortie). */
async function planDe(pool: Pool, sql: string, params: unknown[]): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local enable_seqscan = off');
    const res = await client.query<Record<string, string>>(`explain (format text) ${sql}`, params);
    return res.rows.map((r) => Object.values(r)[0]!).join('\n');
  } finally {
    await client.query('rollback');
    client.release();
  }
}
