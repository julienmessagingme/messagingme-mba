import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier cree/supprime des tenants. La CI monte un Postgres jetable pour ca
// (job `integration`) : c est la qu il doit tourner.
const url = process.env.DATABASE_URL ?? '';

/**
 * Le COUT, contre un vrai Postgres.
 *
 * 🔴 POURQUOI EN INTEGRATION ET PAS AVEC UN FAUX POOL. Tout ce qui a casse ici est du SQL : une union
 * absente d un cote, une garde anti-double-compte, et le comportement d un filtre face a un `null`. Un faux
 * pool prouve la FORME d une requete, il ne peut pas prouver qu elle COMPTE la bonne population, et c est
 * exactement ce qui manquait.
 *
 * Le defaut repare : `getCostVolume` ne lisait que `campaign_recipients`, alors que
 * `getTemplateBreakdown` portait en plus l union vers `conversation_messages`. Un template envoye par un
 * noeud de scenario etait donc compte dans « Detail par template » et INVISIBLE du graphe « Cout estime ».
 * Mesure le 2026-09-07 en production sur `actu_cin_ma_2` : 0 d un cote, 7 de l autre. Le client filtrait
 * sur un template reellement envoye et obtenait un graphe vide.
 */

const AUJ = '2026-09-07';
const RANGE = { from: '2026-09-01', to: AUJ };
const TPL_CAMPAGNE = 'itest_cout_campagne';
const TPL_SCENARIO = 'itest_cout_scenario';

describe.skipIf(!url)('Cout : les deux lectures comptent la MEME population (Postgres reel)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId: string;
  let campaignId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgStatsStore(pool);

    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-cout') returning id`,
    )).rows[0]!.id;

    // ⚠️ DEUX contraintes gouvernent ce fixture, et les deux ne se voient qu en CI :
    //  - `contacts_identity_present` (0001) exige un telephone OU un bsuid, d ou `phone_e164` ;
    //  - `unique (campaign_id, contact_id)` sur `campaign_recipients` (0003) interdit de reutiliser le
    //    MEME contact pour plusieurs destinataires d une meme campagne. Une premiere version le faisait,
    //    et le `beforeAll` aurait leve, faisant tomber TOUT le describe sans qu on le voie en local.
    // `contacts_tenant_phone_uidx` (0001) impose en plus un numero distinct par contact.
    const contacts: string[] = [];
    for (const num of ['+33600000001', '+33600000002', '+33600000003']) {
      contacts.push((await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`, [tenantId, num],
      )).rows[0]!.id);
    }

    // --- 1. Deux envois de CAMPAGNE, dont un en ECHEC (qui ne doit jamais etre facture) ---------------
    campaignId = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, template_name, channel)
       values ($1, 'itest-cout-campagne', 'marketing', $2, 'whatsapp') returning id`,
      [tenantId, TPL_CAMPAGNE],
    )).rows[0]!.id;
    // Un contact PAR destinataire : voir la contrainte d unicite ci-dessus.
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at, message_id)
       values ($1, $2, '33600000001', '{}'::jsonb, 'sent', $4::date, 'wamid.camp1'),
              ($1, $3, '33600000002', '{}'::jsonb, 'sent', $4::date, 'wamid.camp2')`,
      [campaignId, contacts[0], contacts[1], AUJ],
    );
    // Celui-ci est parti puis a echoue a la livraison : hors facturation, des les deux lectures.
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at, delivery_status, message_id)
       values ($1, $2, '33600000003', '{}'::jsonb, 'sent', $3::date, 'failed', 'wamid.campko')`,
      [campaignId, contacts[2], AUJ],
    );

    // 🔴 CE DESTINATAIRE FAIT MORDRE LE TEST DU DISCRIMINANT, et il vit dans le decor COMMUN pour que les
    // comptes ne dependent pas de l ordre des hooks de vitest. Il vise le numero de la conversation qui
    // portera l envoi de scenario (33600000009) et appartient a la campagne DIRECTE : sans
    // `c3.workflow_id is not null`, cette campagne absorberait cet envoi. Sans lui, retirer le discriminant
    // laissait TOUTES les assertions vertes, un test qui annonce proteger ce qu il n exerce jamais.
    const contactVoisin = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000009') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, claimed_at, sent_at, message_id)
       values ($1, $2, '+33600000009', '{}'::jsonb, 'sent', timestamptz '2026-09-01 08:00:00+00', timestamptz '2026-09-01 08:00:01+00', 'wamid.direct-voisin')`,
      [campaignId, contactVoisin],
    );

    const convId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, control_owner, is_test)
       values ($1, '33600000009', now(), 'app_workflow', false) returning id`, [tenantId],
    )).rows[0]!.id;

    // --- 2. Un envoi de template HORS campagne (un noeud de scenario) --------------------------------
    // C est LUI que `getCostVolume` ne voyait pas.
    //
    // 🔴 CATEGORIE NULL, ET C EST LE CAS REEL. `logTemplateSent` (`src/inbox/outbound-log.ts`) n ecrit
    // AUCUNE categorie pour un template envoye par un scenario : mesure en production le 2026-09-07, les
    // 22 envois de scenario du tenant Demo portent tous `template_category = NULL`. Un fixture qui poserait
    // 'utility' ici passerait sur un cas qui n existe pas, et raterait le defaut suivant : le calcul de
    // cout (`src/stats/cost.ts`) ignore toute ligne sans categorie, donc le graphe reste vide meme quand
    // la requete rend bien les lignes.
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, template_name, template_category, created_at, meta_message_id)
       values ($1, 'out', 'template', $2, null, $3::date, 'wamid.scenario1')`,
      [convId, TPL_SCENARIO, AUJ],
    );

    // --- 3. Le MEME envoi de campagne, aussi trace en conversation_messages --------------------------
    // C est le cas que la garde anti-double-compte doit absorber : meme wamid que `wamid.camp1`.
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, template_name, template_category, created_at, meta_message_id)
       values ($1, 'out', 'template', $2, 'marketing', $3::date, 'wamid.camp1')`,
      [convId, TPL_CAMPAGNE, AUJ],
    );

    // --- 4. Un fil de TEST : il ne doit jamais entrer dans une facture -------------------------------
    const convTest = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, control_owner, is_test)
       values ($1, '33600000010', now(), 'app_workflow', true) returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, template_name, template_category, created_at, meta_message_id)
       values ($1, 'out', 'template', $2, null, $3::date, 'wamid.test1')`,
      [convTest, TPL_SCENARIO, AUJ],
    );
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const total = (rows: Array<{ count: number }>) => rows.reduce((a, r) => a + r.count, 0);

  it('T1 🔴 le cout voit un template envoye HORS campagne (le defaut d origine)', async () => {
    const rows = await store.getCostVolume(tenantId, RANGE, { templateNames: [TPL_SCENARIO] });
    // 1 envoi de scenario. Le fil de TEST n en fait pas partie.
    expect(total(rows)).toBe(1);
  });

  it('T2 🔴 la garde anti-double-compte tient : un template de campagne n est compte QU UNE fois', async () => {
    // `wamid.camp1` existe dans les DEUX tables. Sans la garde, il compterait deux fois, et la facture
    // estimee serait gonflee d autant.
    const rows = await store.getCostVolume(tenantId, RANGE, { templateNames: [TPL_CAMPAGNE] });
    // camp1, camp2 et direct-voisin ; celui en echec de livraison est exclu.
    expect(total(rows)).toBe(3);
  });

  it('T3 🔴 filtrer par CAMPAGNE exclut les envois hors campagne, filtrer par TEMPLATE les inclut', async () => {
    // Les deux comportements sont voulus, et c est le `campaign_id` a `null` du fragment qui les produit :
    // `null = any(...)` vaut NULL, donc pas TRUE, donc l envoi de scenario sort du `where` tout seul.
    // ⚠️ NULL n est pas `false` : la nuance s inverserait sous une negation.
    const parCampagne = await store.getCostVolume(tenantId, RANGE, { campaignIds: [campaignId] });
    expect(total(parCampagne)).toBe(3);

    const parTemplate = await store.getCostVolume(tenantId, RANGE, { templateNames: [TPL_SCENARIO] });
    expect(total(parTemplate)).toBe(1);
  });

  it('T4 🔴 sans filtre, le COUT et le DETAIL rendent le MEME total', async () => {
    // L invariant qui ferme le defaut pour de bon. Il n existait dans aucun des deux fichiers : chacun etait
    // plausible seul, c est leur ECART qui portait le bug. En production le 2026-09-07, avant correction :
    // 35 d un cote, 28 de l autre.
    const cout = total(await store.getCostVolume(tenantId, RANGE, {}));
    const detail = await store.getTemplateBreakdown(tenantId, RANGE);
    // L INVARIANT, et il ne depend d aucun ordre d execution : quoi qu il y ait dans le decor, les deux
    // lectures decrivent la MEME population. C est lui qui ferme le defaut, pas un total absolu.
    expect(cout).toBe(total(detail));
    // Les comptes PAR TEMPLATE, eux, sont stables : un total absolu dependrait de ce qu un `beforeAll`
    // imbrique aurait deja insere, donc de l ordre des hooks de vitest, ce qui est un couplage inutile.
    expect(detail.find((r) => r.name === TPL_CAMPAGNE)?.count).toBe(3);
    expect(detail.find((r) => r.name === TPL_SCENARIO)?.count).toBe(1);
  });

  it('un fil de TEST n entre dans aucune des deux lectures', async () => {
    const detail = await store.getTemplateBreakdown(tenantId, RANGE);
    const scenario = detail.find((r) => r.name === TPL_SCENARIO);
    // 1 et pas 2 : le message du fil `is_test` est ecarte des deux cotes.
    expect(scenario?.count).toBe(1);
  });

  it('une livraison en ECHEC n est facturee nulle part', async () => {
    const detail = await store.getTemplateBreakdown(tenantId, RANGE);
    expect(detail.find((r) => r.name === TPL_CAMPAGNE)?.count).toBe(3);
  });

  /**
   * L ATTRIBUTION D UN ENVOI DE SCENARIO A LA CAMPAGNE QUI L A DEMARRE (decision de Julien, 2026-09-07).
   *
   * 🔴 CE QUE CES TESTS PROTEGENT, ET QU AUCUN RAISONNEMENT N AURAIT DONNE. Le moteur journalise le message
   * dans le fil AVANT de marquer le destinataire envoye. Mesure sur la campagne reelle « Formation du 3 » :
   * les quatre messages precedent leur ligne de campagne de 55 a 90 ms. Un predicat naturel
   * (« la campagne est partie AVANT le message ») excluait donc EXACTEMENT les envois qu il devait
   * rattacher : 1 attribue sur 4. C est pour ca que la sous-requete porte une tolerance, et c est pour ca
   * que le fixture ci-dessous REPRODUIT ce decalage au lieu d ecrire un ordre confortable.
   */
  describe('attribution d un envoi de scenario a sa campagne', () => {
    let campagneScenario: string;
    let autreCampagneScenario: string;

    beforeAll(async () => {
      const wf = (await pool.query<{ id: string }>(
        `insert into workflows (tenant_id, name) values ($1, 'itest-cout-wf') returning id`, [tenantId],
      )).rows[0]!.id;
      const contactId = (await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000020') returning id`, [tenantId],
      )).rows[0]!.id;

      campagneScenario = (await pool.query<{ id: string }>(
        `insert into campaigns (tenant_id, name, category, workflow_id, channel)
         values ($1, 'itest-cout-scenario', 'marketing', $2, 'whatsapp') returning id`, [tenantId, wf],
      )).rows[0]!.id;
      autreCampagneScenario = (await pool.query<{ id: string }>(
        `insert into campaigns (tenant_id, name, category, workflow_id, channel)
         values ($1, 'itest-cout-scenario-2', 'marketing', $2, 'whatsapp') returning id`, [tenantId, wf],
      )).rows[0]!.id;

      const conv = (await pool.query<{ id: string }>(
        `insert into conversations (tenant_id, wa_id, last_message_at, control_owner, is_test)
         values ($1, '33600000020', now(), 'app_workflow', false) returning id`, [tenantId],
      )).rows[0]!.id;

      // 🔴 LE MESSAGE EST ECRIT AVANT LA LIGNE DE CAMPAGNE (80 ms), comme en production.
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, type, template_name, template_category, created_at, meta_message_id)
         values ($1, 'out', 'template', 'itest_tpl_scenario_campagne', 'marketing', timestamptz '2026-09-03 14:30:49.046+00', 'wamid.wf1')`,
        [conv],
      );
      await pool.query(
        `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, claimed_at, sent_at, message_id)
         values ($1, $2, '+33600000020', '{}'::jsonb, 'sent', timestamptz '2026-09-03 14:30:48.900+00', timestamptz '2026-09-03 14:30:49.126+00', 'wf-run-1')`,
        [campagneScenario, contactId],
      );
    });

    it('T11 🔴 l envoi de scenario est rattache a la campagne, MALGRE le message ecrit avant la ligne', async () => {
      const rows = await store.getCostVolume(tenantId, RANGE, { campaignIds: [campagneScenario] });
      expect(total(rows)).toBe(1);
    });

    it('T13 🔴 filtrer le cout sur une campagne SCENARIO rend ses envois (le trou signale par Julien)', async () => {
      // Avant l attribution, ce filtre rendait 0 : la campagne scenario n envoie pas elle-meme de template,
      // et l envoi reel de son scenario n etait rattache a rien.
      const rows = await store.getCostVolume(tenantId, RANGE, { campaignIds: [campagneScenario] });
      expect(rows.length).toBeGreaterThan(0);
      expect(total(rows)).toBe(1);
    });

    it('🔴 entre DEUX campagnes scenario sur le meme numero, c est la PLUS RECENTE qui rattache', async () => {
      // Sans destinataire concurrent, ce test ne distinguait pas un `order by ... limit 1` juste d un
      // casse : il passait avec n importe quelle implementation. La rivale claime AVANT, donc elle perd.
      const contactRival = (await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000021') returning id`, [tenantId],
      )).rows[0]!.id;
      await pool.query(
        `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, claimed_at, sent_at, message_id)
         values ($1, $2, '+33600000020', '{}'::jsonb, 'sent', timestamptz '2026-09-03 10:00:00+00', timestamptz '2026-09-03 10:00:01+00', 'wf-run-rival')`,
        [autreCampagneScenario, contactRival],
      );
      expect(total(await store.getCostVolume(tenantId, RANGE, { campaignIds: [autreCampagneScenario] }))).toBe(0);
      expect(total(await store.getCostVolume(tenantId, RANGE, { campaignIds: [campagneScenario] }))).toBe(1);
    });

    it('🔴 une campagne a template DIRECT n absorbe jamais un envoi de scenario', async () => {
      // Le discriminant `workflow_id is not null` : une campagne a template direct envoie elle-meme, son
      // envoi est deja compte par la premiere branche. L autoriser ici lui attribuerait en plus les envois
      // d un scenario declenche par tout autre chose, et gonflerait sa facture.
      const rows = await store.getCostVolume(tenantId, RANGE, { campaignIds: [campaignId] });
      // Ses TROIS envois propres (dont celui vers 33600000009), et rien de l envoi de scenario qui vit
      // dans la conversation du meme numero. Sans le discriminant, ce serait 4.
      expect(total(rows)).toBe(3);
    });

    it('l attribution ne change RIEN au total : elle repartit, elle n ajoute pas', async () => {
      const cout = total(await store.getCostVolume(tenantId, RANGE, {}));
      const detail = total(await store.getTemplateBreakdown(tenantId, RANGE));
      expect(cout).toBe(detail);
    });
  });
});
