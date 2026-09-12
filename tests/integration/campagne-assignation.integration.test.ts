import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { assignerReponse, prochainAssigne, type AssignationDeps } from '../../src/inbox/assignation-campagne';

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

  /**
   * LE ROULEMENT SERT CHAQUE MEMBRE UNE FOIS, PUIS RECOMMENCE.
   *
   * ⚠️ CE TEST N'ÉPINGLE PLUS UN POINT DE DÉPART, ET C'EST DÉLIBÉRÉ. Le premier rang consommé vaut 1 et
   * non 0 (la colonne part de 0, et `RETURNING` rend l'après-incrément) : la première réponse va donc au
   * DEUXIÈME membre de la liste. Le point de départ d'une rotation est arbitraire ; ce qui se vérifie,
   * c'est que trois réponses d'affilée touchent TROIS personnes différentes, et que la quatrième
   * reboucle sur la première servie. Exiger `[a, b, c, a]` aurait figé un détail sans conséquence et
   * rendu le test rouge pour une raison qui n'intéresse personne.
   */
  it('le roulement sert chaque membre une fois, puis recommence', async () => {
    const numeros = ['33600000111', '33600000112', '33600000113', '33600000114'];
    for (const n of numeros) await destinataireQuiRepond(n);
    const recus: Array<string | null> = [];
    // En SÉRIE, pas en parallèle : ce cas-ci vérifie la ROTATION (chacun une fois, puis on reboucle),
    // celui du dessus la CONCURRENCE. Les mélanger rendrait l'un des deux illisible.
    for (const n of numeros) recus.push(await assignerReponse(tenantId, n, deps));

    // Les trois premières réponses touchent les TROIS membres, chacun une fois et une seule.
    expect(new Set(recus.slice(0, 3)).size).toBe(3);
    expect([...recus.slice(0, 3)].sort()).toEqual([...membres].sort());
    // Et la quatrième reboucle exactement sur la première servie.
    expect(recus[3]).toBe(recus[0]);
  });

  /**
   * 🔴 UN CONTACT BAVARD NE FAIT PAS TOURNER LE ROULEMENT. Sans la garde `assigned_to is null` dans la
   * recherche de campagne, chacun de ses messages consommerait un rang : la répartition compterait des
   * MESSAGES au lieu de CONVERSATIONS, et un seul interlocuteur décalerait tout le tour de rôle.
   */
  it('un second message du meme contact ne consomme aucun rang', async () => {
    const w = await destinataireQuiRepond('33600000121');
    // ⚠️ On n'épingle PAS lequel des trois membres reçoit : le point de départ d'une rotation est
    // arbitraire (le premier rang consommé vaut 1, pas 0). Ce qui se vérifie ici est le COMPTEUR.
    expect(membres).toContain(await assignerReponse(tenantId, w, deps));
    expect(await assignerReponse(tenantId, w, deps)).toBeNull();
    const { rows } = await pool.query<{ rang: number }>(
      `select tour_de_role_rang as rang from campaigns where id = $1`, [campaignId],
    );
    expect(rows[0]?.rang, 'le second message a fait avancer le roulement').toBe(1);
  });

  // ⚠️ L'AUTRE SENS DU CAS DU DESSUS : on a bien ÉCRIT quelque chose, l'affectation n'est pas restée en
  // mémoire. Sans lui, une implémentation qui rend un membre sans jamais toucher la base passerait.
  it('la premiere affectation tient', async () => {
    const w = await destinataireQuiRepond('33600000131');
    const recu = await assignerReponse(tenantId, w, deps);
    const { rows } = await pool.query<{ assigned_to: string | null }>(
      `select assigned_to from conversations where tenant_id = $1 and wa_id = $2`, [tenantId, w],
    );
    // ⚠️ On compare à CE QUI A ÉTÉ RENDU, pas à un membre nommé : ce cas vérifie que l'écriture en base
    // dit la même chose que la valeur rendue, pas quel membre le roulement a servi en premier.
    expect(rows[0]?.assigned_to).toBe(recu);
    expect(membres).toContain(recu);
  });

  /**
   * 🔴 L'INVARIANT DU RANG, ÉPINGLÉ LÀ OÙ LE DÉPÔT S'EST TROMPÉ DEUX FOIS : **deux rangs consécutifs sont
   * DISTINCTS, tous deux POSITIFS, et ils désignent deux personnes DIFFÉRENTES**. Ce n'est pas une valeur
   * particulière qui compte, c'est cette propriété-là.
   *
   * Ce test part de 32 766, l'ancien point de rupture, et il aurait rougi sur les DEUX défauts :
   *   - avec `returning tour_de_role_rang - 1`, le second appel rendait **-1** (`RETURNING` rend la
   *     valeur NOUVELLE, jamais l'ancienne), et `prochainAssigne` ne désigne personne sur un négatif ;
   *   - avec le `% 32767` qui protégeait le `smallint`, les deux rangs valaient 32766 puis 0, donc la
   *     MÊME personne pour une équipe de 2, 3 ou 6 (mesuré : seules les tailles divisant 32767, soit 7,
   *     31, 151 et 217, y échappaient). L'équipe de ce test en compte TROIS, donc elle est dans le cas
   *     qui casse.
   *
   * ⚠️ Il exerce aussi, au passage, le fait que 32 767 n'est plus une borne : la colonne est un `integer`
   * depuis la migration 0136, et la dépasser ne lève plus `22003 smallint out of range` sur le chemin
   * d'un message entrant.
   */
  it('deux rangs consecutifs restent distincts et positifs, meme au-dela de 32766', async () => {
    await pool.query(`update campaigns set tour_de_role_rang = 32766 where id = $1`, [campaignId]);
    const un = await repo.prendreUnRangDeTourDeRole(tenantId, campaignId);
    const deux = await repo.prendreUnRangDeTourDeRole(tenantId, campaignId);

    expect(un).toBeGreaterThan(0);
    expect(deux).toBeGreaterThan(0);
    expect(deux).not.toBe(un);
    // 🔴 LA PROPRIÉTÉ QUI COMPTE VRAIMENT, exercée par la VRAIE règle et non par un calcul recopié : ces
    // deux rangs doivent désigner deux membres différents de l'équipe.
    expect(prochainAssigne(membres, un)).not.toBe(prochainAssigne(membres, deux));
    expect(membres).toContain(prochainAssigne(membres, un));
    expect(membres).toContain(prochainAssigne(membres, deux));
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
