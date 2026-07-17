import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { PgTemplateHintStore } from '../../src/crm/template-hints.pg';
import { PgUserStore, DuplicateEmailError } from '../../src/user/store.pg';
import { PgAuthTokenStore } from '../../src/auth/token-store.pg';
import { PgUserFieldStore } from '../../src/crm/field-store.pg';
import { PgTagStore } from '../../src/crm/tag-store.pg';
import {
  PgCampaignRepo,
  PgCampaignStore,
  PgRecipientStore,
  PgFrequencyStore,
  PgQualityProvider,
} from '../../src/campaign/store.pg';
import { PgStatsStore } from '../../src/stats/store.pg';
import { PgOpsStore } from '../../src/ops/store.pg';
import { PgWorkflowStore } from '../../src/workflow/store.pg';
import { PgWorkflowRunStore } from '../../src/workflow/run-store.pg';
import { WorkflowExecutor } from '../../src/workflow/executor';
import { PgFlowStore } from '../../src/flow/store.pg';

const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('adaptateurs Postgres (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    const res = await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-stores') returning id`,
    );
    tenantId = res.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('PgContactStore.upsertByPhone : create puis update fusionne fields, opt-in ne régresse pas', async () => {
    const store = new PgContactStore(pool);
    const phone = '+33600000001';
    const c1 = await store.upsertByPhone({ tenantId, phoneE164: phone, profileName: 'Julie', fields: { ville: 'Lyon' }, optInStatus: 'unknown' });
    expect(c1).toBe('created');
    const c2 = await store.upsertByPhone({ tenantId, phoneE164: phone, profileName: null, fields: { age: '30' }, optInStatus: 'opted_in', optInSource: 'csv_import' });
    expect(c2).toBe('updated');

    const row = (await pool.query<{ fields: Record<string, unknown>; profile_name: string; opt_in_status: string }>(
      `select fields, profile_name, opt_in_status from contacts where tenant_id = $1 and phone_e164 = $2`,
      [tenantId, phone],
    )).rows[0]!;
    expect(row.fields).toMatchObject({ ville: 'Lyon', age: '30' }); // MERGE, pas replace
    expect(row.profile_name).toBe('Julie'); // coalesce : non écrasé par null
    expect(row.opt_in_status).toBe('opted_in'); // promu, ne régresse pas
  });

  it('PgContactStore.upsertByPhone : tags fusionnés (union dédup), jamais écrasés', async () => {
    const store = new PgContactStore(pool);
    const phone = '+33600000009';
    await store.upsertByPhone({ tenantId, phoneE164: phone, profileName: 'Léa', fields: {}, optInStatus: 'opted_in', tags: ['salon-2026', 'prospect'] });
    // Ré-import avec un tag en commun + un nouveau -> union dédupliquée.
    await store.upsertByPhone({ tenantId, phoneE164: phone, profileName: null, fields: {}, optInStatus: 'unknown', tags: ['prospect', 'vip'] });
    // Ré-import SANS tags -> les tags existants sont préservés (pas d'écrasement).
    await store.upsertByPhone({ tenantId, phoneE164: phone, profileName: null, fields: { ville: 'Nice' }, optInStatus: 'unknown' });

    const rows = await store.list(tenantId);
    const lea = rows.find((r) => r.phoneE164 === phone)!;
    expect([...lea.tags].sort()).toEqual(['prospect', 'salon-2026', 'vip']); // union, aucun doublon, rien perdu
    expect(lea.fields).toMatchObject({ ville: 'Nice' }); // le 3e import a bien mergé les fields

    // Filtre par tag (clic sur le nombre dans l'onglet Tags) : $4 = any(tags).
    const bySalon = await store.list(tenantId, 500, 0, 'salon-2026');
    expect(bySalon.some((r) => r.phoneE164 === phone)).toBe(true);
    const byVip = await store.list(tenantId, 500, 0, 'vip');
    expect(byVip.some((r) => r.phoneE164 === phone)).toBe(true);
    const byNone = await store.list(tenantId, 500, 0, 'tag-inexistant-xyz');
    expect(byNone.some((r) => r.phoneE164 === phone)).toBe(false);
  });

  it('PgContactStore.upsertFromInbound : crée par numéro OU BSUID, expose le bsuid, opt-in unknown (pas de consentement)', async () => {
    const store = new PgContactStore(pool);
    // wa_id de 11 chiffres -> numéro. 2e message = update (pas de recréation), nom rafraîchi.
    expect(await store.upsertFromInbound(tenantId, '33600000031', 'Inbound Phone')).toBe('created');
    expect(await store.upsertFromInbound(tenantId, '33600000031', 'Inbound Phone 2')).toBe('updated');
    // wa_id de 19 chiffres -> BSUID (contact sans numéro).
    const bsuid = '1234567890123456789';
    expect(await store.upsertFromInbound(tenantId, bsuid, 'Sans Numero')).toBe('created');

    const rows = await store.list(tenantId, 500);
    const byPhone = rows.find((r) => r.phoneE164 === '+33600000031')!;
    expect(byPhone.profileName).toBe('Inbound Phone 2'); // nom rafraîchi (coalesce)
    expect(byPhone.optInStatus).toBe('unknown'); // un message entrant N'est PAS un consentement
    expect(byPhone.bsuid).toBeNull();
    const byBsuid = rows.find((r) => r.bsuid === bsuid)!;
    expect(byBsuid).toBeTruthy();
    expect(byBsuid.phoneE164).toBeNull();
    expect(byBsuid.profileName).toBe('Sans Numero');
  });

  it('auth : createTenantWithAdmin (transaction) + createPending + setPassword + getAuthState(tenantStatus)', async () => {
    const users = new PgUserStore(pool);
    const email = `admin.itest.${Date.now()}@exemple.fr`;
    const { tenantId: newTenant, userId } = await users.createTenantWithAdmin('Espace itest', { email, name: 'Admin', passwordHash: 'scrypt$aa$bb' });
    try {
      // tenant + admin créés en base.
      const tRow = (await pool.query<{ status: string }>(`select status from tenants where id = $1`, [newTenant])).rows[0]!;
      expect(tRow.status).toBe('active'); // défaut du crochet paiement
      const state = await users.getAuthState(userId);
      expect(state).toMatchObject({ role: 'admin', disabled: false, tenantStatus: 'active' });
      // email GLOBALEMENT unique : réutiliser l'email -> DuplicateEmailError (et rollback : pas de tenant orphelin).
      const tenantsBefore = (await pool.query<{ n: string }>(`select count(*) n from tenants`)).rows[0]!.n;
      await expect(users.createTenantWithAdmin('Doublon', { email, name: null, passwordHash: null })).rejects.toBeInstanceOf(DuplicateEmailError);
      const tenantsAfter = (await pool.query<{ n: string }>(`select count(*) n from tenants`)).rows[0]!.n;
      expect(tenantsAfter).toBe(tenantsBefore); // rollback -> aucun tenant créé pour rien
      // createPending (invitation) : user sans mot de passe -> setPassword le finalise.
      const pending = await users.createPending(newTenant, `invite.itest.${Date.now()}@exemple.fr`, 'agent');
      expect(await users.setPassword(pending.id, 'scrypt$cc$dd')).toBe(true);
      const pw = (await pool.query<{ password_hash: string | null }>(`select password_hash from users where id = $1`, [pending.id])).rows[0]!;
      expect(pw.password_hash).toBe('scrypt$cc$dd');
    } finally {
      await pool.query('delete from tenants where id = $1', [newTenant]); // cascade users + auth_tokens
    }
  });

  it('PgAuthTokenStore : create renvoie le token en clair, consume valide/atomique/usage-unique/expiration', async () => {
    const users = new PgUserStore(pool);
    const tokens = new PgAuthTokenStore(pool);
    const { tenantId: newTenant, userId } = await users.createTenantWithAdmin('Espace tok', { email: `tok.itest.${Date.now()}@exemple.fr`, name: null, passwordHash: null });
    try {
      const raw = await tokens.create('reset', userId, 60_000);
      expect(typeof raw).toBe('string');
      // le token en clair n'est PAS en base (seul le hash).
      expect((await pool.query<{ n: string }>(`select count(*) n from auth_tokens where token_hash = $1`, [raw])).rows[0]!.n).toBe('0');
      // consume valide -> user_id ; 2e consume -> null (usage unique) ; mauvais purpose -> null.
      expect(await tokens.consume('invite', raw)).toBeNull(); // mauvais purpose
      expect(await tokens.consume('reset', raw)).toBe(userId);
      expect(await tokens.consume('reset', raw)).toBeNull(); // déjà utilisé
      // token expiré -> null.
      const expired = await tokens.create('reset', userId, -1000);
      expect(await tokens.consume('reset', expired)).toBeNull();
    } finally {
      await pool.query('delete from tenants where id = $1', [newTenant]);
    }
  });

  it('PgTemplateHintStore : save REMPLACE les indices, get les relit, removeByName purge', async () => {
    const store = new PgTemplateHintStore(pool);
    const name = 'promo_hints_itest';
    await store.save(tenantId, name, 'fr', [
      { position: 1, source: { type: 'field', key: 'prenom' } },
      { position: 2, source: { type: 'attribute', key: 'name' } },
    ]);
    let hints = await store.get(tenantId, name, 'fr');
    expect(hints).toEqual([
      { position: 1, source: { type: 'field', key: 'prenom' } },
      { position: 2, source: { type: 'attribute', key: 'name' } },
    ]);
    // save = REMPLACE (le corps du template a changé) : ne cumule pas.
    await store.save(tenantId, name, 'fr', [{ position: 1, source: { type: 'attribute', key: 'phone' } }]);
    hints = await store.get(tenantId, name, 'fr');
    expect(hints).toEqual([{ position: 1, source: { type: 'attribute', key: 'phone' } }]);
    // scope langue : une autre langue est indépendante.
    await store.save(tenantId, name, 'en', [{ position: 1, source: { type: 'field', key: 'city' } }]);
    expect(await store.get(tenantId, name, 'fr')).toHaveLength(1);
    // removeByName purge toutes les langues.
    await store.removeByName(tenantId, name);
    expect(await store.get(tenantId, name, 'fr')).toEqual([]);
    expect(await store.get(tenantId, name, 'en')).toEqual([]);
  });

  it('PgContactStore.markOptedIn : passe opted_out -> opted_in (source posée), gagne toujours ; no-op si inconnu', async () => {
    const store = new PgContactStore(pool);
    const phone = '+33600000081';
    // Contact explicitement DÉSINSCRIT : un consentement de flow doit l'écraser (décision produit).
    await pool.query(`insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_out')`, [tenantId, phone]);
    expect(await store.markOptedIn(tenantId, '33600000081', 'flow')).toBe(1);
    const row = (await pool.query<{ opt_in_status: string; opt_in_source: string }>(
      `select opt_in_status, opt_in_source from contacts where tenant_id = $1 and phone_e164 = $2`, [tenantId, phone],
    )).rows[0]!;
    expect(row.opt_in_status).toBe('opted_in'); // l'opt-out est écrasé
    expect(row.opt_in_source).toBe('flow');
    // Numéro inconnu -> aucune ligne touchée (merge-only).
    expect(await store.markOptedIn(tenantId, '33699999998', 'flow')).toBe(0);
  });

  it('PgFlowStore.findByRef : renvoie mapping + fieldTypes + optinFieldKeys (repère les champs OptIn)', async () => {
    const store = new PgFlowStore(pool);
    const ref = `ref-optin-itest-${Date.now()}`;
    const id = `flow-optin-itest-${Date.now()}`;
    const screens = [{ elements: [
      { kind: 'field' as const, label: "J'accepte", type: 'optin' as const, required: true, key: 'j_accepte' },
      { kind: 'field' as const, label: 'Ville', type: 'text' as const, required: false, key: 'ville' },
    ] }];
    try {
      await store.insert({ id, tenantId, name: 'ConsentFlow itest', screens, ref, mapping: { j_accepte: 'whatsapp_optin', ville: 'ville' } });
      const row = await store.findByRef(ref);
      expect(row).not.toBeNull();
      expect(row!.mapping).toMatchObject({ j_accepte: 'whatsapp_optin', ville: 'ville' });
      expect(row!.fieldTypes).toMatchObject({ j_accepte: 'optin', ville: 'text' });
      expect(row!.optinFieldKeys).toEqual(['j_accepte']); // seul le champ optin, pas 'ville'
      expect(await store.findByRef('ref-inexistant-xyz')).toBeNull();
    } finally {
      await pool.query('delete from flows where id = $1', [id]);
    }
  });

  it('PgContactStore.mergeFieldsByPhone / addTagsByPhone : atteignent un contact identifié par BSUID', async () => {
    const store = new PgContactStore(pool);
    const bsuid = '9876543210987654321';
    await pool.query(`insert into contacts (tenant_id, bsuid, opt_in_status) values ($1, $2, 'opted_in')`, [tenantId, bsuid]);
    expect(await store.mergeFieldsByPhone(tenantId, bsuid, { ville: 'Paris' })).toBe(1);
    expect(await store.addTagsByPhone(tenantId, bsuid, ['vip-bsuid'])).toBe(1);
    const row = (await store.list(tenantId, 500)).find((r) => r.bsuid === bsuid)!;
    expect(row.fields).toMatchObject({ ville: 'Paris' });
    expect(row.tags).toContain('vip-bsuid');
  });

  it('PgConversationStatsStore : agrégats + liste quali (Lot 9), scopés tenant', async () => {
    const { PgConversationStatsStore } = await import('../../src/stats/conversation-stats.pg');
    const store = new PgConversationStatsStore(pool, true);
    // Fenêtre large (hier..demain) : les lignes sont créées à now(), on évite tout effet de bord de fuseau.
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const range = { from: iso(new Date(Date.now() - 86_400_000)), to: iso(new Date(Date.now() + 86_400_000)) };
    const t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-conv-stats') returning id`)).rows[0]!.id;
    try {
      // Contact + 3 conversations analysées (2 aujourd'hui, sentiments/intents/actions varies) + 1 AUTRE tenant.
      const ct = (await pool.query<{ id: string }>(`insert into contacts (tenant_id, phone_e164, profile_name, opt_in_status) values ($1,'+33611111111','Alice','opted_in') returning id`, [t])).rows[0]!.id;
      const mkConv = async (wa: string) => (await pool.query<{ id: string }>(`insert into conversations (tenant_id, wa_id, contact_id, last_message_at) values ($1,$2,$3, now()) returning id`, [t, wa, ct])).rows[0]!.id;
      const cv1 = await mkConv('33611111111');
      const cv2 = await mkConv('33622222222');
      const insAna = (convId: string, sentiment: string, intent: string, resolved: boolean, handled: string, action: string, ex: number, conf: number, topic: string) =>
        pool.query(
          `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by, exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'test','anthropic','claude-haiku-4-5')`,
          [convId, t, sentiment, intent, topic, resolved, handled, ex, action, conf],
        );
      await insAna(cv1, 'positif', 'demande_devis', true, 'humain', 'creer_devis', 4, 0.92, 'Devis');
      await insAna(cv2, 'negatif', 'reclamation', false, 'automatise', 'escalader', 2, 0.6, ' devis ');

      const s = await store.getSummary(t, range);
      expect(s.enabled).toBe(true);
      expect(s.total).toBe(2);
      expect(s.sentiment).toEqual({ positif: 1, neutre: 0, negatif: 1 });
      expect(s.intent.demande_devis).toBe(1);
      expect(s.intent.reclamation).toBe(1);
      expect(s.resolution).toMatchObject({ resolved: 1, unresolved: 1 });
      expect(s.resolution.rate).toBeCloseTo(0.5);
      expect(s.handledBy).toMatchObject({ humain: 1, automatise: 1, mba: 0 });
      expect(s.actions).toMatchObject({ creer_devis: 1, escalader: 1 });
      expect(s.exchanges.avg).toBeCloseTo(3); // (4+2)/2
      expect(s.exchanges.median).toBeCloseTo(3); // median de [2,4]
      // topic regroupé par lower(btrim) : « Devis » et « devis » -> une seule clé 'devis' à 2.
      expect(s.topTopics).toEqual([{ topic: 'devis', count: 2 }]);
      expect(s.confidence).toMatchObject({ gte90: 1, from50to70: 1 });

      // Liste quali : filtre par sentiment, join contacts (profile_name), inboxHref.
      const list = await store.listAnalyzed(t, range, { sentiment: 'positif' });
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ conversationId: cv1, sentiment: 'positif', profileName: 'Alice', inboxHref: `/inbox?c=${cv1}` });

      // SCOPE TENANT : le tenant principal ne voit RIEN de ce jeu (aucune fuite).
      const other = await store.getSummary(tenantId, range);
      // (le tenant principal peut avoir d'autres analyses d'autres tests ; on verifie juste que nos 2 lignes n'y sont pas)
      const otherList = await store.listAnalyzed(tenantId, range, {});
      expect(otherList.some((r) => r.conversationId === cv1 || r.conversationId === cv2)).toBe(false);
      expect(other.total).toBeGreaterThanOrEqual(0);
    } finally {
      await pool.query('delete from tenants where id = $1', [t]);
    }
  });

  it('PgContactStore.query/count/idsForFilters : filtres composables (Lot 8), scopés tenant', async () => {
    const store = new PgContactStore(pool);
    // Tenant DÉDIÉ à ce test (jeu de données isolé, pas de collision avec les autres tests contacts).
    const t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-filters') returning id`)).rows[0]!.id;
    try {
      await store.upsertByPhone({ tenantId: t, phoneE164: '+33611000001', profileName: 'Alice Martin', fields: { ville: 'Lyon' }, optInStatus: 'opted_in', tags: ['vip', 'salon'] });
      await store.upsertByPhone({ tenantId: t, phoneE164: '+33622000002', profileName: 'Bob Durand', fields: { ville: 'Paris' }, optInStatus: 'opted_in', tags: ['vip'] });
      await store.upsertByPhone({ tenantId: t, phoneE164: '+33611000003', profileName: 'Chloé Petit', fields: { ville: 'Lyon' }, optInStatus: 'unknown', tags: ['salon'] });
      const names = async (f: Parameters<typeof store.query>[1]) => (await store.query(t, f, 500)).map((r) => r.profileName).sort();

      // tags AND (défaut) = contient TOUS ; OR = au moins un.
      expect(await names({ tags: ['vip', 'salon'] })).toEqual(['Alice Martin']);
      expect(await names({ tags: ['vip', 'salon'], tagMode: 'or' })).toEqual(['Alice Martin', 'Bob Durand', 'Chloé Petit']);
      // opt-in.
      expect(await names({ optIn: 'unknown' })).toEqual(['Chloé Petit']);
      // préfixe ancré (+33611...) et contenu de chiffres.
      expect(await names({ phonePrefix: '+33611' })).toEqual(['Alice Martin', 'Chloé Petit']);
      expect(await names({ phoneContains: '2200' })).toEqual(['Bob Durand']);
      // recherche nom (insensible casse) + valeur de champ perso (eq / contains).
      expect(await names({ nameSearch: 'martin' })).toEqual(['Alice Martin']);
      expect(await names({ fieldFilters: [{ key: 'ville', op: 'eq', value: 'Lyon' }] })).toEqual(['Alice Martin', 'Chloé Petit']);
      expect(await names({ fieldFilters: [{ key: 'ville', op: 'contains', value: 'ari' }] })).toEqual(['Bob Durand']);
      // combinaison : vip ET à Lyon.
      expect(await names({ tags: ['vip'], fieldFilters: [{ key: 'ville', op: 'eq', value: 'Lyon' }] })).toEqual(['Alice Martin']);

      // count == taille ; idsForFilters cohérent.
      expect(await store.count(t, { tags: ['vip'] })).toBe(2);
      expect(await store.count(t, {})).toBe(3); // aucun filtre = tous
      expect((await store.idsForFilters(t, { optIn: 'unknown' })).length).toBe(1);

      // SCOPE TENANT : les mêmes filtres sur un AUTRE tenant ne voient rien (anti-fuite).
      expect(await store.count(tenantId, { tags: ['vip', 'salon'], phonePrefix: '+33611000001' })).toBe(
        // le tenant principal peut avoir des contacts d'autres tests : on vérifie juste que le jeu d'itest-filters n'y fuit pas
        (await store.query(tenantId, { nameSearch: 'Alice Martin' }, 500)).length,
      );
      expect(await store.query(tenantId, { nameSearch: 'Alice Martin' }, 500)).toEqual([]);
    } finally {
      await pool.query('delete from tenants where id = $1', [t]);
    }
  });

  it('PgContactStore.applyEdits : MERGE fields + tags add/remove en transaction, scoping tenant', async () => {
    const store = new PgContactStore(pool);
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status, fields, tags)
       values ($1, $2, 'opted_in', '{"ville":"Lyon"}'::jsonb, array['vip']) returning id`,
      [tenantId, '+33600000010'],
    )).rows[0]!.id;

    // MERGE fields (garde ville, ajoute age) + addTags dédup (vip déjà là).
    const c1 = await store.applyEdits(tenantId, contactId, { fields: { age: '42' }, addTags: ['prospect', 'vip'], removeTags: [] });
    expect(c1!.fields).toMatchObject({ ville: 'Lyon', age: '42' });
    expect([...c1!.tags].sort()).toEqual(['prospect', 'vip']); // union dédup

    // removeTags : retire tous les tags -> '{}' (pas NULL) ; fields intacts.
    const c2 = await store.applyEdits(tenantId, contactId, { fields: {}, addTags: [], removeTags: ['vip', 'prospect'] });
    expect(c2!.tags).toEqual([]);
    expect(c2!.fields).toMatchObject({ ville: 'Lyon', age: '42' });

    // Contact inexistant -> null (=> 404 amont), aucune écriture.
    expect(await store.applyEdits(tenantId, '00000000-0000-0000-0000-000000000000', { fields: { age: '1' }, addTags: [], removeTags: [] })).toBeNull();

    // getById scopé tenant.
    expect(await store.getById(tenantId, contactId)).not.toBeNull();
    expect(await store.getById('00000000-0000-0000-0000-000000000000', contactId)).toBeNull();
  });

  it('PgUserFieldStore : upsert idempotent + list', async () => {
    const store = new PgUserFieldStore(pool);
    await store.upsert(tenantId, { key: 'ville', label: 'Ville', type: 'text' });
    await store.upsert(tenantId, { key: 'ville', label: 'AUTRE', type: 'text' }); // do nothing
    const list = await store.list(tenantId);
    const ville = list.filter((f) => f.key === 'ville');
    expect(ville).toHaveLength(1);
    expect(ville[0]?.label).toBe('Ville');
  });

  it('PgUserFieldStore.create : created puis exists (pas d’écrasement)', async () => {
    const store = new PgUserFieldStore(pool);
    expect(await store.create(tenantId, { key: 'newf', label: 'New', type: 'text' })).toBe('created');
    expect(await store.create(tenantId, { key: 'newf', label: 'Autre', type: 'number' })).toBe('exists');
    expect((await store.list(tenantId)).find((f) => f.key === 'newf')?.label).toBe('New'); // pas écrasé
  });

  it('PgTagStore : create idempotent, listDistinct union (déclaré 0 + utilisé), rename/remove transactionnels', async () => {
    const store = new PgTagStore(pool);
    expect(await store.create(tenantId, 'declared-only')).toBe(true);
    expect(await store.create(tenantId, 'declared-only')).toBe(false); // idempotent

    await pool.query(`insert into contacts (tenant_id, phone_e164, opt_in_status, tags) values ($1, $2, 'opted_in', array['used-only'])`, [tenantId, '+33600000020']);
    const before = new Map((await store.listDistinct(tenantId)).map((t) => [t.tag, t.count]));
    expect(before.get('declared-only')).toBe(0); // déclaré, non utilisé
    expect(before.get('used-only')).toBe(1); // utilisé

    expect(await store.rename(tenantId, 'used-only', 'renamed')).toBe(1);
    const after = new Map((await store.listDistinct(tenantId)).map((t) => [t.tag, t.count]));
    expect(after.has('used-only')).toBe(false);
    expect(after.get('renamed')).toBe(1);

    // rename d'un `from` inconnu -> ne déclare PAS 'ghost-to'.
    await store.rename(tenantId, 'inconnu-xyz', 'ghost-to');
    expect((await store.listDistinct(tenantId)).some((t) => t.tag === 'ghost-to')).toBe(false);

    // remove d'un tag déclaré -> disparaît de la table.
    await store.remove(tenantId, 'declared-only');
    expect((await store.listDistinct(tenantId)).some((t) => t.tag === 'declared-only')).toBe(false);
  });

  it('PgCampaignRepo : programmation (schedule/cancel/listDue/markScheduledRunning), gardes de statut', async () => {
    const repo = new PgCampaignRepo(pool);
    const cId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-sched', name: 'planif', category: 'marketing',
      templateName: 't', templateLanguage: 'fr', paramMapping: [], ratePerMinute: 10,
    });
    // 2 destinataires en attente (pour le dimensionnement du sweeper).
    const ct = (await pool.query<{ id: string }>(`insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1,$2,'opted_in') returning id`, [tenantId, '+33600000055'])).rows[0]!.id;
    await repo.insertRecipients(cId, [{ contactId: ct, toE164: '+33600000055', resolvedParams: ['X'] }]);

    // Programme dans le FUTUR -> pas dû.
    const future = new Date(Date.now() + 3_600_000);
    expect(await repo.scheduleCampaign(cId, tenantId, future)).toBe(true);
    expect((await repo.getCampaign(cId))?.status).toBe('scheduled');
    expect((await repo.listDueScheduled(new Date())).some((c) => c.id === cId)).toBe(false); // futur -> pas dû

    // Rendre l'échéance PASSÉE (rester 'scheduled') -> dû. scheduleCampaign ne re-programme pas une campagne
    // déjà 'scheduled' (garde draft/paused voulue), donc on pousse scheduled_at dans le passé directement.
    await pool.query(`update campaigns set scheduled_at = now() - interval '1 second' where id = $1`, [cId]);
    const due = (await repo.listDueScheduled(new Date())).find((c) => c.id === cId);
    expect(due).toMatchObject({ ratePerMinute: 10, pendingCount: 1 });

    // Claim du sweeper : scheduled -> running (une seule fois).
    expect(await repo.markScheduledRunning(cId)).toBe(true);
    expect(await repo.markScheduledRunning(cId)).toBe(false); // plus 'scheduled'
    expect((await repo.getCampaign(cId))?.status).toBe('running');

    // Annulation : seule une campagne 'scheduled' s'annule (running -> non).
    expect(await repo.cancelSchedule(cId, tenantId)).toBe(false); // running, pas scheduled
    await pool.query(`update campaigns set status='scheduled', scheduled_at=now() where id=$1`, [cId]);
    expect(await repo.cancelSchedule(cId, tenantId)).toBe(true);
    const back = await repo.getCampaign(cId);
    expect(back?.status).toBe('draft');

    // Scope tenant : un autre tenant ne programme/annule pas cette campagne.
    expect(await repo.scheduleCampaign(cId, '00000000-0000-0000-0000-000000000000', future)).toBe(false);
  });

  it('PgCampaignRepo + stores : insert, listPending, markResult, setStatus, lastSentAt', async () => {
    const repo = new PgCampaignRepo(pool);
    const recipients = new PgRecipientStore(pool);
    const campaignsStore = new PgCampaignStore(pool);
    const frequency = new PgFrequencyStore(pool);

    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`,
      [tenantId, '+33600000002'],
    )).rows[0]!.id;

    const campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-itest', name: 'c', category: 'marketing',
      templateName: 't', templateLanguage: 'fr', paramMapping: [],
    });
    const n = await repo.insertRecipients(campaignId, [{ contactId, toE164: '+33600000002', resolvedParams: ['X'] }]);
    expect(n).toBe(1);

    const pending = await recipients.listPending(campaignId);
    expect(pending).toHaveLength(1);
    const rid = pending[0]!.id;

    // Claim atomique : le 1er réserve (pending -> sending), le 2e échoue (déjà pris).
    expect(await recipients.claim(rid)).toBe(true);
    expect(await recipients.claim(rid)).toBe(false);
    expect(await recipients.listPending(campaignId)).toHaveLength(0); // 'sending' exclu

    const at = 1_700_000_000_000;
    await recipients.markResult(rid, { status: 'sent', messageId: 'm-1', sentAt: at });
    const rrow = (await pool.query<{ status: string; message_id: string; sent_at: Date }>(
      `select status, message_id, sent_at from campaign_recipients where id = $1`, [rid],
    )).rows[0]!;
    expect(rrow.status).toBe('sent');
    expect(rrow.message_id).toBe('m-1');
    expect(rrow.sent_at).not.toBeNull();

    await campaignsStore.setStatus(campaignId, 'completed');
    const status = (await pool.query<{ status: string }>(`select status from campaigns where id = $1`, [campaignId])).rows[0]!.status;
    expect(status).toBe('completed');

    // lastSentAt cross-campagne lit max(sent_at) du numéro.
    const last = await frequency.lastSentAt(tenantId, '+33600000002');
    expect(last).toBe(at);
    expect(await frequency.lastSentAt(tenantId, '+33699999999')).toBeNull();

    // Suivi de livraison (par message_id 'm-1'), monotone.
    expect(await recipients.updateDeliveryByMessageId('m-1', 'sent', null, null)).toBe(1);
    expect(await recipients.updateDeliveryByMessageId('m-1', 'read', null, null)).toBe(1);
    expect(await recipients.updateDeliveryByMessageId('m-1', 'delivered', null, null)).toBe(0); // read ne régresse pas
    const dstatus = (await pool.query<{ delivery_status: string }>(`select delivery_status from campaign_recipients where id = $1`, [rid])).rows[0]?.delivery_status;
    expect(dstatus).toBe('read');
    expect(await recipients.updateDeliveryByMessageId('m-inconnu', 'sent', null, null)).toBe(0); // wamid pas à nous

    // error_code : un 'failed' avec code le persiste (breakdown analytics).
    expect(await recipients.updateDeliveryByMessageId('m-1', 'failed', '131049 blocked', 131049)).toBe(1);
    const ec = (await pool.query<{ error_code: number | null }>(`select error_code from campaign_recipients where id = $1`, [rid])).rows[0]?.error_code;
    expect(ec).toBe(131049);
  });

  it('PgStatsStore : campaign funnel (répondu=inbound après envoi), error breakdown, cost volume', async () => {
    const repo = new PgCampaignRepo(pool);
    const recipients = new PgRecipientStore(pool);
    const stats = new PgStatsStore(pool);

    const mk = async (phone: string) => (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`, [tenantId, phone],
    )).rows[0]!.id;
    const [c1, c2, c3] = [await mk('+33600000050'), await mk('+33600000051'), await mk('+33600000052')];
    const { campaignId } = await repo.createWithRecipients(
      { tenantId, phoneNumberId: 'pn-st', name: 'Funnel', category: 'marketing', templateName: 'te', templateLanguage: 'fr', paramMapping: [] },
      [
        { contactId: c1, toE164: '+33600000050', resolvedParams: [] },
        { contactId: c2, toE164: '+33600000051', resolvedParams: [] },
        { contactId: c3, toE164: '+33600000052', resolvedParams: [] },
      ],
    );
    const byPhone = new Map((await recipients.listPending(campaignId)).map((p) => [p.toE164, p.id]));
    const r1 = byPhone.get('+33600000050')!, r2 = byPhone.get('+33600000051')!, r3 = byPhone.get('+33600000052')!;
    const at = Date.now() - 5000;

    // r1 envoyé + lu + répond ; r2 envoyé + délivré ; r3 échec d'envoi (code 131026).
    await recipients.claim(r1); await recipients.markResult(r1, { status: 'sent', messageId: 'ms-1', sentAt: at });
    await recipients.claim(r2); await recipients.markResult(r2, { status: 'sent', messageId: 'ms-2', sentAt: at });
    await recipients.claim(r3); await recipients.markResult(r3, { status: 'failed', error: '131026 x', errorCode: 131026 });
    await recipients.updateDeliveryByMessageId('ms-1', 'read', null, null);
    await recipients.updateDeliveryByMessageId('ms-2', 'delivered', null, null);

    // r1 répond : conversation + message ENTRANT après l'envoi (created_at defaut now() > at).
    const convId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, '33600000050') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'oui')`, [convId]);

    const funnel = await stats.getCampaignFunnel(tenantId, campaignId);
    expect(funnel).toEqual({ sent: 2, delivered: 2, read: 1, replied: 1, failed: 1 });

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
    const range = { from: today, to: today };
    const errors = await stats.getErrorBreakdown(tenantId, range);
    expect(errors.find((e) => e.code === 131026)?.count).toBe(1);

    const vol = await stats.getCostVolume(tenantId, range, {});
    expect(vol.find((v) => v.category === 'marketing' && v.date === today)?.count).toBe(2); // r1 + r2 (r3 échec exclu)
    // Filtre par template inexistant -> aucun volume.
    expect(await stats.getCostVolume(tenantId, range, { templateName: 'inconnu' })).toHaveLength(0);
  });

  it('getCampaignFunnel : une réponse est attribuée à la DERNIÈRE campagne (pas de double-comptage)', async () => {
    const repo = new PgCampaignRepo(pool);
    const recipients = new PgRecipientStore(pool);
    const stats = new PgStatsStore(pool);
    const phone = '+33600000060';
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`, [tenantId, phone],
    )).rows[0]!.id;
    const mkCampaign = async (name: string, sentAt: number): Promise<string> => {
      const { campaignId } = await repo.createWithRecipients(
        { tenantId, phoneNumberId: 'pn-a', name, category: 'marketing', templateName: 'tt', templateLanguage: 'fr', paramMapping: [] },
        [{ contactId, toE164: phone, resolvedParams: [] }],
      );
      const rid = (await recipients.listPending(campaignId))[0]!.id;
      await recipients.claim(rid);
      await recipients.markResult(rid, { status: 'sent', messageId: `mm-${name}`, sentAt });
      return campaignId;
    };
    const base = Date.now() - 20_000;
    const campA = await mkCampaign('A', base);
    const campB = await mkCampaign('B', base + 5_000); // envoi ultérieur au MÊME numéro
    // Réponse APRÈS les deux envois -> attribuée à B (le dernier envoi avant la réponse), pas à A.
    const convId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, '33600000060') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'oui')`, [convId]);

    expect((await stats.getCampaignFunnel(tenantId, campA)).replied).toBe(0); // volée par B
    expect((await stats.getCampaignFunnel(tenantId, campB)).replied).toBe(1);
  });

  it('PgOpsStore : rollup cross-tenant (le tenant de test apparaît, agrégats cohérents) + queue load', async () => {
    const ops = new PgOpsStore(pool, 'pgboss');
    const overview = await ops.getTenantOverview();
    const mine = overview.find((t) => t.id === tenantId);
    expect(mine).toBeDefined();
    // Les tests précédents ont créé contacts + campagnes + envois pour CE tenant.
    expect(mine!.contacts).toBeGreaterThan(0);
    expect(mine!.templatesUsed).toBeGreaterThan(0);
    expect(typeof mine!.mbaEnabled).toBe('boolean');

    const daily = await ops.getGlobalDaily(14);
    expect(Array.isArray(daily)).toBe(true);

    // Queue load : tolère l'absence de pg-boss, sinon renvoie les 4 files avec des compteurs >= 0.
    const queues = await ops.getQueueLoad();
    expect(queues.map((q) => q.queue)).toEqual(['webhook', 'campaign-run', 'webhook-dlq', 'campaign-run-dlq']);
    for (const q of queues) {
      expect(q.backlog).toBeGreaterThanOrEqual(0);
      expect(q.active).toBeGreaterThanOrEqual(0);
      expect(q.failed).toBeGreaterThanOrEqual(0);
    }
  });

  it('PgWorkflowStore : insert/list/getById/update (graphe jsonb round-trip)/remove', async () => {
    const store = new PgWorkflowStore(pool);
    const graph = {
      nodes: [
        { id: 'n1', type: 'tag' as const, position: { x: 0, y: 0 }, data: { tag: 'vip' } },
        { id: 'n2', type: 'template' as const, position: { x: 200, y: 0 }, data: { templateName: 'promo' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const { id } = await store.insert(tenantId, 'Onboarding', graph);
    expect(id).toBeTruthy();

    const list = await store.list(tenantId);
    const mine = list.find((w) => w.id === id);
    expect(mine).toBeDefined();
    expect(mine!.name).toBe('Onboarding');
    expect(mine!.graph).toEqual(graph); // round-trip jsonb intact

    const one = await store.getById(id, tenantId);
    expect(one!.graph.nodes).toHaveLength(2);

    // update partiel : seul le nom change, le graphe est préservé (coalesce).
    expect(await store.update(id, tenantId, { name: 'Onboarding v2' })).toBe(true);
    const afterName = await store.getById(id, tenantId);
    expect(afterName!.name).toBe('Onboarding v2');
    expect(afterName!.graph).toEqual(graph); // graphe non écrasé

    // update du graphe.
    const g2 = { nodes: [{ id: 'n1', type: 'inbox' as const, position: { x: 5, y: 5 }, data: {} }], edges: [] };
    expect(await store.update(id, tenantId, { graph: g2 })).toBe(true);
    expect((await store.getById(id, tenantId))!.graph).toEqual(g2);

    // scope tenant : un autre tenant ne peut ni voir ni supprimer.
    expect(await store.getById(id, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await store.remove(id, '00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(await store.remove(id, tenantId)).toBe(true);
    expect(await store.getById(id, tenantId)).toBeNull();
  });

  it('PgCampaignRepo : campagne WORKFLOW (workflow_id + template null) round-trip', async () => {
    const repo = new PgCampaignRepo(pool);
    const wfStore = new PgWorkflowStore(pool);
    const { id: wfId } = await wfStore.insert(tenantId, 'WF campagne', { nodes: [], edges: [] });
    // Chemin RÉEL de création (via createWithRecipients, pas insertCampaign) : il DOIT persister workflow_id.
    const { campaignId: campId } = await repo.createWithRecipients({
      tenantId, phoneNumberId: 'pn-wf', name: 'Camp WF', category: 'marketing',
      templateName: '', templateLanguage: '', paramMapping: [], workflowId: wfId,
    }, []);
    const camp = await repo.getCampaign(campId);
    expect(camp).toMatchObject({ workflowId: wfId, templateName: '', templateLanguage: '', category: 'marketing' });
    // template_name est bien NULL en base (pas '').
    const row = (await pool.query<{ template_name: string | null }>(`select template_name from campaigns where id = $1`, [campId])).rows[0]!;
    expect(row.template_name).toBeNull();
  });

  it('WorkflowExecutor (E2E DB) : start pose le tag + persiste le run ; reply -> inbox', async () => {
    const wfStore = new PgWorkflowStore(pool);
    const runStore = new PgWorkflowRunStore(pool);
    const contactStore = new PgContactStore(pool);
    const phone = '+33600000070';
    const waId = '33600000070';
    await pool.query(`insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in')`, [tenantId, phone]);

    // tag(atelier) -> template(promo) -> inbox
    const graph = {
      nodes: [
        { id: 't', type: 'tag' as const, position: { x: 0, y: 0 }, data: { tag: 'atelier' } },
        { id: 'tpl', type: 'template' as const, position: { x: 0, y: 0 }, data: { templateName: 'promo', language: 'fr' } },
        { id: 'ib', type: 'inbox' as const, position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [{ id: 'e1', source: 't', target: 'tpl' }, { id: 'e2', source: 'tpl', target: 'ib' }],
    };
    const { id: wfId } = await wfStore.insert(tenantId, 'Atelier', graph);

    const sends: string[] = [];
    const ex = new WorkflowExecutor({
      runs: runStore,
      getGraph: async (id, t) => (await wfStore.getById(id, t))?.graph ?? null,
      applyTag: (t, w, tag) => contactStore.addTagsByPhone(t, w, [tag]).then(() => undefined),
      setField: (t, w, k, v) => contactStore.mergeFieldsByPhone(t, w, { [k]: v }).then(() => undefined),
      sendTemplate: async (_t, _w, name) => { sends.push(name); },
      sendQuickMessage: async (_t, _w, body) => { sends.push(`qm:${body}`); },
      sendFlow: async (_t, _w, flowId) => { sends.push(`flow:${flowId}`); },
    });

    await ex.start(tenantId, wfId, graph, { waId, contactId: null });
    // tag posé sur le VRAI contact + template envoyé + run en attente au template.
    const tagsRow = (await pool.query<{ tags: string[] }>(`select tags from contacts where tenant_id = $1 and phone_e164 = $2`, [tenantId, phone])).rows[0]!;
    expect(tagsRow.tags).toContain('atelier');
    expect(sends).toEqual(['promo']);
    const waiting = await runStore.findWaitingByWaId(tenantId, waId);
    expect(waiting).toMatchObject({ status: 'waiting', currentNode: 'tpl', workflowId: wfId });

    // le contact répond -> avance jusqu'à inbox (terminal).
    await ex.advance(tenantId, waId, 'wamid.1');
    expect(await runStore.findWaitingByWaId(tenantId, waId)).toBeNull(); // plus en attente
    const st = (await pool.query<{ status: string }>(`select status from workflow_runs where workflow_id = $1`, [wfId])).rows[0]!;
    expect(st.status).toBe('inbox');
    expect(sends).toEqual(['promo']); // pas de nouvel envoi
  });

  it('PgQualityProvider : UNKNOWN si numéro absent, lit le rating sinon', async () => {
    const quality = new PgQualityProvider(pool);
    expect(await quality.getRating('pn-absent')).toBe('UNKNOWN');

    await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'w')`, ['waba-itest', tenantId]);
    await pool.query(
      `insert into phone_numbers (id, waba_id, tenant_id, quality_rating) values ($1, 'waba-itest', $2, 'RED')`,
      ['pn-red', tenantId],
    );
    expect(await quality.getRating('pn-red')).toBe('RED');
  });

  it('reclaimStale : un `sending` trop vieux est ramené à `pending`', async () => {
    const repo = new PgCampaignRepo(pool);
    const recipients = new PgRecipientStore(pool);
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`,
      [tenantId, '+33600000004'],
    )).rows[0]!.id;
    const { campaignId } = await repo.createWithRecipients(
      { tenantId, phoneNumberId: 'pn', name: 'Sweep', category: 'marketing', templateName: 't', templateLanguage: 'fr', paramMapping: [] },
      [{ contactId, toE164: '+33600000004', resolvedParams: [] }],
    );
    const rid = (await recipients.listPending(campaignId))[0]!.id;
    expect(await recipients.claim(rid)).toBe(true); // pending -> sending (claimed_at=now)
    expect(await recipients.reclaimStale(60_000)).toBe(0); // pas vieux de 60s
    // Vieillir CE claim d'1h, puis récupérer (n'affecte pas les sending récents d'ailleurs).
    await pool.query(`update campaign_recipients set claimed_at = now() - interval '1 hour' where id = $1`, [rid]);
    expect(await recipients.reclaimStale(60_000)).toBeGreaterThanOrEqual(1);
    expect(await recipients.listPending(campaignId)).toHaveLength(1); // de retour pending
  });

  it('createWithRecipients : rollback si un destinataire échoue (pas de campagne orpheline)', async () => {
    const repo = new PgCampaignRepo(pool);
    const before = (await repo.listCampaignSummaries(tenantId)).length;
    await expect(
      repo.createWithRecipients(
        { tenantId, phoneNumberId: 'pn', name: 'RollbackTest', category: 'marketing', templateName: 't', templateLanguage: 'fr', paramMapping: [] },
        [{ contactId: '00000000-0000-0000-0000-000000000000', toE164: '+33600000005', resolvedParams: [] }], // FK contact inexistant
      ),
    ).rejects.toThrow();
    expect((await repo.listCampaignSummaries(tenantId)).length).toBe(before); // aucune campagne persistée
  });
});
