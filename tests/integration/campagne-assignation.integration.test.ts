import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { assignerReponse, type AssignationDeps } from '../../src/inbox/assignation-campagne';

/**
 * L'ASSIGNATION À TOUR DE RÔLE, EN BASE.
 *
 * 🔴 CE QUE SEULE UNE BASE PEUT PROUVER : QUE DEUX RÉPONSES SIMULTANÉES NE TOMBENT PAS SUR LA MÊME
 * PERSONNE. Un faux dépôt rend le rang qu'on lui demande de rendre ; il ne peut pas montrer qu'un
 * `select` suivi d'un `update` laisse deux appelants lire la même valeur. C'est un défaut qui ne se voit
 * ni au compilateur, ni en test unitaire, ni en recette : il se voit sous charge, une fois de temps en
 * temps, quand deux destinataires répondent dans la même seconde.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('l assignation d une reponse de campagne', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  let inbox: PgInboxStore;
  let deps: AssignationDeps;
  let tenantId = '';
  let campaignId = '';
  const membres: string[] = [];

  /** Un contact, sa conversation et son statut de destinataire DÉJÀ SERVI par la campagne. */
  const destinataireQuiRepond = async (numero: string): Promise<string> => {
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`,
      [tenantId, `+${numero}`],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at)
       values ($1, $2, $3, '[]'::jsonb, 'sent', now())`,
      [campaignId, contactId, `+${numero}`],
    );
    // ⚠️ La conversation est créée À PART, exactement comme le ferait `recordInbound` : c'est elle que
    // l'affectation vise, et sans elle il n'y aurait rien à affecter.
    await pool.query(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_preview, last_direction)
       values ($1, $2, $3, now(), 'coucou', 'in')`,
      [tenantId, numero, contactId],
    );
    return numero;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    repo = new PgCampaignRepo(pool);
    inbox = new PgInboxStore(pool);
    deps = {
      campagneDeLaReponse: (t, w) => repo.campagneAssignanteDuContact(t, w),
      membres: (t) => inbox.membresAffectables(t),
      prendreUnRang: (t, c) => repo.prendreUnRangDeTourDeRole(t, c),
      assigner: (t, w, u) => inbox.assignerSiLibre(t, w, u),
    };
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-assignation') returning id`,
    )).rows[0]!.id;
    // 🔴 TROIS MEMBRES, ET LEUR ORDRE EST CELUI DE `membresAffectables` (created_at asc, id asc). Deux
    // membres suffiraient à voir le roulement mais pas à voir un rang qui dépasse l'équipe.
    for (const nom of ['a', 'b', 'c']) {
      membres.push((await pool.query<{ id: string }>(
        `insert into users (tenant_id, email, role, password_hash) values ($1, $2, 'agent', 'x') returning id`,
        [tenantId, `${nom}-assignation@example.test`],
      )).rows[0]!.id);
    }
    campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-assignation', name: 'assignation', category: 'marketing',
      templateName: 't', templateLanguage: 'fr', paramMapping: [],
      assignation: 'tour_de_role',
    });
  });

  beforeEach(async () => {
    // Chaque cas repart d'un roulement à zéro et sans conversation : sinon l'ordre d'exécution des cas
    // déciderait de qui reçoit quoi, et un test vert ne voudrait plus rien dire.
    await pool.query(`update campaigns set tour_de_role_rang = 0 where id = $1`, [campaignId]);
    await pool.query(`delete from conversations where tenant_id = $1`, [tenantId]);
    await pool.query(`delete from campaign_recipients where campaign_id = $1`, [campaignId]);
    await pool.query(`delete from contacts where tenant_id = $1`, [tenantId]);
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
      await pool.query('delete from campaigns where tenant_id = $1', [tenantId]);
      await pool.query('delete from contacts where tenant_id = $1', [tenantId]);
      await pool.query('delete from tenants where id = $1', [tenantId]);
    }
    await pool.end();
  });

  /**
   * 🔴 LE CAS QUI JUSTIFIE TOUT CE FICHIER. Deux réponses qui arrivent en même temps sur la même campagne
   * doivent tomber sur DEUX personnes. Avec un `select` puis un `update` séparés, les deux appelants
   * lisent le même rang et rendent la même personne : le test rougit ici, et nulle part ailleurs.
   */
  it('deux reponses simultanees tombent sur deux personnes differentes', async () => {
    const [w1, w2] = await Promise.all([
      destinataireQuiRepond('33600000101'),
      destinataireQuiRepond('33600000102'),
    ]);
    const [a, b] = await Promise.all([
      assignerReponse(tenantId, w1, deps),
      assignerReponse(tenantId, w2, deps),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('le roulement sert les membres dans l ordre, puis recommence', async () => {
    const numeros = ['33600000111', '33600000112', '33600000113', '33600000114'];
    for (const n of numeros) await destinataireQuiRepond(n);
    const recus: Array<string | null> = [];
    // En SÉRIE, pas en parallèle : ce cas-ci vérifie l'ORDRE, celui du dessus la concurrence.
    for (const n of numeros) recus.push(await assignerReponse(tenantId, n, deps));
    expect(recus).toEqual([membres[0], membres[1], membres[2], membres[0]]);
  });

  /**
   * 🔴 UN CONTACT BAVARD NE FAIT PAS TOURNER LE ROULEMENT. Sans la garde `assigned_to is null` dans la
   * recherche de campagne, chacun de ses messages consommerait un rang : la répartition compterait des
   * MESSAGES au lieu de CONVERSATIONS, et un seul interlocuteur décalerait tout le tour de rôle.
   */
  it('un second message du meme contact ne consomme aucun rang', async () => {
    const w = await destinataireQuiRepond('33600000121');
    expect(await assignerReponse(tenantId, w, deps)).toBe(membres[0]);
    expect(await assignerReponse(tenantId, w, deps)).toBeNull();
    const { rows } = await pool.query<{ rang: number }>(
      `select tour_de_role_rang as rang from campaigns where id = $1`, [campaignId],
    );
    expect(rows[0]?.rang, 'le second message a fait avancer le roulement').toBe(1);
  });

  // ⚠️ L'AUTRE SENS : la conversation reste bien affectée à la première personne, on ne l'a pas perdue.
  it('la premiere affectation tient', async () => {
    const w = await destinataireQuiRepond('33600000131');
    await assignerReponse(tenantId, w, deps);
    const { rows } = await pool.query<{ assigned_to: string | null }>(
      `select assigned_to from conversations where tenant_id = $1 and wa_id = $2`, [tenantId, w],
    );
    expect(rows[0]?.assigned_to).toBe(membres[0]);
  });

  /**
   * 🔴 LE RANG EST UN `smallint`, ET IL NE SE REMET JAMAIS À ZÉRO. Une campagne AU FIL DE L'EAU n'a aucun
   * plafond de destinataires : sans repliage, la 32 768e réponse lèverait `22003 smallint out of range`
   * sur le chemin d'un message entrant. Ce cas exécute le repliage POUR DE VRAI plutôt que de le lire.
   */
  it('le rang se replie au lieu de deborder le smallint', async () => {
    await pool.query(`update campaigns set tour_de_role_rang = 32766 where id = $1`, [campaignId]);
    expect(await repo.prendreUnRangDeTourDeRole(tenantId, campaignId)).toBe(32765);
    // 32766 + 1 = 32767, replié à 0 ; le rang RENDU est alors -1, que `prochainAssigne` ramène dans le
    // tableau. C'est pour ça que cette fonction corrige le signe du modulo.
    expect(await repo.prendreUnRangDeTourDeRole(tenantId, campaignId)).toBe(-1);
    expect(await repo.prendreUnRangDeTourDeRole(tenantId, campaignId)).toBe(0);
  });

  /**
   * ⚠️ SCOPE TENANT : le rang d'une campagne ne s'avance pas depuis un autre espace. Le pooler est
   * superuser, la RLS est contournée, et `id` seul suffirait sans le `tenant_id = $1` de la requête.
   */
  it('un autre espace ne peut pas avancer le roulement de cette campagne', async () => {
    const autre = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-assignation-autre') returning id`,
    )).rows[0]!.id;
    try {
      expect(await repo.prendreUnRangDeTourDeRole(autre, campaignId)).toBe(0);
      const { rows } = await pool.query<{ rang: number }>(
        `select tour_de_role_rang as rang from campaigns where id = $1`, [campaignId],
      );
      expect(rows[0]?.rang, 'un autre espace a fait avancer le roulement').toBe(0);
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });

  // ⚠️ Un destinataire JAMAIS SERVI (`sent_at` nul) n'est pas quelqu'un qui répond à la campagne : son
  // message ne doit rien déclencher, sinon un contact qui écrit spontanément avant l'envoi se ferait
  // attribuer une conversation au nom d'une campagne qui ne lui a rien envoyé.
  it('un destinataire jamais servi ne declenche aucune affectation', async () => {
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, '+33600000141', 'opted_in') returning id`,
      [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status)
       values ($1, $2, '+33600000141', '[]'::jsonb, 'pending')`,
      [campaignId, contactId],
    );
    await pool.query(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_preview, last_direction)
       values ($1, '33600000141', $2, now(), 'coucou', 'in')`,
      [tenantId, contactId],
    );
    expect(await assignerReponse(tenantId, '33600000141', deps)).toBeNull();
  });
});
