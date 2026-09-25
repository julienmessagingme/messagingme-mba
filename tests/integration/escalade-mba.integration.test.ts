import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * L'ESCALADE DE L'AGENT DE META, CONTRE UNE VRAIE BASE (migration 0164, lot 2 du plan
 * docs/superpowers/plans/2026-09-23-liste-julien.md).
 *
 * 🔴 POURQUOI EN INTÉGRATION : tout se joue dans du SQL. Le prédicat « À traiter » (`A_TRAITER_SQL`), l'upsert qui
 * crée la conversation si la passation arrive avant l'écho, les effacements (réponse humaine, « Traité », fil
 * rendu à l'agent) et la garde du `standby` retardataire. Un faux magasin dirait ce qu'on lui fait dire.
 */
describe.skipIf(!url)('PgInboxStore : l’escalade de l’agent de Meta (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let store: PgInboxStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-escalade-mba') returning id`,
    )).rows[0]!.id;
    store = new PgInboxStore(pool);
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const lire = async (waId: string) => (await pool.query<{
    id: string; control_owner: string; escaladee_le: Date | null; traitee_le: Date | null; archived_at: Date | null;
  }>(`select id, control_owner, escaladee_le, traitee_le, archived_at from conversations where tenant_id = $1 and wa_id = $2`,
    [tenantId, waId])).rows[0];

  /** Une conversation dont la DERNIÈRE phrase est celle de l'agent de Meta (sortante), comme à une passation. */
  async function conversationMenéeParLAgent(waId: string): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, control_owner, last_message_at, last_direction)
       values ($1, $2, 'mba', now(), 'out') returning id`,
      [tenantId, waId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'out', 'mba', 'Un membre de l’équipe va vous répondre')`,
      [id],
    );
    return id;
  }

  it('🔴 la passation fait entrer TOUT DE SUITE dans « À traiter », alors que la dernière phrase est sortante', async () => {
    const waId = '33600000201';
    await conversationMenéeParLAgent(waId);
    const avant = await store.listConversations(tenantId, { aTraiter: true });
    expect(avant.some((c) => c.waId === waId)).toBe(false); // l'ancien comportement : invisible
    await store.marquerEscalade(tenantId, waId);
    const c = await lire(waId);
    expect(c?.control_owner).toBe('app_human');
    expect(c?.escaladee_le).not.toBeNull();
    const apres = await store.listConversations(tenantId, { aTraiter: true });
    expect(apres.some((x) => x.waId === waId)).toBe(true);
  });

  it('🔴 la passation CRÉE la conversation si elle arrive avant l’écho de l’agent', async () => {
    const waId = '33600000202';
    expect(await lire(waId)).toBeUndefined();
    await store.marquerEscalade(tenantId, waId);
    expect((await lire(waId))?.control_owner).toBe('app_human');
  });

  it('la passation sort la conversation d’« Archivées » et de « Traité » : quelqu’un attend une réponse', async () => {
    const waId = '33600000203';
    const id = await conversationMenéeParLAgent(waId);
    await pool.query(`update conversations set archived_at = now(), traitee_le = now() where id = $1`, [id]);
    await store.marquerEscalade(tenantId, waId);
    const c = await lire(waId);
    expect(c?.archived_at).toBeNull();
    expect(c?.traitee_le).toBeNull();
  });

  it('🔴 la première réponse d’un OPÉRATEUR efface l’escalade ; celle d’un automate, non', async () => {
    const waId = '33600000204';
    const id = await conversationMenéeParLAgent(waId);
    await store.marquerEscalade(tenantId, waId);
    await store.recordOutbound(id, 'relance auto', null, 'scenario');
    expect((await lire(waId))?.escaladee_le).not.toBeNull();
    await store.recordOutbound(id, 'Bonjour, je regarde ça', null, 'humain');
    expect((await lire(waId))?.escaladee_le).toBeNull();
  });

  it('« Traité » efface l’escalade ; ARCHIVER aussi', async () => {
    const a = '33600000205';
    const idA = await conversationMenéeParLAgent(a);
    await store.marquerEscalade(tenantId, a);
    await store.marquerTraitee(tenantId, idA, true);
    expect((await lire(a))?.escaladee_le).toBeNull();

    // 🔴 ARCHIVER LA CLÔT AUSSI (revue finale du 2026-09-23) : sans ça, la conversation quitte la liste et plus
    // rien ne rend jamais le fil à l'agent (le balayage saute les escalades), donc il reste à l'équipe pour
    // toujours.
    const b = '33600000206';
    const idB = await conversationMenéeParLAgent(b);
    await store.marquerEscalade(tenantId, b);
    expect(await store.archiverConversation(tenantId, idB, true)).toBe(true);
    expect((await lire(b))?.escaladee_le).toBeNull();
  });

  it('🔴 la fin d’un parcours ne clôt PAS l’escalade ; le geste « Rendre la main », si', async () => {
    // Elle s'effaçait dès qu'une écriture posait `mba`, donc aussi quand un parcours finissait : la conversation
    // sortait d'« À traiter » sans que personne ait répondu, ce que l'arbitrage de Julien interdit.
    const waId = '33600000212';
    await conversationMenéeParLAgent(waId);
    await store.marquerEscalade(tenantId, waId);
    expect(await store.setControlOwner(tenantId, waId, 'mba')).toBe(true);
    expect((await lire(waId))?.escaladee_le).not.toBeNull();
    await store.setControlOwner(tenantId, waId, 'app_human');
    expect(await store.setControlOwner(tenantId, waId, 'mba', { effacerEscalade: true })).toBe(true);
    expect((await lire(waId))?.escaladee_le).toBeNull();
  });

  it('🔴 un `standby` POSTÉRIEUR à l’escalade rend le fil : c’est la preuve que l’agent l’a repris', async () => {
    // Sans cette porte, l'escalade ne se levait que par un geste humain, donc éventuellement jamais. Meta ne nous
    // envoie un `standby` que lorsqu'une AUTRE app tient le fil.
    const waId = '33600000210';
    await conversationMenéeParLAgent(waId);
    await store.marquerEscalade(tenantId, waId);
    const escalade = (await lire(waId))!.escaladee_le!;
    const avant = new Date(escalade.getTime() - 60_000);
    const apres = new Date(escalade.getTime() + 60_000);
    // Le retardataire, daté d'AVANT la passation : écarté.
    expect(await store.setControlOwner(tenantId, waId, 'mba', { saufEscalade: true, messageEnvoyeLe: avant })).toBe(false);
    expect((await lire(waId))?.control_owner).toBe('app_human');
    // Celui d'APRÈS : il écrit pour de bon, le fil repart à l'agent.
    expect(await store.setControlOwner(tenantId, waId, 'mba', { saufEscalade: true, messageEnvoyeLe: apres })).toBe(true);
    expect((await lire(waId))?.control_owner).toBe('mba');
    // ⚠️ L'escalade, elle, RESTE posée : personne n'a répondu, la conversation reste « À traiter ».
    expect((await lire(waId))?.escaladee_le).not.toBeNull();
  });

  it('🔴 l’effacement ne dépend PAS de la valeur écrite : le bouton « Rendre la main » pose souvent `app_workflow`', async () => {
    // Trois de ses quatre branches écrivent `app_workflow` (Meta tient déjà le fil, espace sans agent, aucun
    // numéro) : la conversation quittait « À traiter » avec son drapeau intact, donc un piège armé pour le jour
    // où elle redeviendrait `app_human` (revue finale du 2026-09-23).
    const waId = '33600000214';
    await conversationMenéeParLAgent(waId);
    await store.marquerEscalade(tenantId, waId);
    expect(await store.setControlOwner(tenantId, waId, 'app_workflow', { effacerEscalade: true })).toBe(true);
    expect((await lire(waId))?.escaladee_le).toBeNull();
  });

  it('🔴 le lot du balayage ne se remplit plus d’escalades : elles sortent en SQL', async () => {
    const waId = '33600000213';
    await conversationMenéeParLAgent(waId);
    await store.marquerEscalade(tenantId, waId);
    const tenus = await store.listHeldControl(5000);
    expect(tenus.some((c) => c.tenantId === tenantId && c.waId === waId)).toBe(false);
  });

  it('🔴 un `standby` retardataire ne rend PAS une conversation escaladée à l’agent', async () => {
    const waId = '33600000207';
    await conversationMenéeParLAgent(waId);
    await store.marquerEscalade(tenantId, waId);
    expect(await store.setControlOwner(tenantId, waId, 'mba', { saufEscalade: true })).toBe(false);
    expect((await lire(waId))?.control_owner).toBe('app_human');
    // Sans escalade, le `standby` écrit comme avant.
    const autre = '33600000208';
    await pool.query(`insert into conversations (tenant_id, wa_id, control_owner) values ($1, $2, 'app_human')`, [tenantId, autre]);
    expect(await store.setControlOwner(tenantId, autre, 'mba', { saufEscalade: true })).toBe(true);
  });

  it('🔴 un SCÉNARIO ou un AGENT IA qui passe la main pose la même escalade (arbitrage du 2026-09-23)', async () => {
    // Leur dernière phrase est sortante elle aussi : sans le drapeau, la conversation n'entrait dans « À traiter »
    // qu'au message suivant du client, et le balayage rendait le fil à l'agent au bout de 2 h sans réponse.
    const waId = '33600000215';
    const id = await conversationMenéeParLAgent(waId);
    await pool.query(`update conversations set control_owner = 'app_workflow', archived_at = now(), traitee_le = now() where id = $1`, [id]);
    expect(await store.setControlOwner(tenantId, waId, 'app_human', { only: ['app_workflow'], escalade: true })).toBe(true);
    const c = await lire(waId);
    expect(c?.escaladee_le).not.toBeNull();
    expect(c?.archived_at).toBeNull();
    expect(c?.traitee_le).toBeNull();
    expect((await store.listConversations(tenantId, { aTraiter: true })).some((x) => x.waId === waId)).toBe(true);
    // ⚠️ Si quelqu'un tenait déjà le fil, il n'y a pas d'escalade à poser : la garde `only` refuse, et le
    // booléen rendu le dit à l'appelant (l'agent IA s'en sert pour savoir s'il peut écrire une dernière phrase).
    const autre = '33600000216';
    await pool.query(`insert into conversations (tenant_id, wa_id, control_owner) values ($1, $2, 'app_human')`, [tenantId, autre]);
    expect(await store.setControlOwner(tenantId, autre, 'app_human', { only: ['app_workflow'], escalade: true })).toBe(false);
    expect((await lire(autre))?.escaladee_le).toBeNull();
  });

  it('le balayage lit le drapeau d’escalade, et un fil ordinaire le porte à `false`', async () => {
    const waId = '33600000209';
    await pool.query(`insert into conversations (tenant_id, wa_id, control_owner, control_changed_at) values ($1, $2, 'app_human', now())`, [tenantId, waId]);
    const tenus = await store.listHeldControl(5000);
    expect(tenus.find((c) => c.tenantId === tenantId && c.waId === waId)?.escaladee).toBe(false);
  });
});
