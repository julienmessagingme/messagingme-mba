/**
 * LE BANC DES ACCUSÉS AVEC DE VRAIS MESSAGES (point P1 de l'audit du 2026-10-17 ; `docs/ARCHITECTURE-CIBLE.md` § 11).
 *
 * 🔴 POURQUOI UN MODULE À PART. Le banc du 14 octobre envoyait des accusés pour des identifiants inventés
 * (`wamid.banc14.<aléatoire>`) : aucun ne désignait un message en base, `updateDeliveryByMessageId` ne touchait rien, et
 * ses 27,8 accusés par seconde ne mesuraient pas le travail d'un vrai accusé (destinataire de campagne, journal des
 * envois, statut du message, tarif). Ici, la fabrique d'accusés et le semis vivent hors du script de banc, pour qu'un
 * test les éprouve contre les vraies fonctions de lecture du code (`tests/banc-accuses.test.ts`) et un test
 * d'intégration contre la vraie écriture (`tests/integration/banc-accuses.integration.test.ts`). Sans eux, un accusé
 * que le code ne reconnaît plus referait mesurer du vide, en silence.
 *
 * Le module ne lance rien : `scripts/banc-api.mts` l'appelle (épreuves `accuses` et `panne`), sous la garde des bancs.
 *
 * ⚠️ CE QUE LE BANC NE JOUE PAS, et qui pèserait en plus en production : les signaux (sans intégration ni adresse
 * d'événements, `quelquUnEcoute` rend faux et rien ne s'enfile), le chemin `failed` (journal des échecs et signal
 * d'échec), et les lots de Meta (un accusé par webhook ici, plusieurs parfois chez Meta : le banc est pessimiste sur le
 * coût pg-boss d'un job, juste sur le travail d'un accusé). `read` part sans tarif : Meta en joint parfois un, à
 * confirmer sur un vrai webhook.
 */
import type { Pool } from 'pg';

/** Le préfixe de tout ce que ce banc sème : `semer` de `banc-api.mts` efface aussi `banc14-%`. */
export const PREFIXE = 'banc14-acc';

const deux = (k: number): string => String(k).padStart(2, '0');

/** L'espace d'un numéro du banc. */
export const nomEspace = (k: number): string => `${PREFIXE}-${deux(k)}`;
/** L'identifiant Meta du numéro `k` (`phone_number_id`). */
export const numeroAccuses = (k: number): string => `${PREFIXE}-pn-${deux(k)}`;
/** Le début du `wa_id` des contacts du numéro `k` : `3362` puis `k` sur deux chiffres. */
export const racineWaId = (k: number): string => `3362${deux(k)}`;
/** Le `wa_id` du `j`-ième contact du numéro `k` (cinq chiffres pour `j`). */
export const waIdDe = (k: number, j: number): string => `${racineWaId(k)}${String(j).padStart(5, '0')}`;
/** La racine des identifiants de messages du numéro `k`. */
export const racineWamid = (k: number): string => `wamid.${PREFIXE}.${k}`;
/** L'identifiant Meta du `j`-ième message sortant du numéro `k`, celui que le semis pose en base. */
export const wamidDe = (k: number, j: number): string => `${racineWamid(k)}.${j}`;

export type StatutBanc = 'sent' | 'delivered' | 'read';

/**
 * Le tarif que Meta joint à `sent` et `delivered` d'un modèle marketing : sa présence fait passer l'accusé par
 * `extraireTarif` puis l'enregistrement du tarif, comme en production.
 */
const TARIF = { billable: true, pricing_model: 'PMP', category: 'marketing', type: 'regular' } as const;

/**
 * Le corps d'un webhook de Meta qui porte UN accusé, comme Meta les envoie d'ordinaire : un lot d'accusés seuls, que
 * la réception range sur `webhook-status`.
 */
export function corpsAccuse(k: number, j: number, statut: StatutBanc, instantS: number): string {
  const accuse = {
    id: wamidDe(k, j),
    status: statut,
    timestamp: String(instantS),
    recipient_id: waIdDe(k, j),
    ...(statut === 'read' ? {} : { pricing: TARIF }),
  };
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: `${PREFIXE}-waba-${deux(k)}`, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '33500000000', phone_number_id: numeroAccuses(k) },
    statuses: [accuse],
  } }] }] });
}

/**
 * Sème `numeros` espaces Entreprise (rangs `premier` à `premier + numeros - 1`), chacun avec son numéro, `messages`
 * contacts, leur conversation, un message SORTANT par contact, une campagne terminée dont chaque destinataire porte le
 * même identifiant Meta, et son envoi au journal des tentatives. Un accusé du banc désigne donc un message qui existe,
 * et `updateDeliveryByMessageId` le trouve par ses trois index. Rend le nombre de messages semés.
 */
export async function semerAccuses(pool: Pool, premier: number, numeros: number, messages: number): Promise<number> {
  // Un semis précédent s'efface d'abord, et pas seulement par la cascade des espaces :
  // - ses événements bruts restent (`webhook_events` n'est pas rattachée par clé étrangère) et rendraient les nouveaux
  //   accusés idempotents, donc moins chers que des vrais ;
  // - le journal des envois n'a pas d'index sur ses clés vers les contacts et les destinataires : la cascade le
  //   balaierait une fois par contact supprimé.
  await pool.query(`delete from webhook_events where phone_number_id like $1`, [`${PREFIXE}-pn-%`]);
  await pool.query(
    `delete from campaign_envois where campaign_id in (
       select c.id from campaigns c join tenants t on t.id = c.tenant_id where t.name like $1)`,
    [`${PREFIXE}-%`],
  );
  await pool.query(`delete from tenants where name like $1`, [`${PREFIXE}-%`]);
  for (let k = premier; k < premier + numeros; k += 1) {
    const tenantId = (await pool.query<{ id: string }>(
      'insert into tenants (name, offre_entreprise) values ($1, true) returning id', [nomEspace(k)],
    )).rows[0]!.id;
    await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'banc14-acc')`, [`${PREFIXE}-waba-${deux(k)}`, tenantId]);
    await pool.query(
      `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status) values ($1, $2, $3, '+33500000000', 'CONNECTED')`,
      [numeroAccuses(k), tenantId, `${PREFIXE}-waba-${deux(k)}`],
    );
    const campagneId = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, status) values ($1, $2, 'marketing', 'completed') returning id`,
      [tenantId, nomEspace(k)],
    )).rows[0]!.id;
    // Une instruction par numéro : chaque CTE qui écrit s'exécute, et `j` se relit sur les cinq derniers chiffres.
    await pool.query(
      `with c as (
         insert into contacts (tenant_id, phone_e164, profile_name, opt_in_status)
         select $1::uuid, '+' || $2::text || lpad(j::text, 5, '0'), 'Banc ' || j, 'opted_in' from generate_series(0, $3::int - 1) j
         returning id, phone_e164
       ), v as (
         insert into conversations (tenant_id, wa_id, contact_id)
         select $1::uuid, substr(c.phone_e164, 2), c.id from c
         returning id, wa_id
       ), m as (
         insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, origin)
         select v.id, 'out', 'text', 'banc', $4::text || '.' || substr(v.wa_id, length($2::text) + 1)::int, 'api' from v
         returning 1
       ), r as (
         insert into campaign_recipients (campaign_id, contact_id, to_e164, status, message_id)
         select $5::uuid, c.id, c.phone_e164, 'sent', $4::text || '.' || substr(c.phone_e164, length($2::text) + 2)::int from c
         returning id, contact_id, message_id
       )
       insert into campaign_envois (campaign_id, recipient_id, contact_id, rang, canal, statut, message_id)
       select $5::uuid, r.id, r.contact_id, 1, 'whatsapp', 'sent', r.message_id from r`,
      [tenantId, racineWaId(k), messages, racineWamid(k), campagneId],
    );
  }
  return numeros * messages;
}

/** Le retard d'une file sur une fenêtre d'enfilement, en secondes, lu dans pg-boss comme le fait `/ops`. */
export interface RetardFile {
  /** Jobs enfilés dans la fenêtre et terminés. */
  termines: number;
  /** Jobs enfilés dans la fenêtre et pas encore terminés (en attente, en cours ou en échec). */
  restants: number;
  /** Jobs terminés après au moins une reprise : leur `start_after` a été repoussé, leur retard est sous-estimé. */
  reprises: number;
  p50: number;
  p95: number;
  max: number;
}

/**
 * Le retard de bout en bout (`completed_on - start_after`) des jobs de `file` enfilés entre `de` et `a`. Les jobs pas
 * encore terminés ne comptent pas dans les quantiles : l'appelant attend que la file se vide avant de lire, et les
 * rapporte à part.
 */
export async function retardFile(pool: Pool, schema: string, file: string, de: Date, a: Date): Promise<RetardFile> {
  const r = await pool.query<{ termines: string; restants: string; reprises: string; p50: string | null; p95: string | null; max: string | null }>(
    `select count(*) filter (where state = 'completed')::text as termines,
            count(*) filter (where state <> 'completed')::text as restants,
            count(*) filter (where state = 'completed' and retry_count > 0)::text as reprises,
            percentile_cont(0.5) within group (order by extract(epoch from (completed_on - start_after))) filter (where state = 'completed') as p50,
            percentile_cont(0.95) within group (order by extract(epoch from (completed_on - start_after))) filter (where state = 'completed') as p95,
            max(extract(epoch from (completed_on - start_after))) filter (where state = 'completed') as max
       from ${schema}.job
      where name = $1 and start_after >= $2 and start_after < $3`,
    [file, de, a],
  );
  const l = r.rows[0]!;
  const s = (v: string | null): number => (v === null ? 0 : Math.round(Number(v) * 10) / 10);
  return { termines: Number(l.termines), restants: Number(l.restants), reprises: Number(l.reprises), p50: s(l.p50), p95: s(l.p95), max: s(l.max) };
}

/** Les jobs de `file` qui attendent encore d'être pris (ni terminés, ni en cours). */
export async function enAttente(pool: Pool, schema: string, file: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `select count(*)::text as n from ${schema}.job where name = $1 and state in ('created', 'retry')`, [file],
  );
  return Number(r.rows[0]!.n);
}

/** Ce que la base a écrit pendant une épreuve : le volume de WAL, une mesure grossière mais honnête de son coût. */
export async function positionWal(pool: Pool): Promise<string | null> {
  try {
    return (await pool.query<{ lsn: string }>('select pg_current_wal_lsn()::text as lsn')).rows[0]!.lsn;
  } catch {
    return null; // une base managée peut refuser la fonction : la mesure manque, le banc continue
  }
}

export async function walEcritDepuis(pool: Pool, depuis: string | null): Promise<number | null> {
  if (depuis === null) return null;
  try {
    const r = await pool.query<{ octets: string }>('select pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::text as octets', [depuis]);
    return Math.round(Number(r.rows[0]!.octets) / 1_048_576);
  } catch {
    return null;
  }
}

/**
 * Le verdict d'un palier : tenu si le p95 du retard reste sous l'objectif sur tout le palier ET sur son dernier quart,
 * qu'aucun accusé ne reste en souffrance après l'attente du vidage, et que la réception n'a rien refusé. Pur.
 *
 * 🔴 LE DERNIER QUART, parce qu'une file qui déborde lentement passe sur la fenêtre entière : avec une arrivée qui
 * dépasse la capacité de 15 %, le retard croît comme 0,15 × t et son p95 sur 8 minutes reste sous 2 minutes, alors
 * qu'il grossit sans fin au-delà. Le dernier quart porte les pires retards d'une file qui ne suit pas.
 */
export function palierTenu(r: RetardFile, fin: RetardFile, objectifS: number, refusReception: number): boolean {
  return r.termines > 0 && r.restants === 0 && r.p95 <= objectifS && fin.p95 <= objectifS && refusReception === 0;
}

/** Les balayages complets de `conversations` (schéma public) : le compteur de `pg_stat_user_tables`. */
export async function balayagesConversations(pool: Pool): Promise<{ balayages: number; lignes: number } | null> {
  try {
    const r = await pool.query<{ s: string; l: string }>(
      `select seq_scan::text as s, seq_tup_read::text as l from pg_stat_user_tables where schemaname = 'public' and relname = 'conversations'`,
    );
    return r.rows[0] ? { balayages: Number(r.rows[0].s), lignes: Number(r.rows[0].l) } : null;
  } catch {
    return null;
  }
}

/**
 * La durée de l'instruction de `consommerReleaseMba` (`src/inbox/store.pg.ts`) pour un accusé, sans puis avec un
 * index partiel sur `release_mba_apres_message`, mesurée par `EXPLAIN ANALYZE` dans UNE transaction annulée : ni la
 * mise à jour ni l'index ne restent. À ne jouer que sur la base du banc (la garde des bancs l'a vérifiée avant).
 */
export async function mesurerRemiseMba(pool: Pool, wamid: string): Promise<{ sansIndexMs: number; avecIndexMs: number } | null> {
  const client = await pool.connect();
  const instruction = `explain (analyze, format json) update conversations c set release_mba_apres_message = null
     where c.release_mba_apres_message = $1 returning c.tenant_id, c.wa_id`;
  const duree = (r: { rows: Array<Record<string, unknown>> }): number => {
    const plan = (r.rows[0]!['QUERY PLAN'] as Array<{ 'Execution Time': number }>)[0]!;
    return Math.round(plan['Execution Time'] * 1000) / 1000;
  };
  // La médiane de cinq exécutions : une seule dépend trop de ce que le cache a gardé.
  const mediane = async (): Promise<number> => {
    const xs: number[] = [];
    for (let i = 0; i < 5; i += 1) xs.push(duree(await client.query(instruction, [wamid])));
    return xs.sort((a, b) => a - b)[2]!;
  };
  try {
    await client.query('begin');
    const sans = await mediane();
    await client.query('create index banc_release_mba_idx on conversations (release_mba_apres_message) where release_mba_apres_message is not null');
    await client.query('analyze conversations');
    const avec = await mediane();
    return { sansIndexMs: sans, avecIndexMs: avec };
  } catch {
    return null;
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}
