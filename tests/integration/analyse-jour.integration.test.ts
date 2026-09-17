import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgConversationStatsStore } from '../../src/stats/conversation-stats.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES AGREGATS JOURNALIERS, EXECUTES POUR DE VRAI (migration 0155).
 *
 * 🔴 POURQUOI EN INTEGRATION, ET CE QUE `tests/agregats-jour.test.ts` NE PEUT PAS FAIRE. Celui-la relit le
 * TEXTE du source : il verifie que le fragment SQL est cite et pas recopie, ce qui garantit que les deux
 * lectures ne DIVERGERONT pas. Il ne peut rien dire de leur JUSTESSE, puisqu'il n'execute aucune requete.
 * Or l'ecriture des agregats est la contrepartie de la seule operation irreversible du depot : une jointure
 * fausse, un `on conflict` qui n'ecrase pas les bonnes colonnes, un filtre de travers, et on garde pour
 * toujours un historique faux a la place de l'historique vrai. Releve en revue le 2026-09-17 (« la seule
 * verification numerique est manuelle et non repetable »).
 *
 * Jamais joue en local (le DATABASE_URL local pointe la PRODUCTION), joue par le job `integration`.
 */
describe.skipIf(!url)('agregats journaliers (Postgres)', () => {
  let pool: Pool;
  let store: PgConversationStatsStore;
  let tenantId: string;
  const JOUR = '2026-03-05';

  /** Une analyse posee a une heure SURE du jour choisi, fuseau Europe/Paris (12 h : jamais un bord). */
  const analyse = async (suffixe: string, satisfaction: number | null, urgence: number | null, intent: string): Promise<void> => {
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, $2, now()) returning id`,
      [tenantId, `3360000${suffixe}`],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
         exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model,
         satisfaction, urgence, created_at)
       values ($1, $2, 'neutre', $3, 'un sujet', true, 'humain', 2, 'aucune', 0.8, 'parce que', 'itest', 'itest',
               $4, $5, ($6::date + time '12:00') at time zone 'Europe/Paris')`,
      [conv, tenantId, intent, satisfaction, urgence, JOUR],
    );
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgConversationStatsStore(pool, true, 90);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-analyse-jour') returning id`)).rows[0]!.id;

    // Trois analyses le meme jour : DEUX mesurees (8 et 2), UNE sans note. La moyenne juste est donc 5,
    // celle du piege serait 3,33 (somme / conversations au lieu de somme / mesurees).
    await analyse('00901', 8, 4, 'demande_devis');
    await analyse('00902', 2, 6, 'demande_devis');
    await analyse('00903', null, null, 'sav');
  });

  afterAll(async () => {
    // `analyse_jour.tenant_id` porte un `on delete cascade` (migration 0155) : effacer l'espace emporte ses
    // agregats. On ne fait donc PAS de menage separe, ce serait affirmer qu'il en faut un alors que non.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const plage = { from: JOUR, to: JOUR };

  it('🔴 la lecture DIRECTE compte les mesurees a part, et la moyenne est ponderee par elles', async () => {
    const [j] = await store.parJour(tenantId, plage);
    expect(j).toBeDefined();
    expect(j!.conversations, 'les trois analyses du jour').toBe(3);
    expect(j!.mesurees, 'seules deux portent une note').toBe(2);
    // (8 + 2) / 2 = 5. Diviser par `conversations` donnerait 3,33 : c'est le piege que la migration nomme.
    expect(j!.satisfaction).toBeCloseTo(5, 6);
    expect(j!.urgence).toBeCloseTo(5, 6);
  });

  it('🔴 l AGREGAT ECRIT rend EXACTEMENT ce que la lecture directe rend', async () => {
    /**
     * C'est la propriete qui autorise a effacer les conversations : tant que les deux concordent, la
     * frontiere de la retention ne fait aucune MARCHE dans le graphe. Une divergence d'une unite serait
     * indiscernable d'un vrai creux d'activite, et personne ne saurait laquelle des deux a raison.
     */
    const ecrites = await store.ecrireAgregats(plage, tenantId);
    expect(ecrites, 'une journee ecrite').toBe(1);

    const direct = await store.parJour(tenantId, plage);
    const agrege = await store.parJourAgrege(tenantId, plage);
    expect(agrege).toEqual(direct);
  });

  it('🔴 rejouer le balayage ne duplique pas et ne fausse pas : il MET A JOUR', async () => {
    // Le balayage repasse chaque nuit sur les memes journees. Sans `on conflict do update`, il echouerait
    // sur la cle primaire ; avec un `do nothing`, une journee qui recoit une analyse de plus resterait
    // figee sur son ancien compte pour toujours.
    await store.ecrireAgregats(plage, tenantId);
    await store.ecrireAgregats(plage, tenantId);
    const lignes = await pool.query<{ n: string }>(
      'select count(*)::text as n from analyse_jour where tenant_id = $1 and jour = $2::date', [tenantId, JOUR],
    );
    expect(lignes.rows[0]!.n, 'une seule ligne par (espace, jour)').toBe('1');
    expect(await store.parJourAgrege(tenantId, plage)).toEqual(await store.parJour(tenantId, plage));
  });

  it('🔴 une analyse ajoutee APRES coup est reprise au passage suivant', async () => {
    // La journee courante recoit des analyses toute la journee : un agregat fige au premier passage
    // sous-compterait la journee en cours, et ce sous-compte deviendrait definitif a la purge.
    await analyse('00904', 10, 10, 'sav');
    await store.ecrireAgregats(plage, tenantId);
    const [a] = await store.parJourAgrege(tenantId, plage);
    expect(a!.conversations).toBe(4);
    expect(a!.mesurees).toBe(3);
    // (8 + 2 + 10) / 3 = 6,67
    expect(a!.satisfaction).toBeCloseTo(20 / 3, 6);
    expect(await store.parJourAgrege(tenantId, plage)).toEqual(await store.parJour(tenantId, plage));
  });

  it('🔴 la retention ANNONCEE est celle de l espace, pas celle de l instance', async () => {
    /**
     * L'ecran ecrit « Les conversations et leurs analyses sont conservees N jours ». Tant que ce N venait
     * de la constante de process, il valait 90 pour tout le monde : un espace regle sur 30 lisait 90
     * pendant que ses donnees disparaissaient a 30. C'est aussi ce test qui EXECUTE la sous-requete sur
     * `tenant_settings.conversation_retention_days` : sans base, rien ne prouve qu'elle est valide.
     */
    expect((await store.getSummary(tenantId, plage)).retentionDays,
      'aucun reglage -> le defaut d instance').toBe(90);

    await pool.query(
      `insert into tenant_settings (tenant_id, conversation_retention_days) values ($1, 30)
       on conflict (tenant_id) do update set conversation_retention_days = 30`, [tenantId],
    );
    expect((await store.getSummary(tenantId, plage)).retentionDays,
      'le reglage de l espace gagne').toBe(30);

    // Le levier d'urgence : instance a 0, l'espace garde son 30, et pourtant plus rien n'est purge.
    const instanceCoupee = new PgConversationStatsStore(pool, true, 0);
    expect((await instanceCoupee.getSummary(tenantId, plage)).retentionDays,
      'le zero d instance gagne sur le reglage de l espace').toBe(0);

    // ⚠️ ON REND L'ESPACE A SON DEFAUT : ces cas partagent un espace, et un reglage laisse en place
    // changerait le cas qu'un voisin exerce. C'est la lecon du 2026-09-17 sur la retention.
    await pool.query('update tenant_settings set conversation_retention_days = null where tenant_id = $1', [tenantId]);
  });

  it('🔴 une conversation EFFACEE ne fait pas retomber l agregat : il garde la memoire de la journee', async () => {
    /**
     * 🔴 C EST LA RAISON D ETRE DE LA TABLE, ET ELLE ETAIT DEFAITE. Le balayage recalcule chaque journee
     * depuis les analyses ENCORE PRESENTES ; la purge, elle, est bornee (500 par passage) et son seuil est
     * un INSTANT, pas une frontiere de journee civile. Toute journee traverse donc un etat partiel, pendant
     * lequel le balayage ecrasait le bon compte par le residu, puis le figeait quand la journee disparaissait
     * completement (plus aucune ligne produite, donc plus aucun `do update`). La table enregistrait le
     * contraire de ce qu'elle promet.
     *
     * Ce test reproduit exactement cette sequence : on agrege, on efface, on rejoue.
     */
    const avant = (await store.parJourAgrege(tenantId, plage))[0]!;
    expect(avant.conversations, 'les quatre analyses du jour sont agregees').toBe(4);

    // La purge efface des CONVERSATIONS ; l analyse part en cascade (migrations 0009 et 0027).
    const victime = (await pool.query<{ id: string }>(
      `select conversation_id as id from conversation_analysis where tenant_id = $1 limit 1`, [tenantId],
    )).rows[0]!.id;
    await pool.query('delete from conversations where id = $1', [victime]);
    expect((await store.parJour(tenantId, plage))[0]!.conversations,
      'la lecture DIRECTE, elle, ne voit plus que trois analyses').toBe(3);

    await store.ecrireAgregats(plage, tenantId);
    const apres = (await store.parJourAgrege(tenantId, plage))[0]!;
    expect(apres.conversations, 'l agregat garde QUATRE : il se souvient de ce qui a ete efface').toBe(4);
    expect(apres.mesurees).toBe(avant.mesurees);
    expect(apres.satisfaction).toBeCloseTo(avant.satisfaction!, 6);
  });

  it('🔴 et il remonte quand même quand la journée GROSSIT après coup', async () => {
    /**
     * L autre sens, et il compte autant : une garde « ne jamais mettre a jour » protegerait de la purge en
     * gelant aussi la journee EN COURS, qui recoit des analyses toute la journee. La garde ne doit borner
     * que le sens DESCENDANT.
     *
     * ⚠️ DEUX analyses, et pas une, parce que le test precedent en a efface une : une seule ramenerait le
     * compte vivant a QUATRE, c est-a-dire exactement le maximum deja memorise, et la mise a jour serait
     * indiscernable d un refus. Il faut DEPASSER le maximum pour prouver que la garde laisse monter.
     */
    await analyse('00905', 6, 6, 'sav');
    await analyse('00906', 4, 4, 'sav');
    await store.ecrireAgregats(plage, tenantId);
    expect((await store.parJourAgrege(tenantId, plage))[0]!.conversations,
      'trois survivantes plus deux nouvelles = cinq, au-dela des quatre memorisees').toBe(5);
  });

  it('🔴 le plus ancien jour d analyse est celui qui borne le balayage', async () => {
    // `plusAncienJourAnalyse` decide jusqu'ou le balayage remonte : si elle rendait autre chose que le vrai
    // minimum, des journees encore presentes resteraient sans agregat et disparaitraient a la purge.
    const plusAncien = await store.plusAncienJourAnalyse();
    expect(plusAncien, 'format AAAA-MM-JJ').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const min = await pool.query<{ jour: string }>(
      `select to_char(min(created_at) at time zone 'Europe/Paris', 'YYYY-MM-DD') as jour from conversation_analysis`,
    );
    expect(plusAncien).toBe(min.rows[0]!.jour);
  });
});
