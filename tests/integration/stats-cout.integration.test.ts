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
   * LE TABLEAU « CE QUE COUTE UN ENGAGEMENT » (lot E du 2026-09-08), contre la meme base.
   *
   * 🔴 CE QUE CES DEUX TESTS PROTEGENT, et qu aucun test unitaire ne peut voir : la POPULATION du tableau
   * (elle doit etre celle du graphe de cout, sinon deux ecrans du meme onglet se contredisent) et la
   * distinction ABSENCE / ZERO sur les clics, qui est du SQL pur (zero ligne en sortie vaut « rien a
   * mesurer », pas « personne n a clique »).
   */
  it('E1 🔴 le volume PAR CAMPAGNE compte la meme chose que le graphe, et jette ce qui n a pas de campagne', async () => {
    const lignes = await store.getVolumeParCampagne(tenantId, RANGE);
    const mienne = lignes.filter((l) => l.campaignId === campaignId);
    // Les trois envois reussis de la campagne (camp1, camp2, direct-voisin) ; celui en ECHEC de livraison
    // est exclu, comme partout ailleurs.
    expect(mienne.reduce((a, l) => a + l.count, 0)).toBe(3);
    expect(mienne[0]).toMatchObject({ nom: 'itest-cout-campagne', template: TPL_CAMPAGNE, category: 'marketing' });

    // 🔴 L INVARIANT AVEC LE GRAPHE : filtrer le cout sur cette campagne doit rendre EXACTEMENT le meme
    // total. C est leur ECART qui porterait le defaut, et il ne se voit dans aucun des deux fichiers.
    const parCampagne = await store.getCostVolume(tenantId, RANGE, { campaignIds: [campaignId] });
    expect(mienne.reduce((a, l) => a + l.count, 0)).toBe(total(parCampagne));

    // L envoi de scenario NON rattache (aucune campagne scenario ne le reclame ici) n a pas de ligne : le
    // tableau a une ligne par campagne, il n a pas de ligne « le reste » ou le ranger.
    expect(lignes.some((l) => l.template === TPL_SCENARIO)).toBe(false);
  });

  it('E2 🔴 les clics : une campagne SANS lien trace est ABSENTE de la reponse, elle n a pas zero clic', async () => {
    // Un zero se lirait « personne n a clique », qui est une affirmation. La verite est « il n y a rien a
    // mesurer ici » : campagne a scenario (pas de template) ou template sans lien trace.
    const sansLien = await store.clicsParCampagne(tenantId, [campaignId]);
    expect(sansLien.has(campaignId)).toBe(false);

    // 🔴 ET LE CAS QUE L ECRAN NOMME : une campagne a SCENARIO, donc SANS template (`template_name` est
    // nullable depuis la 0024). C est celui que `todo.md` decrivait a l envers. Il vaut d etre exerce a
    // part : la campagne ci-dessus est absente pour une AUTRE raison (aucun lien trace confirme), et un
    // test qui ne couvrirait qu elle annoncerait une garantie qu il n apporte pas.
    const scenario = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, template_name, channel)
       values ($1, 'itest-scenario-sans-template', 'marketing', null, 'whatsapp') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const contactScn = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000032') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at, message_id)
       values ($1, $2, '33600000032', '{}'::jsonb, 'sent', timestamptz '2026-09-05 10:00:00+00', 'wamid.scn1')`,
      [scenario, contactScn],
    );
    expect((await store.clicsParCampagne(tenantId, [scenario])).has(scenario)).toBe(false);

    // Une campagne AVEC un lien trace confirme, et deux clics dont UN avant son premier envoi.
    const avecLien = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, template_name, template_language, channel)
       values ($1, 'itest-clics', 'marketing', 'itest_tpl_clics', 'fr', 'whatsapp') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000031') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at, message_id)
       values ($1, $2, '33600000031', '{}'::jsonb, 'sent', timestamptz '2026-09-05 10:00:00+00', 'wamid.clics1')`,
      [avecLien, contact],
    );
    await pool.query(
      `insert into tracked_links (code, tenant_id, template_name, template_language, button_index, destination, confirmed_at)
       values ('itestclic', $1, 'itest_tpl_clics', 'fr', 0, 'https://exemple.fr', now())`,
      [tenantId],
    );
    await pool.query(
      `insert into tracked_link_clicks (code, tenant_id, at) values
         ('itestclic', $1, timestamptz '2026-09-04 09:00:00+00'),
         ('itestclic', $1, timestamptz '2026-09-05 11:00:00+00'),
         ('itestclic', $1, timestamptz '2026-09-06 11:00:00+00')`,
      [tenantId],
    );

    const clics = await store.clicsParCampagne(tenantId, [avecLien, campaignId]);
    // DEUX et pas trois : le clic du 4 precede le premier envoi du 5. Meta explore et clique chaque bouton
    // URL pendant la revue du template, donc avant le moindre envoi ; sans ce seuil, une campagne demarre
    // avec des dizaines de clics qui ne viennent de personne.
    expect(clics.get(avecLien)).toBe(2);
    // Et l autre campagne reste absente : la reponse ne comble pas les trous avec des zeros.
    expect(clics.has(campaignId)).toBe(false);

    // Le funnel lit la MEME fonction : c est ce qui garantit que les deux ecrans annoncent le meme chiffre.
    expect((await store.getCampaignFunnel(tenantId, avecLien)).urlClicks).toBe(2);
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

  /**
   * 🔴 LES PERSONNES D UN BLOC, ET POURQUOI CE TEST NE PEUT PAS ETRE UNITAIRE. Le defaut vit dans le
   * `group by` : avec le handle dedans, `count(distinct wa_id)` compte les personnes PAR BOUTON, et
   * l appelant, qui n affiche pas le detail par bouton, les additionne. Une personne qui tape deux boutons
   * du meme bloc compte alors pour DEUX dans une colonne intitulee « pers. ».
   *
   * Le cas n est pas theorique : mesure en production le 2026-09-09, un contact reel a tape deux handles
   * d un meme bloc. Aucun test unitaire ne peut l attraper (un faux pool rend ce qu on lui dicte), et la
   * fiche l aurait affiche des le premier ecran ouvert sur ce scenario.
   */
  describe('mesures par bloc : les PERSONNES ne se comptent pas deux fois', () => {
    let campagneScenario: string;
    let noeud: string;

    beforeAll(async () => {
      const wf = (await pool.query<{ id: string }>(
        `insert into workflows (tenant_id, name, graph) values ($1, 'itest-wf', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
        [tenantId],
      )).rows[0]!.id;
      noeud = 'bloc-itest';
      campagneScenario = (await pool.query<{ id: string }>(
        `insert into campaigns (tenant_id, name, category, channel, workflow_id)
         values ($1, 'itest-scenario-personnes', 'marketing', 'whatsapp', $2) returning id`,
        [tenantId, wf],
      )).rows[0]!.id;
      // ⚠️ NUMERO LIBRE DANS TOUT LE FICHIER, pas seulement dans ce bloc. `contacts_tenant_phone_uidx`
      // porte sur (tenant_id, phone_e164), et les describes de ce fichier PARTAGENT le tenant : un numero
      // deja pris par un autre bloc fait lever le `beforeAll`, donc tomber tout le describe. Vecu le
      // 2026-09-09 avec `...021`, deja utilise trente lignes plus haut. La liste en usage se lit d un
      // `grep -o '+336[0-9]\{8\}'` sur ce fichier, elle ne se devine pas.
      const contact = (await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000041') returning id`, [tenantId],
      )).rows[0]!.id;
      await pool.query(
        `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, claimed_at, sent_at, message_id)
         values ($1, $2, '+33600000041', '{}'::jsonb, 'sent', timestamptz '2026-09-05 08:00:00+00', timestamptz '2026-09-05 08:00:01+00', 'wamid.itest-perso')`,
        [campagneScenario, contact],
      );
      // LA MEME personne tape DEUX boutons differents du MEME bloc.
      await pool.query(
        `insert into workflow_node_events (tenant_id, workflow_id, node_id, wa_id, kind, handle, at)
         values ($1, $2, $3, '33600000041', 'reply_button', 'btn:0', timestamptz '2026-09-05 09:00:00+00'),
                ($1, $2, $3, '33600000041', 'reply_button', 'btn:1', timestamptz '2026-09-05 09:05:00+00')`,
        [tenantId, wf, noeud],
      );
    });

    it('🔴 deux boutons tapes par UNE personne -> 2 gestes et 1 personne', async () => {
      const mesures = await store.mesuresScenarioParCampagne(tenantId, campagneScenario);
      const boutons = mesures.filter((m) => m.nodeId === noeud && m.kind === 'reply_button');
      // UNE seule ligne : le handle n est plus dans le regroupement, donc l appelant n a rien a additionner.
      expect(boutons).toHaveLength(1);
      expect(boutons[0]!.count).toBe(2);
      expect(boutons[0]!.contacts).toBe(1);
      expect(boutons[0]!.handle).toBeNull();
    });

    it('les evenements d une AUTRE campagne ne remontent pas ici', async () => {
      // L attribution est celle des envois : la campagne directe du decor commun ne doit rien absorber.
      const mesures = await store.mesuresScenarioParCampagne(tenantId, campaignId);
      expect(mesures).toEqual([]);
    });
  });
});

/**
 * LA POPULATION DU TABLEAU « COUT PAR ENGAGEMENT » (lot 4 de la liste de Julien du 2026-09-23).
 *
 * 🔴 POURQUOI EN INTEGRATION : tout se joue dans le SQL de `getVolumeParCampagne`. Une campagne qui a touche
 * quelqu un sans rien de facturable (scenario en fenetre de service, RCS, numero de test) n avait aucune ligne :
 * mesure faite en production, 2 campagnes visibles sur 7. Et les archivees entraient sans le dire.
 */
describe.skipIf(!url)('Cout : la population du tableau par campagne (Postgres reel)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    store = new PgStatsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-cout-population') returning id`)).rows[0]!.id;
    const contact = async (num: string) => (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`, [tenantId, num],
    )).rows[0]!.id;
    /** Une campagne qui a TOUCHE une personne dans la periode, avec ou sans modele, archivee ou non. */
    const campagne = async (nom: string, opts: { template?: string; canal?: string; archivee?: boolean }, num: string) => {
      const id = (await pool.query<{ id: string }>(
        `insert into campaigns (tenant_id, name, category, template_name, channel, archived_at)
         values ($1, $2, 'marketing', $3, $4, case when $5::boolean then now() else null end) returning id`,
        [tenantId, nom, opts.template ?? null, opts.canal ?? 'whatsapp', opts.archivee === true],
      )).rows[0]!.id;
      await pool.query(
        `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at, message_id)
         values ($1, $2, $3, '{}'::jsonb, 'sent', $4::date, $5)`,
        [id, await contact(num), num.replace('+', ''), AUJ, `wamid.pop-${nom}`],
      );
      ids[nom] = id;
      return id;
    };
    await campagne('modele', { template: 'itest_pop_tpl' }, '+33600000801');
    await campagne('scenario', {}, '+33600000802');
    await campagne('rcs', { canal: 'rcs' }, '+33600000803');
    await campagne('archivee', { template: 'itest_pop_tpl' }, '+33600000804');
    await pool.query(`update campaigns set archived_at = now() where id = $1`, [ids['archivee']]);
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query(`delete from campaign_recipients where campaign_id in (select id from campaigns where tenant_id = $1)`, [tenantId]);
      await pool.query(`delete from campaigns where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from contacts where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from tenants where id = $1`, [tenantId]);
    }
    await pool.end();
  });

  it('🔴 une campagne SANS rien de facturable a sa ligne, avec les personnes touchees', async () => {
    const lignes = await store.getVolumeParCampagne(tenantId, RANGE);
    const par = new Map(lignes.map((l) => [l.campaignId, l]));
    expect(par.get(ids['scenario']!)).toMatchObject({ nom: 'scenario', template: null, canal: 'whatsapp', category: null, count: 0, envois: 1 });
    expect(par.get(ids['rcs']!)).toMatchObject({ nom: 'rcs', canal: 'rcs', count: 0, envois: 1 });
    // La campagne à modèle garde SON compte facturable, et porte les personnes touchées en plus.
    expect(par.get(ids['modele']!)).toMatchObject({ category: 'marketing', count: 1, envois: 1 });
  });

  it('🔴 les archivees sont exclues par defaut, et la bascule les rend', async () => {
    const sans = await store.getVolumeParCampagne(tenantId, RANGE);
    expect(sans.some((l) => l.campaignId === ids['archivee'])).toBe(false);
    const avec = await store.getVolumeParCampagne(tenantId, RANGE, { inclureArchivees: true });
    expect(avec.some((l) => l.campaignId === ids['archivee'])).toBe(true);
    // ⚠️ Et la bascule ne change rien aux autres : elle AJOUTE, elle ne remplace pas.
    expect(avec.length).toBe(sans.length + 1);
  });
});
