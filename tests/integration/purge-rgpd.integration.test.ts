import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { PgCampaignRepo, PgRecipientStore } from '../../src/campaign/store.pg';
import { creerNoteurJoignabilite } from '../../src/contacts/joignabilite.pg';

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
  let autreTenantId = '';
  let bloqueurId = '';

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

    // Mesures par bloc : elles portent le wa_id, donc une donnee personnelle. Elles ne doivent PAS survivre
    // telles quelles a une purge, mais elles ne doivent pas disparaitre non plus (cf. le test dedie).
    await pool.query(
      `insert into workflow_node_events (tenant_id, workflow_id, node_id, wa_id, kind) values ($1, $2, 'n1', $3, 'sent')`,
      [tenantId, workflowId, WA_ID],
    );

    // `webhook_events` : le payload BRUT de Meta, donc le TEXTE du message et le numéro de qui l'écrit.
    // On pose les DEUX formes (message entrant par `from`, statut de livraison par `recipient_id`) sur le
    // numéro de CE tenant, plus une troisième ligne sur le numéro d'un AUTRE tenant, avec le même wa_id :
    // c'est elle qui prouve que l'effacement reste cloisonné.
    await pool.query(`insert into waba (id, tenant_id, name) values ('itest-waba-purge', $1, 'w')`, [tenantId]);
    await pool.query(
      `insert into phone_numbers (id, waba_id, tenant_id, display_phone_number) values ('itest-pn-purge', 'itest-waba-purge', $1, '+33525680299')`,
      [tenantId],
    );
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-purge-voisin') returning id`)).rows[0]!.id;
    await pool.query(`insert into waba (id, tenant_id, name) values ('itest-waba-voisin', $1, 'w')`, [autreTenantId]);
    await pool.query(
      `insert into phone_numbers (id, waba_id, tenant_id, display_phone_number) values ('itest-pn-voisin', 'itest-waba-voisin', $1, '+33525680298')`,
      [autreTenantId],
    );
    await pool.query(
      `insert into webhook_events (source, meta_message_id, payload, phone_number_id) values
         ('messages', $1, $2::jsonb, 'itest-pn-purge'),
         ('statuses', $3, $4::jsonb, 'itest-pn-purge'),
         ('messages', $5, $6::jsonb, 'itest-pn-voisin')`,
      [
        `wam-itest-ev-1`, JSON.stringify({ from: WA_ID, id: 'wam-1', text: { body: 'je raconte ma vie' } }),
        `wam-itest-ev-2`, JSON.stringify({ recipient_id: WA_ID, id: 'wam-2', status: 'delivered' }),
        `wam-itest-ev-3`, JSON.stringify({ from: WA_ID, id: 'wam-3', text: { body: 'chez le voisin' } }),
      ],
    );

    // L'ARRIVÉE PUBLICITAIRE (lot 1 des pubs) : `ctwa_clid` est l'identifiant du CLIC, que Meta sait relier à la
    // personne. Il doit partir ; la ligne doit rester (le compte des leads d'une pub survit, comme le quanti).
    await pool.query(
      `insert into arrivees_pub (tenant_id, contact_id, meta_message_id, ad_id, ctwa_clid, en_standby)
       values ($1, $2, 'wam-itest-arrivee', 'ad-itest', 'clid-itest', false)`,
      [tenantId, contactId],
    );

    // L'identifiant de l'outil du client (migration 0172) : il désigne cette personne chez le client.
    await pool.query(`update contacts set external_id = 'itest-ext-purge' where id = $1`, [contactId]);

    // Ce que l'équipe, les balayages et l'analyse posent sur la fiche : des JUGEMENTS (étiquettes, risque), des
    // faits tirés des messages ou du numéro (langue, joignabilité), une source de consentement en texte libre, et
    // les REFUS (opt-out, STOP RCS, blocage). Les premiers doivent partir, les refus rester.
    bloqueurId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'bloqueur-itest-purge@x.fr', 'admin', 'x') returning id`,
      [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `update contacts set tags = array['vip', 'mauvais payeur'],
         risque_niveau = 'eleve', risque_score = 72, risque_raisons = array['reclamation'], risque_calcule_le = now(),
         langue_detectee = 'en', langue_detectee_le = now(), whatsapp_joignable = false, whatsapp_joignable_le = now(),
         opt_in_status = 'opted_out', opt_out_at = now(), opt_in_source = 'formulaire de Jean Dupont',
         rcs_optout_at = now(), blocked_at = now(), blocked_by = $2
       where id = $1`,
      [contactId, bloqueurId],
    );

    // LA DERNIÈRE ANALYSE RECOPIÉE SUR LA FICHE (migration 0196) : des jugements sur la personne, qui survivent
    // exprès à l'effacement de ses conversations. La purge, elle, doit les emporter.
    await pool.query(
      `update contacts set analyse_intention = 'reclamation', analyse_sentiment = 'negatif', analyse_satisfaction = 1,
         analyse_urgence = 9, analyse_resolue = false, analyse_sujet = 'sujet qui identifie la personne',
         analyse_traitee_par = 'humain', analyse_action = 'rappeler', analyse_le = now(), analyse_fenetre_fin = now(),
         analyse_conversation_id = $2
       where id = $1`,
      [contactId, convId],
    );

    // LOT 3 DE L'API PUBLIQUE : les VARIABLES d'un destinataire (migration 0174) et l'ÉCHEC d'un message libre
    // (migration 0175) portent des données de la personne (un numéro de commande, un numéro de téléphone).
    // Une ligne d'échec est posée AUSSI chez le voisin, sur le même numéro : elle prouve le cloisonnement.
    await new PgCampaignRepo(pool).createWithRecipients(
      { tenantId, phoneNumberId: '', name: 'itest-purge-variables', category: 'utility', templateName: 'confirmation', templateLanguage: 'fr', paramMapping: [] },
      [{ contactId, toE164: E164, resolvedParams: ['8412'], variables: { commande: '8412' } }],
    );
    await pool.query(
      `insert into echecs_messages (tenant_id, message_id, wa_id, canal, motif)
       values ($1, 'itest-purge-echec', $2, 'rcs', 'UNDELIVERABLE'), ($3, 'itest-purge-echec-voisin', $2, 'rcs', 'UNDELIVERABLE')`,
      [tenantId, WA_ID, autreTenantId],
    );
    // LA LISTE DE L'AGENT DE META (migration 0195) : la personne y est chez ce client ET chez le voisin. Seule la
    // ligne de ce client doit partir, et elle doit être RENDUE : l'entrée chez Meta ne se retire qu'avec elle.
    await pool.query(
      `insert into mba_liste (tenant_id, wa_id, phone_number_id, entree_id)
       values ($1, $2, 'itest-pn-purge', 'itest-entree-purge'), ($3, $2, 'itest-pn-voisin', 'itest-entree-voisin')`,
      [tenantId, WA_ID, autreTenantId],
    );
    // ANCRE : les deux données existent AVANT la purge. Sans elle, les assertions d'absence plus bas
    // passeraient à vide sur une insertion ratée.
    const avant = await pool.query<{ v: unknown; e: number }>(
      `select (select variables from campaign_recipients where contact_id = $1) as v,
              (select count(*)::int from echecs_messages where tenant_id = $2 and wa_id = $3) as e`,
      [contactId, tenantId, WA_ID],
    );
    expect(avant.rows[0]).toEqual({ v: { commande: '8412' }, e: 1 });
    const fiche = await pool.query(
      `select tags, risque_niveau, langue_detectee, whatsapp_joignable, opt_in_source, blocked_by, analyse_intention
         from contacts where id = $1`,
      [contactId],
    );
    expect(fiche.rows[0]).toEqual({
      tags: ['vip', 'mauvais payeur'], risque_niveau: 'eleve', langue_detectee: 'en', whatsapp_joignable: false,
      opt_in_source: 'formulaire de Jean Dupont', blocked_by: bloqueurId, analyse_intention: 'reclamation',
    });
  });

  afterAll(async () => {
    // `webhook_events` ne dépend d'aucun tenant en cascade (c'est tout le sujet) : on l'efface par ses ids.
    await pool.query(`delete from webhook_events where meta_message_id like 'wam-itest-ev-%'`);
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.query(`delete from rcs_capabilities_cache where agent_id = $1`, ['itest-agent']);
    await pool.end();
  });

  it('🔴 la conversation et ses messages sont RÉELLEMENT effacés (wa_id sans « + » vs E.164)', async () => {
    const res = await store.purgeMany(tenantId, [contactId]);
    expect(res).toMatchObject({ purges: 1, conversations: 1, messages: 2 });
    // La ligne de la liste de l'agent est rendue, pour que la route la retire chez Meta après la transaction.
    expect(res.listeAgent).toEqual([{ waId: WA_ID, phoneNumberId: 'itest-pn-purge', entreeId: 'itest-entree-purge' }]);

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
    const row = (await pool.query<{ phone_e164: string; profile_name: string | null; fields: unknown; anonymized_at: Date | null; external_id: string | null }>(
      'select phone_e164, profile_name, fields, anonymized_at, external_id from contacts where id = $1', [contactId],
    )).rows[0]!;
    expect(row.phone_e164.startsWith('anon:')).toBe(true);
    expect(row.phone_e164).not.toContain('600000901');
    expect(row.profile_name).toBeNull();
    expect(row.fields).toEqual({});
    expect(row.anonymized_at).not.toBeNull();
    expect(row.external_id).toBeNull();
    // La dernière analyse recopiée part ENTIÈRE (0196) : aucune colonne ne survit, lien compris.
    const analyse = (await pool.query<Record<string, unknown>>(
      `select analyse_intention, analyse_sentiment, analyse_satisfaction, analyse_urgence, analyse_resolue, analyse_sujet,
              analyse_traitee_par, analyse_action, analyse_le, analyse_fenetre_fin, analyse_conversation_id
         from contacts where id = $1`, [contactId],
    )).rows[0]!;
    expect(Object.values(analyse).every((v) => v === null), JSON.stringify(analyse)).toBe(true);
    // Et l'identifiant est LIBÉRÉ : une fiche neuve peut le reprendre (index unique par espace).
    const reprise = await store.creerFicheApi(tenantId, { phoneE164: '+33600000902', externalId: 'itest-ext-purge' });
    expect(reprise).not.toBe('conflit');
  });

  it('🔴 ce qui DÉCRIT la personne part : étiquettes, risque, langue, joignabilité, source du consentement, auteur du blocage', async () => {
    const r = await pool.query(
      `select tags, risque_niveau, risque_score, risque_raisons, risque_calcule_le, langue_detectee, langue_detectee_le,
              whatsapp_joignable, whatsapp_joignable_le, opt_in_source, blocked_by
         from contacts where id = $1`,
      [contactId],
    );
    expect(r.rows[0]).toEqual({
      tags: [], risque_niveau: null, risque_score: null, risque_raisons: [], risque_calcule_le: null,
      langue_detectee: null, langue_detectee_le: null, whatsapp_joignable: null, whatsapp_joignable_le: null,
      opt_in_source: null, blocked_by: null,
    });
  });

  it('🔴 ce qui dit NON reste : l’opt-out et sa date, le STOP RCS, la date du blocage (une campagne en cours les relit)', async () => {
    const r = await pool.query(
      `select opt_in_status, opt_out_at is not null as opt_out, rcs_optout_at is not null as rcs, blocked_at is not null as bloque
         from contacts where id = $1`,
      [contactId],
    );
    expect(r.rows[0]).toEqual({ opt_in_status: 'opted_out', opt_out: true, rcs: true, bloque: true });
  });

  it('🔴 la joignabilité ne REVIENT pas : un second échec 131026 tardif ne réécrit pas la fiche purgée', async () => {
    // Le destinataire de campagne garde le `contact_id` de la fiche, et le balayage note par cet identifiant.
    await creerNoteurJoignabilite(pool)(tenantId, contactId, false);
    const r = await pool.query('select whatsapp_joignable, whatsapp_joignable_le from contacts where id = $1', [contactId]);
    expect(r.rows[0]).toEqual({ whatsapp_joignable: null, whatsapp_joignable_le: null });
  });

  it('🔴 les mesures par bloc sont ANONYMISEES, pas supprimees (le quanti survit a l’effacement)', async () => {
    // Les supprimer laisserait un trou dans tout tableau deja construit. La decision produit est « on
    // anonymise pour garder le quanti » : la ligne reste, le numero part.
    const restantes = await pool.query<{ wa_id: string }>(
      'select wa_id from workflow_node_events where tenant_id = $1 and node_id = $2', [tenantId, 'n1'],
    );
    expect(restantes.rowCount).toBe(1);
    expect(restantes.rows[0]!.wa_id).toBe('anonyme');
    expect(restantes.rows[0]!.wa_id).not.toContain('600000901');
  });

  it('🔴 l’arrivée publicitaire RESTE, son ctwa_clid PART (le compte survit, l’identifiant du clic non)', async () => {
    const r = await pool.query<{ ctwa_clid: string | null }>(
      'select ctwa_clid from arrivees_pub where tenant_id = $1 and contact_id = $2', [tenantId, contactId],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.ctwa_clid).toBeNull();
  });

  it('🔴 les VARIABLES du destinataire partent (migration 0174), la ligne de campagne reste', async () => {
    const r = await pool.query<{ to_e164: string; variables: unknown }>(
      'select to_e164, variables from campaign_recipients where contact_id = $1', [contactId],
    );
    expect(r.rows).toEqual([{ to_e164: 'anonyme', variables: null }]);
  });

  it('🔴 l’échec d’un message libre de la personne est effacé, pas celui d’un autre espace (migration 0175)', async () => {
    const r = await pool.query<{ tenant_id: string }>('select tenant_id from echecs_messages where wa_id = $1', [WA_ID]);
    expect(r.rows.map((x) => x.tenant_id)).toEqual([autreTenantId]);
  });

  /**
   * `webhook_events` garde le payload BRUT de Meta : le texte du message entrant et le numéro de qui l'écrit.
   * C'était la DERNIÈRE table du dépôt à garder une trace nominative hors de portée de cette purge, faute de
   * discriminant d'espace (PLAN.md 5.2, fermé par la migration 0093).
   */
  it('🔴 les événements Meta bruts de la personne sont effacés (message ENTRANT et statut de livraison)', async () => {
    const restants = await pool.query<{ meta_message_id: string }>(
      `select meta_message_id from webhook_events where phone_number_id = 'itest-pn-purge'`,
    );
    expect(restants.rowCount).toBe(0);
  });

  it('🔴 mais PAS ceux d’un autre espace, même pour la même personne (cloisonnement)', async () => {
    // La même personne peut écrire à deux de nos clients. Purger chez l'un ne doit pas toucher au journal de
    // l'autre : sans le filtre par numéro destinataire, l'effacement se ferait par wa_id, donc partout.
    const voisin = await pool.query(`select 1 from webhook_events where phone_number_id = 'itest-pn-voisin'`);
    expect(voisin.rowCount).toBe(1);
  });

  it('🔴 la ligne de la liste de l’agent part, pas celle d’un autre espace (migration 0195)', async () => {
    const r = await pool.query<{ tenant_id: string }>('select tenant_id from mba_liste where wa_id = $1', [WA_ID]);
    expect(r.rows.map((x) => x.tenant_id)).toEqual([autreTenantId]);
  });

  it('purger deux fois ne compte pas deux fois (anonymized_at fait garde)', async () => {
    expect((await store.purgeMany(tenantId, [contactId])).purges).toBe(0);
  });

  /**
   * 🔴 UNE PURGE PENDANT UN RUN DE CAMPAGNE. Le run tient la liste lue à son début, VRAI numéro compris, et la
   * réclamation relit la fiche juste avant d'envoyer. Une fiche ni désabonnée ni bloquée (celle du haut porte un
   * STOP, elle ne prouverait rien ici) partait quand même, après l'effacement demandé. Et une ligne purgée en
   * échec était reprise par les balayages : le second 131026 envoyait `anonyme` à HubSpot.
   */
  it('🔴 une fiche purgée pendant un run est ÉCARTÉE à la réclamation, et les balayages de relance ne la reprennent plus', async () => {
    const repo = new PgCampaignRepo(pool);
    const recipients = new PgRecipientStore(pool);
    const fiche = async (tel: string): Promise<string> => (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`, [tenantId, tel],
    )).rows[0]!.id;
    const purgee = await fiche('+33600000911');
    const temoin = await fiche('+33600000912');
    const campagne = async (nom: string): Promise<string> => {
      const id = await repo.insertCampaign({
        tenantId, phoneNumberId: 'itest-pn-purge', name: nom, category: 'marketing', templateName: 't',
        templateLanguage: 'fr', paramMapping: [], reessayer: true,
      });
      await repo.insertRecipients(id, [
        { contactId: purgee, toE164: '+33600000911', resolvedParams: [] },
        { contactId: temoin, toE164: '+33600000912', resolvedParams: [] },
      ]);
      return id;
    };
    const simple = await campagne('itest-purge-en-cours');
    const chainee = await campagne('itest-purge-repli');
    await pool.query(`insert into campaign_etages (campaign_id, rang, canal) values ($1, 2, 'rcs')`, [chainee]);

    // Le run lit sa liste AVANT la purge : c'est tout le cas.
    const liste = new Map((await recipients.listPending(simple)).map((p) => [p.contactId, p]));
    expect(liste.get(purgee)?.toE164).toBe('+33600000911');
    expect((await store.purgeMany(tenantId, [purgee])).purges).toBe(1);

    expect(await recipients.claim(liste.get(purgee)!.id)).toEqual({ ecart: 'efface' });
    // Le témoin part : l'écart vise la purge, pas la campagne.
    expect(await recipients.claim(liste.get(temoin)!.id)).toBe(true);

    // Second échec 131026 sur la campagne sans repli, échec sur la campagne à repli : seul le témoin est repris.
    await pool.query(
      `update campaign_recipients set status = 'failed', error_code = 131026, retry_count = 1 where campaign_id = $1`, [simple],
    );
    await pool.query(
      `update campaign_recipients set status = 'failed', error_code = 131026, retry_count = 0 where campaign_id = $1`, [chainee],
    );
    const de = (lignes: Array<{ campaignId: string; contactId: string }>, campagneId: string): string[] =>
      lignes.filter((l) => l.campaignId === campagneId).map((l) => l.contactId);
    expect(de(await repo.listRetry131026SecondFail(), simple)).toEqual([temoin]);
    expect(de(await repo.listCandidatsBascule(), chainee)).toEqual([temoin]);
  });
});
