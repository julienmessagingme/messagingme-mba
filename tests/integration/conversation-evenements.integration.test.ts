import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { CAUSE_AMORCAGE, CAUSE_MESSAGE_DU_CONTACT } from '../../src/inbox/evenements';

/**
 * LE JOURNAL DES ÉVÉNEMENTS D'UNE CONVERSATION (migration 0192) et le panneau Détail qui le lit.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QU'AUCUN TEST UNITAIRE NE VOIT : les deux règles d'écriture exécutées par
 * Postgres. L'événement est écrit DANS la requête du changement (une CTE), et SEULEMENT si la valeur a vraiment
 * changé : la comparaison de l'avant et de l'après se fait en base (sous-select verrouillé, ou instantané de la
 * requête pour les upserts), donc seule une vraie base la prouve. Et l'upsert d'un message entrant est le chemin
 * le plus chaud du dépôt : un message sur une conversation ni archivée ni traitée ne doit RIEN écrire.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const WA = '33600000192';

interface Ligne { type: string; acteur_id: string | null; cible_id: string | null; cause: string | null }

describe.skipIf(!url)('le journal des événements d’une conversation', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let autreTenantId = '';
  let admin = '';
  let marie = '';
  let jean = '';

  const membre = async (tenant: string, email: string, nom: string, role: string) => (await pool.query<{ id: string }>(
    `insert into users (tenant_id, email, name, password_hash, role) values ($1, $2, $3, 'x', $4) returning id`,
    [tenant, email, nom, role],
  )).rows[0]!.id;

  const entrant = (messageId: string, type = 'text', waId = WA) => store.recordInbound(tenantId, {
    phoneNumberId: 'pn-itest', waId, messageId, type, body: type === 'reaction' ? '👍' : 'bonjour',
    buttonPayload: type === 'reaction' ? 'wamid.notre-message' : null, profileName: null, field: 'messages',
  });

  const idDe = async (waId = WA): Promise<string> => (await pool.query<{ id: string }>(
    'select id from conversations where tenant_id = $1 and wa_id = $2', [tenantId, waId],
  )).rows[0]!.id;

  const journal = async (conversationId: string): Promise<Ligne[]> => (await pool.query<Ligne>(
    `select type, acteur_id, cible_id, cause from conversation_evenements
      where conversation_id = $1 order by at, id`, [conversationId],
  )).rows;

  const types = async (conversationId: string): Promise<string[]> => (await journal(conversationId)).map((l) => l.type);

  const OPERATEUR = () => ({ collaborateur: admin });
  const AUTO = { cause: 'automatique : test' };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-evenements') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-evenements-autre') returning id`)).rows[0]!.id;
    admin = await membre(tenantId, 'admin@evenements.itest', 'Alice Admin', 'admin');
    marie = await membre(tenantId, 'marie@evenements.itest', 'Marie', 'agent');
    jean = await membre(tenantId, 'jean@evenements.itest', 'Jean', 'agent');
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from contacts where tenant_id = $1', [tenantId]);
  });

  describe('🔴 un message entrant : le chemin le plus chaud', () => {
    it('sur une conversation ni archivée ni traitée, il n’écrit AUCUN événement', async () => {
      await entrant('wamid.ev-1');
      await entrant('wamid.ev-2');
      expect(await journal(await idDe())).toEqual([]);
    });

    it('🔴 il ROUVRE une conversation archivée, et le dit, une fois', async () => {
      await entrant('wamid.ev-3');
      const id = await idDe();
      await store.archiverConversation(tenantId, id, true, OPERATEUR());
      await entrant('wamid.ev-4');
      await entrant('wamid.ev-5'); // déjà rouverte : rien de plus
      expect(await journal(id)).toEqual([
        { type: 'archivee', acteur_id: admin, cible_id: null, cause: null },
        { type: 'rouverte', acteur_id: null, cible_id: null, cause: CAUSE_MESSAGE_DU_CONTACT },
      ]);
    });

    it('🔴 il rouvre une conversation traitée', async () => {
      await entrant('wamid.ev-6');
      const id = await idDe();
      await store.marquerTraitee(tenantId, id, true, OPERATEUR());
      await entrant('wamid.ev-7');
      expect(await types(id)).toEqual(['traitee', 'rouverte']);
    });

    it('🔴 une RÉACTION sur une conversation seulement traitée ne rouvre rien, et n’écrit rien', async () => {
      await entrant('wamid.ev-8');
      const id = await idDe();
      await store.marquerTraitee(tenantId, id, true, OPERATEUR());
      await entrant('wamid.ev-9', 'reaction');
      expect(await types(id)).toEqual(['traitee']);
      const r = await pool.query<{ traitee_le: Date | null }>('select traitee_le from conversations where id = $1', [id]);
      expect(r.rows[0]!.traitee_le).not.toBeNull();
    });

    it('⚠️ une réaction sort d’Archivé (arbitrage du 2026-09-19), donc la frise le dit', async () => {
      // Taire cette sortie laisserait la frise montrer « archivée » en dernier sur une conversation qui ne l'est
      // plus : la règle est « seulement si la valeur a changé », et elle a changé.
      await entrant('wamid.ev-10');
      const id = await idDe();
      await store.archiverConversation(tenantId, id, true, OPERATEUR());
      await entrant('wamid.ev-11', 'reaction');
      expect(await types(id)).toEqual(['archivee', 'rouverte']);
    });

    it('un envoi SORTANT ne rouvre rien et n’écrit rien', async () => {
      await entrant('wamid.ev-12');
      const id = await idDe();
      await store.archiverConversation(tenantId, id, true, OPERATEUR());
      await store.recordOutboundByWaId(tenantId, WA, { body: 'promo', messageId: 'wamid.ev-13', origine: 'campagne' });
      expect(await types(id)).toEqual(['archivee']);
    });
  });

  describe('les assignations : qui, par qui, et rien quand rien ne change', () => {
    it('🔴 assigner, réassigner au MÊME, réassigner, libérer, libérer une libre', async () => {
      await entrant('wamid.ev-20');
      const id = await idDe();
      expect(await store.setAssignee(tenantId, id, marie, OPERATEUR())).toBe(true);
      expect(await store.setAssignee(tenantId, id, marie, OPERATEUR())).toBe(true); // même personne : aucun événement
      expect(await store.setAssignee(tenantId, id, jean, OPERATEUR())).toBe(true);
      expect(await store.setAssignee(tenantId, id, null, OPERATEUR())).toBe(true);
      expect(await store.setAssignee(tenantId, id, null, OPERATEUR())).toBe(true); // déjà libre : rien
      expect(await journal(id)).toEqual([
        { type: 'assignee', acteur_id: admin, cible_id: marie, cause: null },
        { type: 'assignee', acteur_id: admin, cible_id: jean, cause: null },
        // La cible d'une désassignation est celle qu'on libère.
        { type: 'desassignee', acteur_id: admin, cible_id: jean, cause: null },
      ]);
    });

    it('un membre étranger ne passe pas, et n’écrit rien', async () => {
      await entrant('wamid.ev-21');
      const id = await idDe();
      const etranger = await membre(autreTenantId, 'x@evenements.itest', 'X', 'agent');
      expect(await store.setAssignee(tenantId, id, etranger, OPERATEUR())).toBe(false);
      expect(await journal(id)).toEqual([]);
    });

    it('une prise est signée par l’agent, acteur et cible', async () => {
      await entrant('wamid.ev-22');
      const id = await idDe();
      expect(await store.prendreSiLibre(tenantId, id, marie)).toBe(true);
      expect(await store.prendreSiLibre(tenantId, id, jean)).toBe(false);
      expect(await journal(id)).toEqual([{ type: 'assignee', acteur_id: marie, cible_id: marie, cause: null }]);
    });

    it('🔴 un scénario et une campagne assignent avec leur CAUSE, sans auteur', async () => {
      await entrant('wamid.ev-23');
      const id = await idDe();
      expect(await store.assignerSiLibre(tenantId, WA, marie, 'automatique : campagne Rentrée')).toBe(true);
      expect(await store.assignerSiLibre(tenantId, WA, jean, 'automatique : campagne Rentrée')).toBe(false);
      expect(await store.setAssigneeByWaId(tenantId, WA, marie, 'automatique : scénario Bienvenue')).toBe(true); // même
      expect(await store.setAssigneeByWaId(tenantId, WA, jean, 'automatique : scénario Bienvenue')).toBe(true);
      expect(await journal(id)).toEqual([
        { type: 'assignee', acteur_id: null, cible_id: marie, cause: 'automatique : campagne Rentrée' },
        { type: 'assignee', acteur_id: null, cible_id: jean, cause: 'automatique : scénario Bienvenue' },
      ]);
    });
  });

  describe('les rangements : un événement par vrai changement', () => {
    it('🔴 archiver l’archivée, traiter la traitée, signaler la signalée : rien de plus', async () => {
      await entrant('wamid.ev-30');
      const id = await idDe();
      for (let i = 0; i < 2; i += 1) {
        await store.archiverConversation(tenantId, id, true, OPERATEUR());
        await store.marquerTraitee(tenantId, id, true, OPERATEUR());
        await store.signalerConversation(tenantId, id, true, OPERATEUR());
      }
      for (let i = 0; i < 2; i += 1) {
        await store.archiverConversation(tenantId, id, false, OPERATEUR());
        await store.marquerTraitee(tenantId, id, false, OPERATEUR());
        await store.signalerConversation(tenantId, id, false, OPERATEUR());
      }
      expect(await types(id)).toEqual(['archivee', 'traitee', 'signalee', 'desarchivee', 'non_traitee', 'designalee']);
    });

    it('une conversation d’un autre espace ne se range pas et n’écrit rien', async () => {
      await entrant('wamid.ev-31');
      const id = await idDe();
      expect(await store.archiverConversation(autreTenantId, id, true, OPERATEUR())).toBe(false);
      expect(await journal(id)).toEqual([]);
    });
  });

  describe('le détenteur du fil : seulement ce qui touche l’agent de Meta', () => {
    it('🔴 prise à l’agent par un opérateur, rendue par une cause, et rien entre scénario et équipe', async () => {
      await entrant('wamid.ev-40');
      const id = await idDe();
      await pool.query(`update conversations set control_owner = 'mba' where id = $1`, [id]);
      expect(await store.setControlOwner(tenantId, WA, 'app_human', { par: OPERATEUR() })).toBe(true);
      expect(await store.setControlOwner(tenantId, WA, 'app_workflow', { par: AUTO })).toBe(true); // équipe -> scénario : rien
      expect(await store.setControlOwner(tenantId, WA, 'mba', { par: AUTO })).toBe(true);
      expect(await store.setControlOwner(tenantId, WA, 'mba', { par: AUTO })).toBe(false); // déjà : rien
      expect(await journal(id)).toEqual([
        { type: 'prise_mba', acteur_id: admin, cible_id: null, cause: null },
        { type: 'rendue_mba', acteur_id: null, cible_id: null, cause: 'automatique : test' },
      ]);
    });

    it('🔴 une escalade qui sort d’Archivé et de Traité le dit, avec sa cause', async () => {
      await entrant('wamid.ev-41');
      const id = await idDe();
      await store.archiverConversation(tenantId, id, true, OPERATEUR());
      await store.marquerTraitee(tenantId, id, true, OPERATEUR());
      expect(await store.setControlOwner(tenantId, WA, 'app_human', { par: AUTO, only: ['app_workflow'], escalade: true })).toBe(true);
      expect((await journal(id)).slice(2)).toEqual([
        { type: 'desarchivee', acteur_id: null, cible_id: null, cause: 'automatique : test' },
        { type: 'non_traitee', acteur_id: null, cible_id: null, cause: 'automatique : test' },
      ]);
    });

    it('🔴 la passation de l’agent de Meta, une seule fois même redélivrée', async () => {
      await entrant('wamid.ev-42');
      const id = await idDe();
      await pool.query(`update conversations set control_owner = 'mba' where id = $1`, [id]);
      await store.marquerEscalade(tenantId, WA, 'automatique : agent de Meta');
      await store.marquerEscalade(tenantId, WA, 'automatique : agent de Meta');
      expect(await journal(id)).toEqual([{ type: 'passee_par_mba', acteur_id: null, cible_id: null, cause: 'automatique : agent de Meta' }]);
    });

    it('la passation avant l’écho crée la conversation ET son événement', async () => {
      await store.marquerEscalade(tenantId, '33600000193', 'automatique : agent de Meta');
      expect(await types(await idDe('33600000193'))).toEqual(['passee_par_mba']);
    });
  });

  it('🔴 l’historique part avec sa conversation (purge, effacement RGPD)', async () => {
    await entrant('wamid.ev-50');
    const id = await idDe();
    await store.archiverConversation(tenantId, id, true, OPERATEUR());
    await pool.query('delete from conversations where id = $1', [id]);
    const r = await pool.query('select 1 from conversation_evenements where conversation_id = $1', [id]);
    expect(r.rowCount).toBe(0);
  });

  describe('le panneau Détail', () => {
    const ADMIN = () => ({ userId: admin, role: 'admin' });

    it('🔴 identité, badges, résumé absent, assignation, frise du plus récent au plus ancien', async () => {
      await pool.query(
        `insert into contacts (tenant_id, phone_e164, profile_name, opt_in_status, fields, tags)
         values ($1, $2, 'Durand', 'opted_out', '{"prenom":"Léa","email":"lea@exemple.fr"}'::jsonb, '{vip,salon}')`,
        [tenantId, `+${WA}`],
      );
      await entrant('wamid.ev-60');
      const id = await idDe();
      await store.setAssignee(tenantId, id, marie, OPERATEUR());
      await store.setAssignee(tenantId, id, jean, OPERATEUR());
      const d = await store.detailConversation(tenantId, id, ADMIN());
      expect(d?.identite).toMatchObject({
        waId: WA, nom: 'Durand', prenom: 'Léa', telephone: `+${WA}`, email: 'lea@exemple.fr',
        tags: ['vip', 'salon'], desabonne: true, bloque: false,
      });
      expect(d?.identite.contactId).not.toBeNull();
      expect(d?.resume).toBeNull();
      expect(d?.assignation).toEqual({ userId: jean, nom: 'Jean' });
      expect(d?.historique.map((e) => [e.type, e.reassignation, e.cible])).toEqual([
        ['assignee', true, { nom: 'Jean' }],
        ['assignee', false, { nom: 'Marie' }],
      ]);
      expect(d?.historique[0]?.acteur).toEqual({ nom: 'Alice Admin' });
    });

    it('le résumé de l’analyse, quand elle est passée', async () => {
      await entrant('wamid.ev-61');
      const id = await idDe();
      await pool.query(
        `insert into conversation_analysis
           (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
            exchanges_count, entities, action_suggestion, confidence, justification, llm_provider, llm_model, summary)
         values ($1, $2, 'neutre', 'information', 'horaires', true, 'humain',
                 2, '{}'::jsonb, 'aucune', 0.9, 'ok', 'itest', 'itest', 'Demande les horaires du samedi.')`,
        [id, tenantId],
      );
      expect((await store.detailConversation(tenantId, id, ADMIN()))?.resume).toBe('Demande les horaires du samedi.');
    });

    it('🔴 un collaborateur supprimé devient « ancien collaborateur », une cause reste une cause', async () => {
      const parti = await membre(tenantId, 'parti@evenements.itest', 'Parti', 'manager');
      await entrant('wamid.ev-62');
      const id = await idDe();
      await store.setAssignee(tenantId, id, parti, { collaborateur: parti });
      await store.archiverConversation(tenantId, id, true, AUTO);
      await pool.query('delete from users where id = $1', [parti]);
      const h = (await store.detailConversation(tenantId, id, ADMIN()))?.historique ?? [];
      expect(h.map((e) => [e.type, e.acteur, e.cible])).toEqual([
        ['archivee', null, null],
        ['assignee', { ancien: true }, { ancien: true }],
      ]);
    });

    it('🔴 la visibilité du fil : un agent voit les siennes et le pot commun, pas celle d’un collègue', async () => {
      await entrant('wamid.ev-63');
      const id = await idDe();
      const agent = (userId: string) => ({ userId, role: 'agent' });
      expect(await store.detailConversation(tenantId, id, agent(jean))).not.toBeNull(); // pot commun
      await store.setAssignee(tenantId, id, marie, OPERATEUR());
      expect(await store.detailConversation(tenantId, id, agent(marie))).not.toBeNull();
      expect(await store.detailConversation(tenantId, id, agent(jean))).toBeNull();
      // Une identité qui n'est pas un uuid ne fait pas échouer la requête : elle ne voit que le pot commun.
      expect(await store.detailConversation(tenantId, id, { userId: 'apikey:x', role: 'api' })).toBeNull();
      expect(await store.detailConversation(tenantId, id, ADMIN())).not.toBeNull();
      expect(await store.detailConversation(autreTenantId, id, ADMIN())).toBeNull();
    });
  });

  it('🔴 l’amorçage de la migration : une ligne par fait réel, aucune pour une colonne nulle', async () => {
    /**
     * Le SQL de l'amorçage est LU dans le fichier de migration, pas recopié : c'est lui qui a tourné en
     * production. Il est rejoué ici en sélection seule, borné à cet espace.
     */
    const sql = readFileSync(new URL('../../db/migrations/0192_conversation_evenements.sql', import.meta.url), 'utf8')
      .split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n');
    const debut = sql.indexOf('select', sql.indexOf('insert into conversation_evenements'));
    const selection = sql.slice(debut, sql.lastIndexOf(';'));

    await entrant('wamid.ev-70', 'text', '33600000170'); // rien de posé : aucune ligne
    await entrant('wamid.ev-71', 'text', '33600000171');
    const plein = await idDe('33600000171');
    await pool.query(
      `update conversations set assigned_to = $2, assigned_by = $3, assigned_at = now() - interval '3 days',
              traitee_le = now() - interval '2 days', archived_at = now() - interval '1 day',
              signalee_le = now() - interval '12 hours', signalee_par = $3, control_owner = 'app_human', control_changed_at = now()
        where id = $1`,
      [plein, marie, admin],
    );
    // Une assignation SANS date : pas de date, pas de ligne.
    await entrant('wamid.ev-72', 'text', '33600000172');
    await pool.query(`update conversations set assigned_to = $2, assigned_at = null where id = $1`, [await idDe('33600000172'), jean]);

    const r = await pool.query<{ conversation_id: string; type: string; acteur_id: string | null; cible_id: string | null; cause: string }>(
      `select a.conversation_id, a.type, a.acteur_id, a.cible_id, a.cause
         from (${selection}) as a (tenant_id, conversation_id, type, acteur_id, cible_id, cause, at)
        where a.tenant_id = $1
        order by a.at`,
      [tenantId],
    );
    expect(r.rows.every((l) => l.conversation_id === plein && l.cause === CAUSE_AMORCAGE)).toBe(true);
    expect(r.rows.map((l) => [l.type, l.acteur_id, l.cible_id])).toEqual([
      ['assignee', admin, marie],
      ['traitee', null, null],
      ['archivee', null, null],
      ['signalee', admin, null],
      ['prise_mba', null, null],
    ]);
  });
});
