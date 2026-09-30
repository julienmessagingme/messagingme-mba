import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgConversationAnalysisStore } from '../../src/analysis/store.pg';
import { PgInboxStore } from '../../src/inbox/store.pg';
import type { ConversationAnalysis } from '../../src/analysis/schema';

const url = process.env.DATABASE_URL ?? '';

// Pièce 1 : réclamation atomique + fenêtre d'analyse + réouverture. Nécessite la migration 0027.
describe.skipIf(!url)('PgConversationAnalysisStore (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-analysis') returning id`)).rows[0]!.id;
    userId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'agent-itest-analysis@x.fr', 'agent', 'x') returning id`, [tenantId])).rows[0]!.id;
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const insertConv = async (waId: string, o: { ageMin?: number; status?: string; queuedAgeMin?: number } = {}): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, last_preview, analysis_status, analysis_queued_at)
       values ($1, $2, now() - make_interval(mins => $3), 'x', $4, case when $5::int is null then null else now() - make_interval(mins => $5) end)
       returning id`,
      [tenantId, waId, o.ageMin ?? 0, o.status ?? 'pending', o.queuedAgeMin ?? null],
    )).rows[0]!.id;

  it('claimForAnalysis : réclame le pending inactif, PAS le frais ni le done ; passe en queued', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const oldPending = await insertConv('33600100001', { ageMin: 60, status: 'pending' });
    const fresh = await insertConv('33600100002', { ageMin: 0, status: 'pending' });
    const done = await insertConv('33600100003', { ageMin: 60, status: 'done' });

    const claimed = await store.claimForAnalysis(25 * 60 * 1000, 100);
    const ids = claimed.map((c) => c.conversationId);
    expect(ids).toContain(oldPending);
    expect(ids).not.toContain(fresh);
    expect(ids).not.toContain(done);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [oldPending])).rows[0]!.analysis_status;
    expect(status).toBe('queued');
  });

  it('reclaimStaleQueued : ramène un queued bloqué en pending', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const stuck = await insertConv('33600100010', { status: 'queued', queuedAgeMin: 60 });
    const n = await store.reclaimStaleQueued(15 * 60 * 1000);
    expect(n).toBeGreaterThanOrEqual(1);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [stuck])).rows[0]!.analysis_status;
    expect(status).toBe('pending');
  });

  it('reclaimQueued : relâche UNE conversation queued en pending', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const stuck = await insertConv('33600100012', { status: 'queued', queuedAgeMin: 0 }); // fraîche : reclaimStaleQueued NE la prendrait pas
    await store.reclaimQueued(stuck);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [stuck])).rows[0]!.analysis_status;
    expect(status).toBe('pending');
  });

  it('reclaimQueued : ne piétine pas une conversation qui n\'est plus queued (garde)', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const done = await insertConv('33600100013', { status: 'done' });
    await store.reclaimQueued(done);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [done])).rows[0]!.analysis_status;
    expect(status).toBe('done'); // garde sur analysis_status='queued' -> le done reste done
  });

  it('getContext : messages + signaux (humain = sortant avec sender ; automatisé = sortant sans)', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100020');
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1,'in','text','Bonjour')`, [conv]);
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, sender_user_id) values ($1,'out','template','Promo', null)`, [conv]); // automatisé
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, sender_user_id) values ($1,'out','text','Réponse', $2)`, [conv, userId]); // humain
    const ctx = await store.getContext(conv);
    expect(ctx).not.toBeNull();
    expect(ctx!.messages).toHaveLength(3);
    expect(ctx!.signals).toEqual({ hasHumanOutbound: true });
  });

  it('getContext : conversation inexistante -> null', async () => {
    const store = new PgConversationAnalysisStore(pool);
    expect(await store.getContext('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('save : upsert conversation_analysis + conversation done/analyzed_at', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100030', { status: 'queued' });
    const a: ConversationAnalysis = {
      sentiment: 'positif', intent: 'demande_devis', topic: 'devis', resolved: false, entities: { quantite: 50 },
      action_suggestion: 'creer_devis', confidence: 0.9, justification: 'veut un devis', handled_by: 'humain', exchanges_count: 3, abusive: false,
    };
    await store.save(conv, tenantId, a, { provider: 'anthropic', model: 'claude-haiku-4-5' }, new Date().toISOString());
    const row = (await pool.query<{ intent: string; handled_by: string; llm_model: string }>(`select intent, handled_by, llm_model from conversation_analysis where conversation_id = $1`, [conv])).rows[0]!;
    expect(row).toMatchObject({ intent: 'demande_devis', handled_by: 'humain', llm_model: 'claude-haiku-4-5' });
    const convRow = (await pool.query<{ analysis_status: string; analyzed_at: Date | null }>(`select analysis_status, analyzed_at from conversations where id = $1`, [conv])).rows[0]!;
    expect(convRow.analysis_status).toBe('done'); // aucun message plus récent -> done
    expect(convRow.analyzed_at).not.toBeNull();
    // Upsert : une 2e sauvegarde remplace, pas de doublon.
    await store.save(conv, tenantId, { ...a, intent: 'sav' }, { provider: 'anthropic', model: 'm2' }, new Date().toISOString());
    const cnt = (await pool.query<{ n: string }>(`select count(*)::int as n from conversation_analysis where conversation_id = $1`, [conv])).rows[0]!.n;
    expect(Number(cnt)).toBe(1);
  });

  it('🔴 save : le RÉSUMÉ fait l’aller-retour, et une absence reste NULL (migration 0100)', async () => {
    // Aller-retour contre une vraie base : c'est le seul test qui prouve que la colonne existe, que le
    // paramètre tombe dans la BONNE colonne de l'INSERT (elle a été ajoutée en 16e position d'une liste
    // déjà longue) et que l'upsert la remplace. Un test unitaire sur une fausse `pool` ne verrait rien de
    // tout ça, et l'écran afficherait « pas de résumé » sur des analyses qui en ont un.
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100099', { status: 'queued' });
    const base: ConversationAnalysis = {
      sentiment: 'neutre', intent: 'information', topic: 'facture', resolved: true, entities: {},
      action_suggestion: 'aucune', confidence: 0.7, justification: 'question réglée', handled_by: 'automatise', exchanges_count: 2, abusive: false,
    };
    const lire = async (): Promise<string | null> =>
      (await pool.query<{ summary: string | null }>(`select summary from conversation_analysis where conversation_id = $1`, [conv])).rows[0]!.summary;

    await store.save(conv, tenantId, { ...base, summary: 'Le client demande sa facture, elle lui a été renvoyée.' }, { provider: 'anthropic', model: 'm' }, new Date().toISOString());
    expect(await lire()).toBe('Le client demande sa facture, elle lui a été renvoyée.');

    // Un modèle qui ne rend pas de résumé laisse NULL, pas une chaîne vide : la fiche ne dit pas la même
    // chose des deux, et un « » affiché comme un résumé serait pire qu'un repli assumé.
    await store.save(conv, tenantId, base, { provider: 'anthropic', model: 'm' }, new Date().toISOString());
    expect(await lire()).toBeNull();

    // Et un résumé fait QUE d'espaces vaut aussi absence : c'est la même règle, posée à l'écriture.
    await store.save(conv, tenantId, { ...base, summary: '   ' }, { provider: 'anthropic', model: 'm' }, new Date().toISOString());
    expect(await lire()).toBeNull();
  });

  it('🔴 save : les deux NOTES font l’aller-retour, et 0 ne se confond pas avec l’absence (migration 0121)', async () => {
    // Même exigence que le résumé juste au-dessus, et pour une raison plus grave : ici l'absence et le zéro
    // sont deux valeurs LÉGITIMES qui se ressemblent. `0` veut dire « client très mécontent » (le coin du
    // nuage qui alarme), `null` veut dire « cette analyse n'a pas de mesure ». Un `?? 0` posé n'importe où
    // sur ce chemin ferait apparaître tout l'historique dans ce coin ; un `|| null` ferait disparaître les
    // vrais zéros. Seul un aller-retour contre une vraie base sépare les deux, et prouve au passage que les
    // deux paramètres tombent dans les BONNES colonnes d'un INSERT qui en compte désormais dix-huit.
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100098', { status: 'queued' });
    const base: ConversationAnalysis = {
      sentiment: 'negatif', intent: 'reclamation', topic: 'retard', resolved: false, entities: {},
      action_suggestion: 'escalader', confidence: 0.8, justification: 'client presse', handled_by: 'humain', exchanges_count: 4, abusive: false,
    };
    const lire = async (): Promise<{ satisfaction: number | null; urgence: number | null }> =>
      (await pool.query<{ satisfaction: number | null; urgence: number | null }>(
        `select satisfaction, urgence from conversation_analysis where conversation_id = $1`, [conv])).rows[0]!;

    await store.save(conv, tenantId, { ...base, satisfaction: 0, urgence: 10 }, { provider: 'anthropic', model: 'm' }, new Date().toISOString());
    expect(await lire()).toEqual({ satisfaction: 0, urgence: 10 });

    // Le modèle ne les a pas rendues (le schéma le tolère exprès) -> NULL, et l'upsert doit EFFACER les
    // valeurs précédentes, sinon une réanalyse muette laisserait en place des notes qui ne sont plus dites.
    await store.save(conv, tenantId, base, { provider: 'anthropic', model: 'm' }, new Date().toISOString());
    expect(await lire()).toEqual({ satisfaction: null, urgence: null });

    // La borne haute est tenue EN BASE aussi (CHECK de la 0121), pas seulement par le schéma Zod : une
    // écriture par un autre chemin ne pourrait pas y glisser une note hors échelle.
    await expect(
      pool.query(`update conversation_analysis set satisfaction = 11 where conversation_id = $1`, [conv]),
    ).rejects.toThrow();
  });

  it('save : un message postérieur à la borne repasse la conversation en pending (course d\'analyse)', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100035', { status: 'queued' });
    // message arrivé PENDANT l'analyse (created_at = maintenant), donc postérieur à la borne passée à save
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1,'in','text','arrivé pendant analyse')`, [conv]);
    const windowEnd = new Date(Date.now() - 60_000).toISOString(); // borne = il y a 1 min (avant l'insertion du message)
    const a: ConversationAnalysis = {
      sentiment: 'neutre', intent: 'information', topic: 'x', resolved: true, entities: {},
      action_suggestion: 'aucune', confidence: 0.5, justification: 'x', handled_by: 'automatise', exchanges_count: 0, abusive: false,
    };
    await store.save(conv, tenantId, a, { provider: 'anthropic', model: 'm' }, windowEnd);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [conv])).rows[0]!.analysis_status;
    expect(status).toBe('pending'); // repris au prochain sweep au lieu d'être enterré sous une borne now()
  });

  it('save : borne = created_at MICROSECONDE exact du dernier message -> done, PAS de boucle de réanalyse', async () => {
    // Régression : un round-trip created_at via Date JS tronque aux ms -> la borne retombe sous le dernier message
    // (µs non nuls) qui repasse `> borne` -> réanalyse en boucle. windowEnd doit être la chaîne texte exacte.
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100037', { status: 'queued' });
    // created_at avec des microsecondes NON nulles (le cas qui piégeait la version Date)
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1,'in','text','micros', '2026-07-12 14:04:28.611789+00')`, [conv]);
    const ctx = await store.getContext(conv);
    expect(ctx!.windowEnd).not.toBeNull();
    const a: ConversationAnalysis = {
      sentiment: 'neutre', intent: 'information', topic: 'x', resolved: true, entities: {},
      action_suggestion: 'aucune', confidence: 0.5, justification: 'x', handled_by: 'automatise', exchanges_count: 1, abusive: false,
    };
    await store.save(conv, tenantId, a, { provider: 'anthropic', model: 'm' }, ctx!.windowEnd ?? null);
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where id = $1`, [conv])).rows[0]!.analysis_status;
    expect(status).toBe('done'); // borne µs-exacte : le dernier message n'est PAS > borne
  });

  it('getStored : relit l\'analyse courante (mapping camelCase + jsonb), null si absente (F3-a)', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100050', { status: 'queued' });
    const a: ConversationAnalysis = {
      sentiment: 'negatif', intent: 'reclamation', topic: 'retard', resolved: false, entities: { ref: 'X' },
      action_suggestion: 'escalader', confidence: 0.75, justification: 'client mécontent', handled_by: 'humain', exchanges_count: 4, abusive: false,
    };
    await store.save(conv, tenantId, a, { provider: 'anthropic', model: 'm' }, new Date().toISOString());
    const stored = await store.getStored(conv);
    expect(stored).toMatchObject({ conversationId: conv, tenantId, sentiment: 'negatif', intent: 'reclamation', action_suggestion: 'escalader', handled_by: 'humain', exchanges_count: 4, abusive: false });
    expect(stored!.confidence).toBeCloseTo(0.75);
    expect(stored!.entities).toEqual({ ref: 'X' });
    expect(await store.getStored('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('pending_catchup : markPendingCatchup (inconditionnel) + list + clear ; listTenantsReadyForCatchup exige un numéro reconnecté (F3-a)', async () => {
    const store = new PgConversationAnalysisStore(pool);
    const conv = await insertConv('33600100061', { status: 'queued' });
    const a: ConversationAnalysis = {
      sentiment: 'neutre', intent: 'information', topic: 'x', resolved: true, entities: {},
      action_suggestion: 'aucune', confidence: 0.5, justification: 'x', handled_by: 'automatise', exchanges_count: 1, abusive: false,
    };
    await store.save(conv, tenantId, a, { provider: 'anthropic', model: 'm' }, new Date().toISOString());
    expect(await store.listConversationIdsPendingCatchup(tenantId)).not.toContain(conv);
    // Marque inconditionnelle (la décision « en pause ? » est prise en amont par le push-job sur son snapshot).
    await store.markPendingCatchup(conv);
    expect(await store.listConversationIdsPendingCatchup(tenantId)).toContain(conv);
    // listTenantsReadyForCatchup : SANS numéro connecté, le tenant n'est PAS prêt (ses marques attendent la reprise).
    expect(await store.listTenantsReadyForCatchup()).not.toContain(tenantId);
    // Avec un numéro RECONNECTÉ, le tenant devient prêt (le sweep le rattrapera).
    await pool.query(`insert into waba (id, tenant_id, name) values ($1,$2,'w') on conflict (id) do nothing`, ['waba-catchup', tenantId]);
    await pool.query(`insert into phone_numbers (id, waba_id, tenant_id, display_phone_number, hubspot_connected) values ('pn-catchup','waba-catchup',$1,'+33600100061',true)`, [tenantId]);
    expect(await store.listTenantsReadyForCatchup()).toContain(tenantId);
    // clear -> plus de marque, plus prêt.
    await store.clearPendingCatchup(conv);
    expect(await store.listConversationIdsPendingCatchup(tenantId)).not.toContain(conv);
    expect(await store.listTenantsReadyForCatchup()).not.toContain(tenantId);
  });

  it('réouverture : un nouvel inbound sur une conversation done repasse en pending', async () => {
    const inbox = new PgInboxStore(pool);
    const waId = '33600100040';
    await insertConv(waId, { status: 'done' });
    await inbox.recordInbound(tenantId, { waId, phoneNumberId: 'pn', body: 'Encore une question', type: 'text', buttonPayload: null, messageId: 'wamid-REOPEN', profileName: null, field: 'messages' });
    const status = (await pool.query<{ analysis_status: string }>(`select analysis_status from conversations where tenant_id = $1 and wa_id = $2`, [tenantId, waId])).rows[0]!.analysis_status;
    expect(status).toBe('pending');
  });
});

// Tout sur la fiche, lot 1 : la copie de l'analyse sur la fiche du contact (migration 0196).
describe.skipIf(!url)('save recopie l’analyse sur la fiche (Postgres)', () => {
  let pool: Pool;
  let store: PgConversationAnalysisStore;
  let tenantId: string;
  let autreTenantId: string;

  const modele = { provider: 'anthropic', model: 'm' };
  const base: ConversationAnalysis = {
    sentiment: 'negatif', intent: 'reclamation', topic: 'retard de livraison', resolved: false, entities: {},
    action_suggestion: 'rappeler', confidence: 0.8, justification: 'client mécontent', handled_by: 'humain',
    exchanges_count: 3, abusive: false, satisfaction: 0, urgence: 8,
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgConversationAnalysisStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-fiche-analyse') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-fiche-analyse-autre') returning id`)).rows[0]!.id;
  });
  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  const contact = async (t: string, o: { phone?: string | null; bsuid?: string | null; supprime?: boolean }): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, bsuid, deleted_at) values ($1, $2, $3, case when $4 then now() else null end) returning id`,
      [t, o.phone ?? null, o.bsuid ?? null, o.supprime === true],
    )).rows[0]!.id;
  const fil = async (t: string, waId: string, contactId: string | null = null): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, analysis_status) values ($1, $2, $3, 'queued') returning id`,
      [t, waId, contactId],
    )).rows[0]!.id;
  const fiche = async (id: string) =>
    (await pool.query<Record<string, unknown>>(
      `select analyse_intention, analyse_sentiment, analyse_satisfaction, analyse_urgence, analyse_resolue, analyse_sujet,
              analyse_traitee_par, analyse_action, analyse_le, analyse_fenetre_fin, analyse_conversation_id
         from contacts where id = $1`, [id],
    )).rows[0]!;

  it('🔴 un fil sans contact_id trouve la fiche par le numéro, et une note à 0 reste 0', async () => {
    const c = await contact(tenantId, { phone: '+33600100201' });
    const conv = await fil(tenantId, '33600100201');
    const copie = await store.save(conv, tenantId, base, modele, '2026-09-30 10:00:00.000001+00');
    expect(copie).toMatchObject({ contactId: c, waId: '33600100201', avant: null });
    expect(copie!.apres).toMatchObject({ intention: 'reclamation', sentiment: 'negatif', satisfaction: 0, urgence: 8, resolue: false, sujet: 'retard de livraison', traiteePar: 'humain', action: 'rappeler', conversationId: conv });
    expect(await fiche(c)).toMatchObject({
      analyse_intention: 'reclamation', analyse_sentiment: 'negatif', analyse_satisfaction: 0, analyse_urgence: 8,
      analyse_resolue: false, analyse_sujet: 'retard de livraison', analyse_traitee_par: 'humain', analyse_action: 'rappeler',
      analyse_conversation_id: conv,
    });
  });

  it('une note absente reste null, jamais 0', async () => {
    const c = await contact(tenantId, { phone: '+33600100202' });
    const conv = await fil(tenantId, '33600100202');
    await store.save(conv, tenantId, { ...base, satisfaction: undefined, urgence: undefined }, modele, '2026-09-30 10:00:00+00');
    expect(await fiche(c)).toMatchObject({ analyse_satisfaction: null, analyse_urgence: null, analyse_intention: 'reclamation' });
  });

  it('🔴 le contact désigné supprimé : la copie va à la fiche active qui porte l’identité du fil', async () => {
    const supprime = await contact(tenantId, { phone: '+33600100203', supprime: true });
    const actif = await contact(tenantId, { bsuid: 'itest-bsuid-203' });
    const conv = await fil(tenantId, 'itest-bsuid-203', supprime);
    const copie = await store.save(conv, tenantId, base, modele, '2026-09-30 10:00:00+00');
    expect(copie?.contactId).toBe(actif);
    expect((await fiche(supprime)).analyse_le).toBeNull();
    expect((await fiche(actif)).analyse_intention).toBe('reclamation');
  });

  it('🔴 une vieille fenêtre n’écrase pas une analyse plus récente, d’un autre fil du même contact', async () => {
    const c = await contact(tenantId, { phone: '+33600100204', bsuid: 'itest-bsuid-204' });
    const recent = await fil(tenantId, '33600100204', c);
    const ancien = await fil(tenantId, 'itest-bsuid-204', c);
    await store.save(recent, tenantId, base, modele, '2026-09-30 12:00:00+00');
    const copie = await store.save(ancien, tenantId, { ...base, sentiment: 'positif', intent: 'achat' }, modele, '2026-09-30 11:00:00+00');
    expect(copie).toBeNull();
    expect(await fiche(c)).toMatchObject({ analyse_sentiment: 'negatif', analyse_intention: 'reclamation', analyse_conversation_id: recent });
  });

  it('🔴 la fenêtre suivante remplace, et rend l’ancienne copie dans « avant »', async () => {
    const c = await contact(tenantId, { phone: '+33600100205' });
    const conv = await fil(tenantId, '33600100205');
    await store.save(conv, tenantId, { ...base, sentiment: 'positif' }, modele, '2026-09-30 10:00:00+00');
    const copie = await store.save(conv, tenantId, base, modele, '2026-09-30 11:00:00+00');
    expect(copie!.avant).toMatchObject({ sentiment: 'positif' });
    expect(copie!.apres).toMatchObject({ sentiment: 'negatif' });
  });

  it('un rejeu du même job réécrit la même copie : « avant » vaut « après »', async () => {
    const c = await contact(tenantId, { phone: '+33600100206' });
    const conv = await fil(tenantId, '33600100206');
    const fenetre = '2026-09-30 10:00:00.123456+00';
    await store.save(conv, tenantId, base, modele, fenetre);
    const copie = await store.save(conv, tenantId, base, modele, fenetre);
    expect(copie?.contactId).toBe(c);
    expect(copie!.avant).toMatchObject({ sentiment: 'negatif', intention: 'reclamation', satisfaction: 0 });
  });

  it('🔴 une fiche supprimée ne reçoit rien, et l’analyse est quand même enregistrée', async () => {
    const c = await contact(tenantId, { phone: '+33600100207', supprime: true });
    const conv = await fil(tenantId, '33600100207');
    expect(await store.save(conv, tenantId, base, modele, '2026-09-30 10:00:00+00')).toBeNull();
    expect((await fiche(c)).analyse_le).toBeNull();
    const n = (await pool.query<{ n: number }>(`select count(*)::int as n from conversation_analysis where conversation_id = $1`, [conv])).rows[0]!.n;
    expect(n).toBe(1);
  });

  it('🔴 la fiche d’un autre espace, au même numéro, n’est jamais écrite', async () => {
    const ailleurs = await contact(autreTenantId, { phone: '+33600100208' });
    const conv = await fil(tenantId, '33600100208');
    expect(await store.save(conv, tenantId, base, modele, '2026-09-30 10:00:00+00')).toBeNull();
    expect((await fiche(ailleurs)).analyse_le).toBeNull();
  });

  it('🔴 la conversation effacée : les codes RESTENT sur la fiche, seul le lien retombe à null', async () => {
    const c = await contact(tenantId, { phone: '+33600100209' });
    const conv = await fil(tenantId, '33600100209');
    await store.save(conv, tenantId, base, modele, '2026-09-30 10:00:00+00');
    await pool.query(`delete from conversations where id = $1`, [conv]);
    expect(await fiche(c)).toMatchObject({ analyse_intention: 'reclamation', analyse_sentiment: 'negatif', analyse_conversation_id: null });
  });

  it('la cohérence est tenue en base : une copie partielle est refusée', async () => {
    const c = await contact(tenantId, { phone: '+33600100210' });
    await expect(pool.query(`update contacts set analyse_intention = 'sav' where id = $1`, [c])).rejects.toThrow();
  });
});
