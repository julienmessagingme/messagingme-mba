import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';

/**
 * Intégration de la PURGE RGPD. ISOLÉE par tenant jetable (créé/détruit ici), jamais la prod « métier ».
 *
 * Ce fichier existe à cause d'un bug de production du 2026-08-18. La purge était couverte par des tests
 * unitaires à faux store : ils prouvaient que la route appelle `purgeMany`, jamais que `purgeMany` efface
 * quoi que ce soit. En base, elle cherchait les fils avec `conversations.wa_id = contacts.phone_e164`, une
 * égalité qui ne peut JAMAIS être vraie (le fil porte `33612345678`, la fiche `+33612345678`). Résultat :
 * le contact était anonymisé et la conversation restait, avec le vrai numéro et tous ses messages.
 *
 * La leçon tient en une phrase : une promesse d'EFFACEMENT ne se teste pas avec un faux. Il faut écrire en
 * base, purger, et relire ce qui reste.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('purge RGPD — ce qui part et ce qui reste', () => {
  let pool: Pool;
  let tenantId = '';
  let store: PgContactStore;
  const E164 = '+33600000901';
  const WA_ID = '33600000901'; // le MÊME numéro, tel que Meta le renvoie : sans « + ». Tout le bug est là.
  let contactId = '';
  let convId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-purge') returning id`)).rows[0]!.id;
    store = new PgContactStore(pool);
    contactId = (await store.upsertByPhoneReturningId({
      tenantId, phoneE164: E164, profileName: 'Personne à effacer',
      fields: { ville: 'Paris' }, optInStatus: 'opted_in', tags: ['vip'],
    })).id;
    convId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) returning id`, [tenantId, WA_ID],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, body, meta_message_id)
       values ($1, 'in', 'je raconte ma vie', $2), ($1, 'out', 'bonjour', $3)`,
      [convId, `wam-itest-${WA_ID}-1`, `wam-itest-${WA_ID}-2`],
    );
    await pool.query(`insert into rcs_capabilities_cache (agent_id, phone_e164, reachable) values ($1, $2, true)`, ['itest-agent', E164]);

    // L'ANALYSE qualitative : le pire de ce qu'on garde, un topic et une justification en texte libre produits
    // par un modèle à partir de ce que la personne a raconté.
    await pool.query(
      `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
        exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model)
       values ($1, $2, 'negatif', 'reclamation', 'sujet qui identifie la personne', false, 'humain', 2, 'rappeler', 0.9,
               'justification qui reprend ses mots', 'itest', 'itest')`,
      [convId, tenantId],
    );

    // Traces techniques portant le wa_id. Elles sont créées ICI parce que la branche qui les efface n'était
    // JAMAIS atteinte tant que la recherche de fils ne trouvait rien : c'est ce qui a laissé passer un
    // `delete from automation_fires where tenant_id = ...` sur une table qui n'a pas cette colonne.
    const workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-purge-wf') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into workflow_runs (workflow_id, tenant_id, wa_id, status) values ($1, $2, $3, 'waiting')`,
      [workflowId, tenantId, WA_ID],
    );
    const automationId = (await pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, trigger_kind, workflow_id) values ($1, 'itest-purge-auto', 'tag_added', $2) returning id`,
      [tenantId, workflowId],
    )).rows[0]!.id;
    await pool.query(`insert into automation_fires (automation_id, wa_id) values ($1, $2)`, [automationId, WA_ID]);
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.query(`delete from rcs_capabilities_cache where agent_id = $1`, ['itest-agent']);
    await pool.end();
  });

  it('🔴 la conversation et ses messages sont RÉELLEMENT effacés (wa_id sans « + » vs E.164)', async () => {
    const res = await store.purgeMany(tenantId, [contactId]);
    expect(res).toMatchObject({ purges: 1, conversations: 1, messages: 2 });

    const fils = await pool.query('select 1 from conversations where id = $1', [convId]);
    expect(fils.rowCount).toBe(0);
    const msgs = await pool.query('select 1 from conversation_messages where conversation_id = $1', [convId]);
    expect(msgs.rowCount).toBe(0);
  });

  it('🔴 l’ANALYSE qualitative part avec le fil (topic et justification en texte libre)', async () => {
    const a = await pool.query('select 1 from conversation_analysis where conversation_id = $1', [convId]);
    expect(a.rowCount).toBe(0);
  });

  it('🔴 les traces techniques portant le numéro partent aussi (parcours, déclenchements)', async () => {
    // `automation_fires` n'a PAS de tenant_id : son cloisonnement passe par l'automation. Un filtre sur une
    // colonne absente ne renvoie pas « rien », il fait ÉCHOUER la transaction et annule toute la purge.
    const runs = await pool.query('select 1 from workflow_runs where tenant_id = $1 and wa_id = $2', [tenantId, WA_ID]);
    expect(runs.rowCount).toBe(0);
    const fires = await pool.query(
      `select 1 from automation_fires f join automations a on a.id = f.automation_id where a.tenant_id = $1 and f.wa_id = $2`,
      [tenantId, WA_ID],
    );
    expect(fires.rowCount).toBe(0);
  });

  it('🔴 le cache de joignabilité RCS est purgé (indexé en E.164, pas en wa_id)', async () => {
    const cache = await pool.query(`select 1 from rcs_capabilities_cache where phone_e164 = $1`, [E164]);
    expect(cache.rowCount).toBe(0);
  });

  it('🔴 plus AUCUNE trace du numéro ni du nom sur la fiche, mais la ligne reste (quantitatif)', async () => {
    const row = (await pool.query<{ phone_e164: string; profile_name: string | null; fields: unknown; anonymized_at: Date | null }>(
      'select phone_e164, profile_name, fields, anonymized_at from contacts where id = $1', [contactId],
    )).rows[0]!;
    expect(row.phone_e164.startsWith('anon:')).toBe(true);
    expect(row.phone_e164).not.toContain('600000901');
    expect(row.profile_name).toBeNull();
    expect(row.fields).toEqual({});
    expect(row.anonymized_at).not.toBeNull();
  });

  it('purger deux fois ne compte pas deux fois (anonymized_at fait garde)', async () => {
    expect((await store.purgeMany(tenantId, [contactId])).purges).toBe(0);
  });
});
